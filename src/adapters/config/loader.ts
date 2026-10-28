// Config loader: reads the injected environment object and validates it
// against the typed schema in docs/infrastructure.md (I-08, K-505, K-510).
// The loader lives outside the pure domain in the adapter layer. It takes
// the environment as an injected plain object, so tests never touch the
// ambient runtime environment. It performs no I/O: no ambient variable
// lookup, no filesystem reads, no network calls. Startup errors name the
// variable with values kept outside the error text (threat-model M-11).
import {
  Address,
  ChainId,
  IndexVersion,
  ModelId,
  ModelVersion,
  PromptVersion,
} from "../../domain/types.ts";
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import type { DomainError } from "../../domain/types.ts";
import {
  SecretString,
} from "../../ports/config.ts";
import type {
  AppConfig,
  AssessmentProvider,
  ConfigError,
  EnvironmentName,
  LogLevel,
} from "../../ports/config.ts";

// Injected environment: a plain object mapping names to raw values.
export type EnvInput = Readonly<Record<string, string | undefined>>;

function missing(name: string): ConfigError {
  return { kind: "missing-variable", variable: name };
}

function invalid(name: string, reason: string): ConfigError {
  return { kind: "invalid-value", variable: name, reason };
}

// Empty string counts as absent: an unset secret and an empty secret both
// fail as missing, so the value shape never reaches an error message.
function rawValue(env: EnvInput, name: string): string | undefined {
  const value = env[name];
  if (value === undefined || value === "") {
    return undefined;
  }
  return value;
}

function requiredField<T>(
  env: EnvInput,
  name: string,
  parse: (raw: string) => Result<T, ConfigError>,
): Result<T, ConfigError> {
  const raw = rawValue(env, name);
  if (raw === undefined) {
    return err(missing(name));
  }
  return parse(raw);
}

function optionalField<T>(
  env: EnvInput,
  name: string,
  parse: (raw: string) => Result<T, ConfigError>,
): Result<T | undefined, ConfigError> {
  const raw = rawValue(env, name);
  if (raw === undefined) {
    return ok(undefined);
  }
  return parse(raw);
}

function requiredWhen<T>(
  env: EnvInput,
  name: string,
  required: boolean,
  parse: (raw: string) => Result<T, ConfigError>,
): Result<T | undefined, ConfigError> {
  return required ? requiredField(env, name, parse) : optionalField(env, name, parse);
}

function mapDomain<T>(name: string, reason: string, parsed: Result<T, DomainError>): Result<T, ConfigError> {
  if (parsed.ok) {
    return ok(parsed.value);
  }
  return err(invalid(name, reason));
}

// Chain ids are constrained to Ethereum mainnet (S-091, K-001): the
// declared return type keeps the parse callback single-expression, so
// the requiredWhen inference stays exact.
function mapChainId(parsed: Result<number, ConfigError>): Result<ChainId, ConfigError> {
  if (!parsed.ok) {
    return parsed;
  }
  if (parsed.value !== 1) {
    return err(invalid(V.chainId, "must be 1 (Ethereum mainnet only)"));
  }
  return mapDomain(V.chainId, "must be a positive integer", ChainId.of(parsed.value));
}

function parseEnum<T extends string>(
  name: string,
  allowed: readonly T[],
  describe: string,
): (raw: string) => Result<T, ConfigError> {
  return (raw: string) => {
    for (const candidate of allowed) {
      if (raw === candidate) {
        return ok(candidate);
      }
    }
    return err(invalid(name, `must be one of ${describe}`));
  };
}

function parseInteger(
  name: string,
  raw: string,
  min: number,
  max: number,
): Result<number, ConfigError> {
  if (!/^-?\d+$/.test(raw)) {
    return err(invalid(name, `must be an integer in [${min}, ${max}]`));
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return err(invalid(name, `must be an integer in [${min}, ${max}]`));
  }
  return ok(value);
}

function parsePositiveAmount(name: string, raw: string): Result<number, ConfigError> {
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    return err(invalid(name, "must be a positive amount"));
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1000000000000) {
    return err(invalid(name, "must be a positive amount"));
  }
  return ok(value);
}

function parseHttpsUrl(name: string, raw: string): Result<string, ConfigError> {
  if (!raw.startsWith("https://") || raw.length > 2048 || raw.includes(" ")) {
    return err(invalid(name, "must be an https URL"));
  }
  return ok(raw);
}

function parseSecret(name: string, raw: string): Result<SecretString, ConfigError> {
  if (raw.length === 0 || raw.length > 4096) {
    return err(invalid(name, "must be a non-empty secret value"));
  }
  return ok(new SecretString(raw));
}

function parseRpcUrls(name: string, raw: string): Result<readonly SecretString[], ConfigError> {
  const parts = raw.split(",");
  const urls: SecretString[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    const parsed = parseHttpsUrl(name, trimmed);
    if (!parsed.ok) {
      return parsed;
    }
    urls.push(new SecretString(parsed.value));
  }
  if (urls.length === 0) {
    return err(invalid(name, "must be a non-empty list of https URLs"));
  }
  return ok(urls);
}

function parseArtifactPath(name: string, raw: string): Result<string, ConfigError> {
  if (raw.length === 0 || raw.length > 1024 || raw.startsWith("/") || !raw.endsWith(".json")) {
    return err(invalid(name, "must be a relative path to a .json artifact file"));
  }
  return ok(raw);
}

function parseNonEmpty(name: string, raw: string, describe: string): Result<string, ConfigError> {
  if (raw.length === 0 || raw.length > 1024) {
    return err(invalid(name, `must be ${describe}`));
  }
  return ok(raw);
}

// Comma-separated API keys for the REST API (K-024, K-510, M-10). Each
// entry becomes a SecretString, so raw key values never sit in plain
// strings past this parse. Empty entries are skipped; a value with no
// usable key is turned away.
function parseApiKeys(name: string, raw: string): Result<readonly SecretString[], ConfigError> {
  const keys: SecretString[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (trimmed.length > 4096) {
      return err(invalid(name, "must be API keys of at most 4096 characters"));
    }
    keys.push(new SecretString(trimmed));
  }
  if (keys.length === 0) {
    return err(invalid(name, "must be a non-empty comma-separated list of API keys"));
  }
  return ok(keys);
}

function parseAlarmLevels(name: string, raw: string): Result<readonly number[], ConfigError> {
  const parts = raw.split(",");
  const levels: number[] = [];
  for (const part of parts) {
    const parsed = parseInteger(name, part.trim(), 1, 100);
    if (!parsed.ok) {
      return err(invalid(name, "must be a comma-separated list of percents in [1, 100]"));
    }
    levels.push(parsed.value);
  }
  if (levels.length === 0) {
    return err(invalid(name, "must be a comma-separated list of percents in [1, 100]"));
  }
  return ok(levels);
}

// Every variable name from the I-08 table, kept in one place so the schema
// and .env.example stay aligned.
const V = {
  environment: "BRANDKLIPPAREN_ENV",
  httpPort: "BRANDKLIPPAREN_HTTP_PORT",
  rpcUrls: "BRANDKLIPPAREN_RPC_URLS",
  chainId: "BRANDKLIPPAREN_CHAIN_ID",
  modelVersion: "BRANDKLIPPAREN_MODEL_VERSION",
  modelArtifactPath: "BRANDKLIPPAREN_MODEL_ARTIFACT_PATH",
  cloneIndexVersion: "BRANDKLIPPAREN_CLONE_INDEX_VERSION",
  extdecompDeadlineMs: "BRANDKLIPPAREN_extdecomp_DEADLINE_MS",
  extdecompMaxMemoryMb: "BRANDKLIPPAREN_extdecomp_MAX_MEMORY_MB",
  extdecompMaxOutputBytes: "BRANDKLIPPAREN_extdecomp_MAX_OUTPUT_BYTES",
  extdecompMaxConcurrency: "BRANDKLIPPAREN_extdecomp_MAX_CONCURRENCY",
  extdecompBinaryPath: "BRANDKLIPPAREN_extdecomp_BINARY_PATH",
  rpcDeadlineMs: "BRANDKLIPPAREN_RPC_DEADLINE_MS",
  rpcMaxConcurrency: "BRANDKLIPPAREN_RPC_MAX_CONCURRENCY",
  rpcRetryBudget: "BRANDKLIPPAREN_RPC_RETRY_BUDGET",
  rpcMaxResponseBytes: "BRANDKLIPPAREN_RPC_MAX_RESPONSE_BYTES",
  proxyMaxDepth: "BRANDKLIPPAREN_PROXY_MAX_DEPTH",
  assessmentDeadlineMs: "BRANDKLIPPAREN_ASSESSMENT_DEADLINE_MS",
  assessmentMaxInputBytes: "BRANDKLIPPAREN_ASSESSMENT_MAX_INPUT_BYTES",
  assessmentMaxOutputBytes: "BRANDKLIPPAREN_ASSESSMENT_MAX_OUTPUT_BYTES",
  assessmentMaxConcurrency: "BRANDKLIPPAREN_ASSESSMENT_MAX_CONCURRENCY",
  demoPublicUrl: "BRANDKLIPPAREN_DEMO_PUBLIC_URL",
  cacheDir: "BRANDKLIPPAREN_CACHE_DIR",
  apiKeys: "BRANDKLIPPAREN_API_KEYS",
  apiKeyPepper: "BRANDKLIPPAREN_API_KEY_PEPPER",
  rateLimitPerKeyPerMinute: "BRANDKLIPPAREN_RATE_LIMIT_PER_KEY_PER_MINUTE",
  quotaPerKeyPerDay: "BRANDKLIPPAREN_QUOTA_PER_KEY_PER_DAY",
  globalRatePerMinute: "BRANDKLIPPAREN_GLOBAL_RATE_PER_MINUTE",
  budgetDailyCapRpcCalls: "BRANDKLIPPAREN_BUDGET_DAILY_CAP_RPC_CALLS",
  budgetPerKeyDailyCapRpcCalls: "BRANDKLIPPAREN_BUDGET_PER_KEY_DAILY_CAP_RPC_CALLS",
  budgetDailyCapAssessmentCalls: "BRANDKLIPPAREN_BUDGET_DAILY_CAP_ASSESSMENT_CALLS",
  budgetDailyCapAssessmentCallsMeta: "BRANDKLIPPAREN_BUDGET_DAILY_CAP_ASSESSMENT_CALLS_META",
  budgetDailyCapAssessmentCallshosted: "BRANDKLIPPAREN_BUDGET_DAILY_CAP_ASSESSMENT_CALLS_hosted",
  budgetPerKeyDailyCapAssessmentCalls: "BRANDKLIPPAREN_BUDGET_PER_KEY_DAILY_CAP_ASSESSMENT_CALLS",
  assessmentDailyCostCapMeta: "BRANDKLIPPAREN_ASSESSMENT_DAILY_COST_CAP_META",
  assessmentDailyCostCaphosted: "BRANDKLIPPAREN_ASSESSMENT_DAILY_COST_CAP_hosted",
  alarmLevelsPercent: "BRANDKLIPPAREN_ALARM_LEVELS_PERCENT",
  logLevel: "BRANDKLIPPAREN_LOG_LEVEL",
  assessmentProvider: "BRANDKLIPPAREN_ASSESSMENT_PROVIDER",
  assessmentPromptVersion: "BRANDKLIPPAREN_ASSESSMENT_PROMPT_VERSION",
  assessmentMetaApiKey: "BRANDKLIPPAREN_ASSESSMENT_META_API_KEY",
  assessmentMetaModelId: "BRANDKLIPPAREN_ASSESSMENT_META_MODEL_ID",
  assessmentMetaBaseUrl: "BRANDKLIPPAREN_ASSESSMENT_META_BASE_URL",
  assessmenthostedApiKey: "BRANDKLIPPAREN_ASSESSMENT_hosted_API_KEY",
  assessmenthostedModelId: "BRANDKLIPPAREN_ASSESSMENT_hosted_MODEL_ID",
  assessmenthostedBaseUrl: "BRANDKLIPPAREN_ASSESSMENT_hosted_BASE_URL",
  assessmenthostedDeploymentId: "BRANDKLIPPAREN_ASSESSMENT_hosted_DEPLOYMENT_ID",
  investigatehostedBaseUrl: "BRANDKLIPPAREN_INVESTIGATE_hosted_BASE_URL",
  investigatehostedApiKey: "BRANDKLIPPAREN_INVESTIGATE_hosted_API_KEY",
  investigatehostedModelId: "BRANDKLIPPAREN_INVESTIGATE_hosted_MODEL_ID",
  investigateDeadlineMs: "BRANDKLIPPAREN_INVESTIGATE_DEADLINE_MS",
  investigateMaxInputBytes: "BRANDKLIPPAREN_INVESTIGATE_MAX_INPUT_BYTES",
  investigateMaxOutputBytes: "BRANDKLIPPAREN_INVESTIGATE_MAX_OUTPUT_BYTES",
  investigateMaxSteps: "BRANDKLIPPAREN_INVESTIGATE_MAX_STEPS",
  investigatePromptVersion: "BRANDKLIPPAREN_INVESTIGATE_PROMPT_VERSION",
  investigateDailyCapPerKey: "BRANDKLIPPAREN_INVESTIGATE_DAILY_CAP_PER_KEY",
  feedEtherscanApiKey: "ETHERSCAN_API_KEY",
  feedRpcUrl: "BRANDKLIPPAREN_FEED_RPC_URL",
  feedWethAddress: "BK_WETH_ADDRESS",
  feedStatePath: "BRANDKLIPPAREN_FEED_STATE_PATH",
  investigateMaxTokens: "BRANDKLIPPAREN_INVESTIGATE_MAX_TOKENS",
  investigateToolTimeoutMs: "BRANDKLIPPAREN_INVESTIGATE_TOOL_TIMEOUT_MS",
} as const;

const parseEnvName = (raw: string): Result<EnvironmentName, ConfigError> =>
  parseEnum<EnvironmentName>(V.environment, ["local", "ci", "demo"], "local, ci or demo")(raw);

const parseLogLevel = (raw: string): Result<LogLevel, ConfigError> =>
  parseEnum<LogLevel>(V.logLevel, ["debug", "info", "warn", "error"], "debug, info, warn or error")(raw);

const parseProvider = (raw: string): Result<AssessmentProvider, ConfigError> =>
  parseEnum<AssessmentProvider>(
    V.assessmentProvider,
    ["meta-model-api", "hosted-open-weights"],
    "meta-model-api or hosted-open-weights",
  )(raw);

// Every variable name from the schema, exported so the .env.example
// check and future tooling stay aligned with the loader.
export const CONFIG_VARIABLE_NAMES: readonly string[] = Object.freeze(Object.values(V));

export function loadConfig(env: EnvInput): Result<AppConfig, ConfigError> {
  const envParsed = requiredField(env, V.environment, parseEnvName);
  if (!envParsed.ok) {
    return envParsed;
  }
  const envName = envParsed.value;
  const isDemo = envName === "demo";
  const isCi = envName === "ci";

  const modelVersion = requiredField(env, V.modelVersion, (raw) =>
    mapDomain(V.modelVersion, "must be semver MAJOR.MINOR.PATCH", ModelVersion.parse(raw)),
  );
  if (!modelVersion.ok) {
    return modelVersion;
  }
  const modelArtifactPath = requiredField(env, V.modelArtifactPath, (raw) =>
    parseArtifactPath(V.modelArtifactPath, raw),
  );
  if (!modelArtifactPath.ok) {
    return modelArtifactPath;
  }
  const cloneIndexVersion = requiredField(env, V.cloneIndexVersion, (raw) =>
    mapDomain(V.cloneIndexVersion, "must be semver MAJOR.MINOR.PATCH", IndexVersion.parse(raw)),
  );
  if (!cloneIndexVersion.ok) {
    return cloneIndexVersion;
  }
  const extdecompDeadlineMs = requiredField(env, V.extdecompDeadlineMs, (raw) =>
    parseInteger(V.extdecompDeadlineMs, raw, 1, 3600000),
  );
  if (!extdecompDeadlineMs.ok) {
    return extdecompDeadlineMs;
  }
  const extdecompMaxMemoryMb = requiredField(env, V.extdecompMaxMemoryMb, (raw) =>
    parseInteger(V.extdecompMaxMemoryMb, raw, 1, 1048576),
  );
  if (!extdecompMaxMemoryMb.ok) {
    return extdecompMaxMemoryMb;
  }
  const extdecompMaxOutputBytes = requiredField(env, V.extdecompMaxOutputBytes, (raw) =>
    parseInteger(V.extdecompMaxOutputBytes, raw, 1, 1073741824),
  );
  if (!extdecompMaxOutputBytes.ok) {
    return extdecompMaxOutputBytes;
  }
  const logLevel = requiredField(env, V.logLevel, parseLogLevel);
  if (!logLevel.ok) {
    return logLevel;
  }

  const httpPort = requiredWhen(env, V.httpPort, !isCi, (raw) =>
    parseInteger(V.httpPort, raw, 1, 65535),
  );
  if (!httpPort.ok) {
    return httpPort;
  }
  const cacheDir = requiredWhen(env, V.cacheDir, !isCi, (raw) =>
    parseNonEmpty(V.cacheDir, raw, "a non-empty directory path"),
  );
  if (!cacheDir.ok) {
    return cacheDir;
  }
  // Optional in every setup: an empty key set fails closed in the REST
  // adapter, which rejects analysis calls until a key is configured.
  const apiKeys = optionalField(env, V.apiKeys, (raw) => parseApiKeys(V.apiKeys, raw));
  if (!apiKeys.ok) {
    return apiKeys;
  }

  // Mainnet only (S-091, K-001): the product analyses Ethereum
  // mainnet (chainId 1) and turns every other chain id away with a
  // typed error naming the variable.
  const chainId = requiredWhen(env, V.chainId, isDemo, (raw) =>
    mapChainId(parseInteger(V.chainId, raw, 1, 2147483647)),
  );
  if (!chainId.ok) {
    return chainId;
  }
  const rpcUrls = requiredWhen(env, V.rpcUrls, isDemo, (raw) => parseRpcUrls(V.rpcUrls, raw));
  if (!rpcUrls.ok) {
    return rpcUrls;
  }
  const extdecompMaxConcurrency = requiredWhen(env, V.extdecompMaxConcurrency, isDemo, (raw) =>
    parseInteger(V.extdecompMaxConcurrency, raw, 1, 1024),
  );
  if (!extdecompMaxConcurrency.ok) {
    return extdecompMaxConcurrency;
  }
  // Path to the decompiler executable (the pinned extdecomp binary in the
  // demo per I-05, the fake worker script in tests). Optional in every
  // setup: the adapter factory reports the missing variable when a worker
  // is bound without it.
  const extdecompBinaryPath = optionalField(env, V.extdecompBinaryPath, (raw) =>
    parseNonEmpty(V.extdecompBinaryPath, raw, "a non-empty binary path"),
  );
  if (!extdecompBinaryPath.ok) {
    return extdecompBinaryPath;
  }
  const rpcDeadlineMs = requiredWhen(env, V.rpcDeadlineMs, isDemo, (raw) =>
    parseInteger(V.rpcDeadlineMs, raw, 1, 3600000),
  );
  if (!rpcDeadlineMs.ok) {
    return rpcDeadlineMs;
  }
  const rpcMaxConcurrency = requiredWhen(env, V.rpcMaxConcurrency, isDemo, (raw) =>
    parseInteger(V.rpcMaxConcurrency, raw, 1, 1024),
  );
  if (!rpcMaxConcurrency.ok) {
    return rpcMaxConcurrency;
  }
  const rpcRetryBudget = requiredWhen(env, V.rpcRetryBudget, isDemo, (raw) =>
    parseInteger(V.rpcRetryBudget, raw, 0, 10),
  );
  if (!rpcRetryBudget.ok) {
    return rpcRetryBudget;
  }
  const rpcMaxResponseBytes = requiredWhen(env, V.rpcMaxResponseBytes, isDemo, (raw) =>
    parseInteger(V.rpcMaxResponseBytes, raw, 1, 1073741824),
  );
  if (!rpcMaxResponseBytes.ok) {
    return rpcMaxResponseBytes;
  }
  // Proxy chain bound (K-002, K-005): optional in every setup; the
  // application falls back to its placeholder default when unset.
  const proxyMaxDepth = optionalField(env, V.proxyMaxDepth, (raw) =>
    parseInteger(V.proxyMaxDepth, raw, 1, 32),
  );
  if (!proxyMaxDepth.ok) {
    return proxyMaxDepth;
  }
  const assessmentDeadlineMs = requiredWhen(env, V.assessmentDeadlineMs, isDemo, (raw) =>
    parseInteger(V.assessmentDeadlineMs, raw, 1, 3600000),
  );
  if (!assessmentDeadlineMs.ok) {
    return assessmentDeadlineMs;
  }
  const assessmentMaxInputBytes = requiredWhen(env, V.assessmentMaxInputBytes, isDemo, (raw) =>
    parseInteger(V.assessmentMaxInputBytes, raw, 1, 1073741824),
  );
  if (!assessmentMaxInputBytes.ok) {
    return assessmentMaxInputBytes;
  }
  const assessmentMaxOutputBytes = requiredWhen(env, V.assessmentMaxOutputBytes, isDemo, (raw) =>
    parseInteger(V.assessmentMaxOutputBytes, raw, 1, 1073741824),
  );
  if (!assessmentMaxOutputBytes.ok) {
    return assessmentMaxOutputBytes;
  }
  const assessmentMaxConcurrency = requiredWhen(env, V.assessmentMaxConcurrency, isDemo, (raw) =>
    parseInteger(V.assessmentMaxConcurrency, raw, 1, 1024),
  );
  if (!assessmentMaxConcurrency.ok) {
    return assessmentMaxConcurrency;
  }
  const demoPublicUrl = requiredWhen(env, V.demoPublicUrl, isDemo, (raw) =>
    parseHttpsUrl(V.demoPublicUrl, raw),
  );
  if (!demoPublicUrl.ok) {
    return demoPublicUrl;
  }
  const apiKeyPepper = requiredWhen(env, V.apiKeyPepper, isDemo, (raw) =>
    parseSecret(V.apiKeyPepper, raw),
  );
  if (!apiKeyPepper.ok) {
    return apiKeyPepper;
  }
  const rateLimitPerKeyPerMinute = requiredWhen(env, V.rateLimitPerKeyPerMinute, isDemo, (raw) =>
    parseInteger(V.rateLimitPerKeyPerMinute, raw, 1, 1000000000),
  );
  if (!rateLimitPerKeyPerMinute.ok) {
    return rateLimitPerKeyPerMinute;
  }
  const quotaPerKeyPerDay = requiredWhen(env, V.quotaPerKeyPerDay, isDemo, (raw) =>
    parseInteger(V.quotaPerKeyPerDay, raw, 1, 1000000000),
  );
  if (!quotaPerKeyPerDay.ok) {
    return quotaPerKeyPerDay;
  }
  const globalRatePerMinute = requiredWhen(env, V.globalRatePerMinute, isDemo, (raw) =>
    parseInteger(V.globalRatePerMinute, raw, 1, 1000000000),
  );
  if (!globalRatePerMinute.ok) {
    return globalRatePerMinute;
  }
  const budgetDailyCapRpcCalls = requiredWhen(env, V.budgetDailyCapRpcCalls, isDemo, (raw) =>
    parseInteger(V.budgetDailyCapRpcCalls, raw, 1, 1000000000),
  );
  if (!budgetDailyCapRpcCalls.ok) {
    return budgetDailyCapRpcCalls;
  }
  const budgetPerKeyDailyCapRpcCalls = requiredWhen(
    env,
    V.budgetPerKeyDailyCapRpcCalls,
    isDemo,
    (raw) => parseInteger(V.budgetPerKeyDailyCapRpcCalls, raw, 1, 1000000000),
  );
  if (!budgetPerKeyDailyCapRpcCalls.ok) {
    return budgetPerKeyDailyCapRpcCalls;
  }
  const budgetDailyCapAssessmentCalls = requiredWhen(
    env,
    V.budgetDailyCapAssessmentCalls,
    isDemo,
    (raw) => parseInteger(V.budgetDailyCapAssessmentCalls, raw, 1, 1000000000),
  );
  if (!budgetDailyCapAssessmentCalls.ok) {
    return budgetDailyCapAssessmentCalls;
  }
  const budgetDailyCapAssessmentCallsMeta = requiredWhen(
    env,
    V.budgetDailyCapAssessmentCallsMeta,
    isDemo,
    (raw) => parseInteger(V.budgetDailyCapAssessmentCallsMeta, raw, 1, 1000000000),
  );
  if (!budgetDailyCapAssessmentCallsMeta.ok) {
    return budgetDailyCapAssessmentCallsMeta;
  }
  const budgetDailyCapAssessmentCallshosted = requiredWhen(
    env,
    V.budgetDailyCapAssessmentCallshosted,
    isDemo,
    (raw) => parseInteger(V.budgetDailyCapAssessmentCallshosted, raw, 1, 1000000000),
  );
  if (!budgetDailyCapAssessmentCallshosted.ok) {
    return budgetDailyCapAssessmentCallshosted;
  }
  const budgetPerKeyDailyCapAssessmentCalls = requiredWhen(
    env,
    V.budgetPerKeyDailyCapAssessmentCalls,
    isDemo,
    (raw) => parseInteger(V.budgetPerKeyDailyCapAssessmentCalls, raw, 1, 1000000000),
  );
  if (!budgetPerKeyDailyCapAssessmentCalls.ok) {
    return budgetPerKeyDailyCapAssessmentCalls;
  }
  const assessmentDailyCostCapMeta = requiredWhen(env, V.assessmentDailyCostCapMeta, isDemo, (raw) =>
    parsePositiveAmount(V.assessmentDailyCostCapMeta, raw),
  );
  if (!assessmentDailyCostCapMeta.ok) {
    return assessmentDailyCostCapMeta;
  }
  const assessmentDailyCostCaphosted = requiredWhen(
    env,
    V.assessmentDailyCostCaphosted,
    isDemo,
    (raw) => parsePositiveAmount(V.assessmentDailyCostCaphosted, raw),
  );
  if (!assessmentDailyCostCaphosted.ok) {
    return assessmentDailyCostCaphosted;
  }
  const alarmLevelsPercent = requiredWhen(env, V.alarmLevelsPercent, isDemo, (raw) =>
    parseAlarmLevels(V.alarmLevelsPercent, raw),
  );
  if (!alarmLevelsPercent.ok) {
    return alarmLevelsPercent;
  }
  const assessmentProvider = requiredWhen(env, V.assessmentProvider, isDemo, parseProvider);
  if (!assessmentProvider.ok) {
    return assessmentProvider;
  }
  const assessmentPromptVersion = requiredWhen(env, V.assessmentPromptVersion, isDemo, (raw) =>
    mapDomain(V.assessmentPromptVersion, "must be semver MAJOR.MINOR.PATCH", PromptVersion.parse(raw)),
  );
  if (!assessmentPromptVersion.ok) {
    return assessmentPromptVersion;
  }

  const provider = assessmentProvider.value;
  const needsMeta = isDemo && provider === "meta-model-api";
  const needshosted = isDemo && provider === "hosted-open-weights";
  const assessmentMetaApiKey = requiredWhen(env, V.assessmentMetaApiKey, needsMeta, (raw) =>
    parseSecret(V.assessmentMetaApiKey, raw),
  );
  if (!assessmentMetaApiKey.ok) {
    return assessmentMetaApiKey;
  }
  const assessmentMetaModelId = requiredWhen(env, V.assessmentMetaModelId, needsMeta, (raw) =>
    mapDomain(
      V.assessmentMetaModelId,
      "must be a 1-256 character model identifier",
      ModelId.parse(raw),
    ),
  );
  if (!assessmentMetaModelId.ok) {
    return assessmentMetaModelId;
  }
  const assessmentMetaBaseUrl = requiredWhen(env, V.assessmentMetaBaseUrl, needsMeta, (raw) =>
    parseHttpsUrl(V.assessmentMetaBaseUrl, raw),
  );
  if (!assessmentMetaBaseUrl.ok) {
    return assessmentMetaBaseUrl;
  }
  const assessmenthostedApiKey = requiredWhen(env, V.assessmenthostedApiKey, needshosted, (raw) =>
    parseSecret(V.assessmenthostedApiKey, raw),
  );
  if (!assessmenthostedApiKey.ok) {
    return assessmenthostedApiKey;
  }
  const assessmenthostedModelId = requiredWhen(env, V.assessmenthostedModelId, needshosted, (raw) =>
    mapDomain(
      V.assessmenthostedModelId,
      "must be a 1-256 character model identifier",
      ModelId.parse(raw),
    ),
  );
  if (!assessmenthostedModelId.ok) {
    return assessmenthostedModelId;
  }
  const assessmenthostedBaseUrl = requiredWhen(env, V.assessmenthostedBaseUrl, needshosted, (raw) =>
    parseHttpsUrl(V.assessmenthostedBaseUrl, raw),
  );
  if (!assessmenthostedBaseUrl.ok) {
    return assessmenthostedBaseUrl;
  }
  const assessmenthostedDeploymentId = requiredWhen(
    env,
    V.assessmenthostedDeploymentId,
    needshosted,
    (raw) => parseNonEmpty(V.assessmenthostedDeploymentId, raw, "a non-empty deployment identifier"),
  );
  if (!assessmenthostedDeploymentId.ok) {
    return assessmenthostedDeploymentId;
  }
  // Investigation loop settings (S-073, P-29, P-34): optional in every
  // setup, so local and CI runs stay key-free with the loop answering
  // `not-configured`. The demo sets the key alongside the assessment keys.
  const investigatehostedBaseUrl = optionalField(env, V.investigatehostedBaseUrl, (raw) =>
    parseHttpsUrl(V.investigatehostedBaseUrl, raw),
  );
  if (!investigatehostedBaseUrl.ok) {
    return investigatehostedBaseUrl;
  }
  const investigatehostedApiKey = optionalField(env, V.investigatehostedApiKey, (raw) =>
    parseSecret(V.investigatehostedApiKey, raw),
  );
  if (!investigatehostedApiKey.ok) {
    return investigatehostedApiKey;
  }
  const investigatehostedModelId = optionalField(env, V.investigatehostedModelId, (raw) =>
    mapDomain(
      V.investigatehostedModelId,
      "must be a 1-256 character model identifier",
      ModelId.parse(raw),
    ),
  );
  if (!investigatehostedModelId.ok) {
    return investigatehostedModelId;
  }
  const investigateDeadlineMs = optionalField(env, V.investigateDeadlineMs, (raw) =>
    parseInteger(V.investigateDeadlineMs, raw, 1, 3600000),
  );
  if (!investigateDeadlineMs.ok) {
    return investigateDeadlineMs;
  }
  const investigateMaxInputBytes = optionalField(env, V.investigateMaxInputBytes, (raw) =>
    parseInteger(V.investigateMaxInputBytes, raw, 1, 1073741824),
  );
  if (!investigateMaxInputBytes.ok) {
    return investigateMaxInputBytes;
  }
  const investigateMaxOutputBytes = optionalField(env, V.investigateMaxOutputBytes, (raw) =>
    parseInteger(V.investigateMaxOutputBytes, raw, 1, 1073741824),
  );
  if (!investigateMaxOutputBytes.ok) {
    return investigateMaxOutputBytes;
  }
  const investigateMaxSteps = optionalField(env, V.investigateMaxSteps, (raw) =>
    parseInteger(V.investigateMaxSteps, raw, 1, 64),
  );
  if (!investigateMaxSteps.ok) {
    return investigateMaxSteps;
  }
  const investigateMaxTokens = optionalField(env, V.investigateMaxTokens, (raw) =>
    parseInteger(V.investigateMaxTokens, raw, 1, 1000000),
  );
  if (!investigateMaxTokens.ok) {
    return investigateMaxTokens;
  }
  const investigateToolTimeoutMs = optionalField(env, V.investigateToolTimeoutMs, (raw) =>
    parseInteger(V.investigateToolTimeoutMs, raw, 1, 3600000),
  );
  if (!investigateToolTimeoutMs.ok) {
    return investigateToolTimeoutMs;
  }
  const investigatePromptVersion = optionalField(env, V.investigatePromptVersion, (raw) =>
    mapDomain(V.investigatePromptVersion, "must be semver MAJOR.MINOR.PATCH", PromptVersion.parse(raw)),
  );
  if (!investigatePromptVersion.ok) {
    return investigatePromptVersion;
  }
  const investigateDailyCapPerKey = optionalField(env, V.investigateDailyCapPerKey, (raw) =>
    parseInteger(V.investigateDailyCapPerKey, raw, 1, 1000000000),
  );
  if (!investigateDailyCapPerKey.ok) {
    return investigateDailyCapPerKey;
  }
  // New-LP-pairs feed keys (S-087, S-088, K-039, K-505): optional in
  // every setup, so local and CI runs stay key-free with the feed
  // answering `not-configured`. The WETH quote arrives from operator
  // configuration and is validated as an address at startup.
  const feedEtherscanApiKey = optionalField(env, V.feedEtherscanApiKey, (raw) =>
    parseSecret(V.feedEtherscanApiKey, raw),
  );
  if (!feedEtherscanApiKey.ok) {
    return feedEtherscanApiKey;
  }
  const feedRpcUrl = optionalField(env, V.feedRpcUrl, (raw) => {
    const parsed = parseHttpsUrl(V.feedRpcUrl, raw);
    if (!parsed.ok) {
      return parsed;
    }
    return ok(new SecretString(parsed.value));
  });
  if (!feedRpcUrl.ok) {
    return feedRpcUrl;
  }
  const feedWethAddress = optionalField(env, V.feedWethAddress, (raw) =>
    mapDomain(V.feedWethAddress, "must be a 0x address", Address.parse(raw)),
  );
  if (!feedWethAddress.ok) {
    return feedWethAddress;
  }
  // The declared return type keeps the parse callback inference exact
  // (the unannotated `err` would widen the field to unknown).
  const feedStatePath = optionalField(env, V.feedStatePath, (raw): Result<string, ConfigError> => {
    if (raw.length === 0 || raw.length > 1024 || raw.includes("\0")) {
      return err({ kind: "invalid-value", variable: V.feedStatePath, reason: "must be a non-empty path" });
    }
    return ok(raw);
  });
  if (!feedStatePath.ok) {
    return feedStatePath;
  }

  const config: AppConfig = {
    env: envName,
    modelVersion: modelVersion.value,
    modelArtifactPath: modelArtifactPath.value,
    cloneIndexVersion: cloneIndexVersion.value,
    extdecompDeadlineMs: extdecompDeadlineMs.value,
    extdecompMaxMemoryMb: extdecompMaxMemoryMb.value,
    extdecompMaxOutputBytes: extdecompMaxOutputBytes.value,
    logLevel: logLevel.value,
    ...(httpPort.value === undefined ? {} : { httpPort: httpPort.value }),
    ...(cacheDir.value === undefined ? {} : { cacheDir: cacheDir.value }),
    ...(apiKeys.value === undefined ? {} : { apiKeys: apiKeys.value }),
    ...(chainId.value === undefined ? {} : { chainId: chainId.value }),
    ...(rpcUrls.value === undefined ? {} : { rpcUrls: rpcUrls.value }),
    ...(extdecompMaxConcurrency.value === undefined
      ? {}
      : { extdecompMaxConcurrency: extdecompMaxConcurrency.value }),
    ...(extdecompBinaryPath.value === undefined
      ? {}
      : { extdecompBinaryPath: extdecompBinaryPath.value }),
    ...(rpcDeadlineMs.value === undefined ? {} : { rpcDeadlineMs: rpcDeadlineMs.value }),
    ...(rpcMaxConcurrency.value === undefined ? {} : { rpcMaxConcurrency: rpcMaxConcurrency.value }),
    ...(rpcRetryBudget.value === undefined ? {} : { rpcRetryBudget: rpcRetryBudget.value }),
    ...(rpcMaxResponseBytes.value === undefined
      ? {}
      : { rpcMaxResponseBytes: rpcMaxResponseBytes.value }),
    ...(proxyMaxDepth.value === undefined ? {} : { proxyMaxDepth: proxyMaxDepth.value }),
    ...(assessmentDeadlineMs.value === undefined
      ? {}
      : { assessmentDeadlineMs: assessmentDeadlineMs.value }),
    ...(assessmentMaxInputBytes.value === undefined
      ? {}
      : { assessmentMaxInputBytes: assessmentMaxInputBytes.value }),
    ...(assessmentMaxOutputBytes.value === undefined
      ? {}
      : { assessmentMaxOutputBytes: assessmentMaxOutputBytes.value }),
    ...(assessmentMaxConcurrency.value === undefined
      ? {}
      : { assessmentMaxConcurrency: assessmentMaxConcurrency.value }),
    ...(demoPublicUrl.value === undefined ? {} : { demoPublicUrl: demoPublicUrl.value }),
    ...(apiKeyPepper.value === undefined ? {} : { apiKeyPepper: apiKeyPepper.value }),
    ...(rateLimitPerKeyPerMinute.value === undefined
      ? {}
      : { rateLimitPerKeyPerMinute: rateLimitPerKeyPerMinute.value }),
    ...(quotaPerKeyPerDay.value === undefined ? {} : { quotaPerKeyPerDay: quotaPerKeyPerDay.value }),
    ...(globalRatePerMinute.value === undefined
      ? {}
      : { globalRatePerMinute: globalRatePerMinute.value }),
    ...(budgetDailyCapRpcCalls.value === undefined
      ? {}
      : { budgetDailyCapRpcCalls: budgetDailyCapRpcCalls.value }),
    ...(budgetPerKeyDailyCapRpcCalls.value === undefined
      ? {}
      : { budgetPerKeyDailyCapRpcCalls: budgetPerKeyDailyCapRpcCalls.value }),
    ...(budgetDailyCapAssessmentCalls.value === undefined
      ? {}
      : { budgetDailyCapAssessmentCalls: budgetDailyCapAssessmentCalls.value }),
    ...(budgetDailyCapAssessmentCallsMeta.value === undefined
      ? {}
      : { budgetDailyCapAssessmentCallsMeta: budgetDailyCapAssessmentCallsMeta.value }),
    ...(budgetDailyCapAssessmentCallshosted.value === undefined
      ? {}
      : { budgetDailyCapAssessmentCallshosted: budgetDailyCapAssessmentCallshosted.value }),
    ...(budgetPerKeyDailyCapAssessmentCalls.value === undefined
      ? {}
      : { budgetPerKeyDailyCapAssessmentCalls: budgetPerKeyDailyCapAssessmentCalls.value }),
    ...(assessmentDailyCostCapMeta.value === undefined
      ? {}
      : { assessmentDailyCostCapMeta: assessmentDailyCostCapMeta.value }),
    ...(assessmentDailyCostCaphosted.value === undefined
      ? {}
      : { assessmentDailyCostCaphosted: assessmentDailyCostCaphosted.value }),
    ...(alarmLevelsPercent.value === undefined
      ? {}
      : { alarmLevelsPercent: alarmLevelsPercent.value }),
    ...(assessmentProvider.value === undefined ? {} : { assessmentProvider: assessmentProvider.value }),
    ...(assessmentPromptVersion.value === undefined
      ? {}
      : { assessmentPromptVersion: assessmentPromptVersion.value }),
    ...(assessmentMetaApiKey.value === undefined
      ? {}
      : { assessmentMetaApiKey: assessmentMetaApiKey.value }),
    ...(assessmentMetaModelId.value === undefined
      ? {}
      : { assessmentMetaModelId: assessmentMetaModelId.value }),
    ...(assessmentMetaBaseUrl.value === undefined
      ? {}
      : { assessmentMetaBaseUrl: assessmentMetaBaseUrl.value }),
    ...(assessmenthostedApiKey.value === undefined
      ? {}
      : { assessmenthostedApiKey: assessmenthostedApiKey.value }),
    ...(assessmenthostedModelId.value === undefined
      ? {}
      : { assessmenthostedModelId: assessmenthostedModelId.value }),
    ...(assessmenthostedBaseUrl.value === undefined
      ? {}
      : { assessmenthostedBaseUrl: assessmenthostedBaseUrl.value }),
    ...(assessmenthostedDeploymentId.value === undefined
      ? {}
      : { assessmenthostedDeploymentId: assessmenthostedDeploymentId.value }),
    ...(investigatehostedBaseUrl.value === undefined
      ? {}
      : { investigatehostedBaseUrl: investigatehostedBaseUrl.value }),
    ...(investigatehostedApiKey.value === undefined
      ? {}
      : { investigatehostedApiKey: investigatehostedApiKey.value }),
    ...(investigatehostedModelId.value === undefined
      ? {}
      : { investigatehostedModelId: investigatehostedModelId.value }),
    ...(investigateDeadlineMs.value === undefined
      ? {}
      : { investigateDeadlineMs: investigateDeadlineMs.value }),
    ...(investigateMaxInputBytes.value === undefined
      ? {}
      : { investigateMaxInputBytes: investigateMaxInputBytes.value }),
    ...(investigateMaxOutputBytes.value === undefined
      ? {}
      : { investigateMaxOutputBytes: investigateMaxOutputBytes.value }),
    ...(investigateMaxSteps.value === undefined ? {} : { investigateMaxSteps: investigateMaxSteps.value }),
    ...(investigateMaxTokens.value === undefined
      ? {}
      : { investigateMaxTokens: investigateMaxTokens.value }),
    ...(investigateToolTimeoutMs.value === undefined
      ? {}
      : { investigateToolTimeoutMs: investigateToolTimeoutMs.value }),
    ...(investigatePromptVersion.value === undefined
      ? {}
      : { investigatePromptVersion: investigatePromptVersion.value }),
    ...(investigateDailyCapPerKey.value === undefined
      ? {}
      : { investigateDailyCapPerKey: investigateDailyCapPerKey.value }),
    ...(feedEtherscanApiKey.value === undefined
      ? {}
      : { feedEtherscanApiKey: feedEtherscanApiKey.value }),
    ...(feedRpcUrl.value === undefined ? {} : { feedRpcUrl: feedRpcUrl.value }),
    ...(feedWethAddress.value === undefined ? {} : { feedWethAddress: feedWethAddress.value }),
    ...(feedStatePath.value === undefined ? {} : { feedStatePath: feedStatePath.value }),
  };

  if (config.rpcUrls !== undefined) {
    Object.freeze(config.rpcUrls);
  }
  if (config.apiKeys !== undefined) {
    Object.freeze(config.apiKeys);
  }
  if (config.alarmLevelsPercent !== undefined) {
    Object.freeze(config.alarmLevelsPercent);
  }
  return ok(Object.freeze(config));
}
