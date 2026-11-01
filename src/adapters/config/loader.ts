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
import type { PluginPersonalizeProvider } from "../../ports/pluginPersonalizeModel.ts";

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

function parseBoundedNumber(name: string, raw: string, min: number, max: number): Result<number, ConfigError> {
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    return err(invalid(name, `must be a number in [${min}, ${max}]`));
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return err(invalid(name, `must be a number in [${min}, ${max}]`));
  }
  return ok(parsed);
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
  assessmentGenericCompatibleApiKey: "BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_API_KEY",
  assessmentGenericCompatibleModelId: "BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_MODEL_ID",
  assessmentGenericCompatibleBaseUrl: "BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_BASE_URL",
  assessmentGenericCompatibleTemperature: "BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_TEMPERATURE",
  assessmentGenericCompatibleMaxTokens: "BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_MAX_TOKENS",
  budgetDailyCapAssessmentCallsGenericCompatible:
    "BRANDKLIPPAREN_BUDGET_DAILY_CAP_ASSESSMENT_CALLS_generic_COMPATIBLE",
  assessmentDailyCostCapGenericCompatible: "BRANDKLIPPAREN_ASSESSMENT_DAILY_COST_CAP_generic_COMPATIBLE",
  personalizeProvider: "BRANDKLIPPAREN_PERSONALIZE_PROVIDER",
  personalizeDailyCapPerKey: "BRANDKLIPPAREN_PERSONALIZE_DAILY_CAP_PER_KEY",
  investigateProvider: "BRANDKLIPPAREN_INVESTIGATE_PROVIDER",
  investigateMetaBaseUrl: "BRANDKLIPPAREN_INVESTIGATE_META_BASE_URL",
  investigateMetaApiKey: "BRANDKLIPPAREN_INVESTIGATE_META_API_KEY",
  investigateMetaModelId: "BRANDKLIPPAREN_INVESTIGATE_META_MODEL_ID",
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
  explainProvider: "BRANDKLIPPAREN_EXPLAIN_PROVIDER",
  explainMetaBaseUrl: "BRANDKLIPPAREN_EXPLAIN_META_BASE_URL",
  explainMetaApiKey: "BRANDKLIPPAREN_EXPLAIN_META_API_KEY",
  explainMetaModelId: "BRANDKLIPPAREN_EXPLAIN_META_MODEL_ID",
  chatProvider: "BRANDKLIPPAREN_CHAT_PROVIDER",
  chatMetaBaseUrl: "BRANDKLIPPAREN_CHAT_META_BASE_URL",
  chatMetaApiKey: "BRANDKLIPPAREN_CHAT_META_API_KEY",
  chatMetaModelId: "BRANDKLIPPAREN_CHAT_META_MODEL_ID",
  rugProvider: "BRANDKLIPPAREN_RUG_PROVIDER",
  rugMetaBaseUrl: "BRANDKLIPPAREN_RUG_META_BASE_URL",
  rugMetaApiKey: "BRANDKLIPPAREN_RUG_META_API_KEY",
  rugMetaModelId: "BRANDKLIPPAREN_RUG_META_MODEL_ID",
  explainCodeProvider: "BRANDKLIPPAREN_EXPLAIN_CODE_PROVIDER",
  explainCodeMetaBaseUrl: "BRANDKLIPPAREN_EXPLAIN_CODE_META_BASE_URL",
  explainCodeMetaApiKey: "BRANDKLIPPAREN_EXPLAIN_CODE_META_API_KEY",
  explainCodeMetaModelId: "BRANDKLIPPAREN_EXPLAIN_CODE_META_MODEL_ID",
  explainDailyCapPerKey: "BRANDKLIPPAREN_EXPLAIN_DAILY_CAP_PER_KEY",
  chatDailyCapPerKey: "BRANDKLIPPAREN_CHAT_DAILY_CAP_PER_KEY",
  rugDailyCapPerKey: "BRANDKLIPPAREN_RUG_DAILY_CAP_PER_KEY",
  explainCodeDailyCapPerKey: "BRANDKLIPPAREN_EXPLAIN_CODE_DAILY_CAP_PER_KEY",
  marketProvider: "BRANDKLIPPAREN_MARKET_PROVIDER",
  sourceProvider: "BRANDKLIPPAREN_SOURCE_PROVIDER",
} as const;

const parseEnvName = (raw: string): Result<EnvironmentName, ConfigError> =>
  parseEnum<EnvironmentName>(V.environment, ["local", "ci", "demo"], "local, ci or demo")(raw);

const parseLogLevel = (raw: string): Result<LogLevel, ConfigError> =>
  parseEnum<LogLevel>(V.logLevel, ["debug", "info", "warn", "error"], "debug, info, warn or error")(raw);

const parseProvider = (raw: string): Result<AssessmentProvider, ConfigError> =>
  parseEnum<AssessmentProvider>(
    V.assessmentProvider,
    ["meta-model-api", "hosted-open-weights", "generic-compatible"],
    "meta-model-api, hosted-open-weights or generic-compatible",
  )(raw);

// Experimental AI personalize provider (S-069, P-27): unset or "off"
// leaves the feature disabled; the two wired providers select the mapping
// adapter. Anything else is a typed startup error naming the variable.
const parsePersonalizeProvider = (raw: string): Result<PluginPersonalizeProvider | "off", ConfigError> =>
  parseEnum<PluginPersonalizeProvider | "off">(
    V.personalizeProvider,
    ["off", "meta-model-api", "hosted-open-weights", "generic-compatible"],
    "off, meta-model-api, hosted-open-weights or generic-compatible",
  )(raw);

// Investigation loop provider (M-2): unset or "off" leaves the loop
// disabled; a named provider selects the investigate adapter. Anything
// else is a typed startup error naming the variable.
const parseInvestigateProvider = (
  raw: string,
): Result<"meta-model-api" | "hosted-open-weights" | "off", ConfigError> =>
  parseEnum<"meta-model-api" | "hosted-open-weights" | "off">(
    V.investigateProvider,
    ["meta-model-api", "hosted-open-weights", "off"],
    "meta-model-api, hosted-open-weights or off",
  )(raw);

// Opt-in overlay provider (explain, chat, rug): unset or "off" leaves the
// feature disabled; "meta-model-api" binds the Meta overlay adapter.
// Anything else is a typed startup error naming the variable.
const parseOverlayProvider = (
  name: string,
  raw: string,
): Result<"meta-model-api" | "off", ConfigError> =>
  parseEnum<"meta-model-api" | "off">(name, ["meta-model-api", "off"], "meta-model-api or off")(raw);

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
  // The internal decompiler needs no operational variables: it runs
  // in-process under the engine's own deterministic caps (K-008). Any
  // leftover entries for the removed external-decompiler variables in
  // the environment are ignored here, so they never fail startup.
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

  // Provider credential triples (S-135): optional in every setup. A
  // selected provider without its key, model id or endpoint loads with
  // those fields unset, and the composition root reports the assessment
  // as not configured with zero provider calls instead of failing
  // startup. A present value still parses, so a malformed value stays a
  // typed startup error.
  const assessmentMetaApiKey = optionalField(env, V.assessmentMetaApiKey, (raw) =>
    parseSecret(V.assessmentMetaApiKey, raw),
  );
  if (!assessmentMetaApiKey.ok) {
    return assessmentMetaApiKey;
  }
  const assessmentMetaModelId = optionalField(env, V.assessmentMetaModelId, (raw) =>
    mapDomain(
      V.assessmentMetaModelId,
      "must be a 1-256 character model identifier",
      ModelId.parse(raw),
    ),
  );
  if (!assessmentMetaModelId.ok) {
    return assessmentMetaModelId;
  }
  const assessmentMetaBaseUrl = optionalField(env, V.assessmentMetaBaseUrl, (raw) =>
    parseHttpsUrl(V.assessmentMetaBaseUrl, raw),
  );
  if (!assessmentMetaBaseUrl.ok) {
    return assessmentMetaBaseUrl;
  }
  const assessmenthostedApiKey = optionalField(env, V.assessmenthostedApiKey, (raw) =>
    parseSecret(V.assessmenthostedApiKey, raw),
  );
  if (!assessmenthostedApiKey.ok) {
    return assessmenthostedApiKey;
  }
  const assessmenthostedModelId = optionalField(env, V.assessmenthostedModelId, (raw) =>
    mapDomain(
      V.assessmenthostedModelId,
      "must be a 1-256 character model identifier",
      ModelId.parse(raw),
    ),
  );
  if (!assessmenthostedModelId.ok) {
    return assessmenthostedModelId;
  }
  const assessmenthostedBaseUrl = optionalField(env, V.assessmenthostedBaseUrl, (raw) =>
    parseHttpsUrl(V.assessmenthostedBaseUrl, raw),
  );
  if (!assessmenthostedBaseUrl.ok) {
    return assessmenthostedBaseUrl;
  }
  const assessmenthostedDeploymentId = optionalField(
    env,
    V.assessmenthostedDeploymentId,
    (raw) => parseNonEmpty(V.assessmenthostedDeploymentId, raw, "a non-empty deployment identifier"),
  );
  if (!assessmenthostedDeploymentId.ok) {
    return assessmenthostedDeploymentId;
  }
  // Vendor-neutral chat-completions triple for a temporary local endpoint
  // during development (local development only): optional in every setup
  // like the Meta/hosted triples above, so a selected provider without
  // its key, model id or endpoint means not configured instead of a
  // startup failure. No deployment identifier: only the base URL, model
  // id and key change next to the other providers.
  const assessmentGenericCompatibleApiKey = optionalField(
    env,
    V.assessmentGenericCompatibleApiKey,
    (raw) => parseSecret(V.assessmentGenericCompatibleApiKey, raw),
  );
  if (!assessmentGenericCompatibleApiKey.ok) {
    return assessmentGenericCompatibleApiKey;
  }
  const assessmentGenericCompatibleModelId = optionalField(
    env,
    V.assessmentGenericCompatibleModelId,
    (raw) =>
      mapDomain(
        V.assessmentGenericCompatibleModelId,
        "must be a 1-256 character model identifier",
        ModelId.parse(raw),
      ),
  );
  if (!assessmentGenericCompatibleModelId.ok) {
    return assessmentGenericCompatibleModelId;
  }
  const assessmentGenericCompatibleBaseUrl = optionalField(
    env,
    V.assessmentGenericCompatibleBaseUrl,
    (raw) => parseHttpsUrl(V.assessmentGenericCompatibleBaseUrl, raw),
  );
  if (!assessmentGenericCompatibleBaseUrl.ok) {
    return assessmentGenericCompatibleBaseUrl;
  }
  // Matching daily caps for the vendor-neutral provider, mirroring the
  // Meta/hosted cap variables. Optional in every setup, so local runs
  // stay lean: the service falls back to its placeholder caps when unset.
  const budgetDailyCapAssessmentCallsGenericCompatible = optionalField(
    env,
    V.budgetDailyCapAssessmentCallsGenericCompatible,
    (raw) => parseInteger(V.budgetDailyCapAssessmentCallsGenericCompatible, raw, 1, 1000000000),
  );
  if (!budgetDailyCapAssessmentCallsGenericCompatible.ok) {
    return budgetDailyCapAssessmentCallsGenericCompatible;
  }
  const assessmentDailyCostCapGenericCompatible = optionalField(
    env,
    V.assessmentDailyCostCapGenericCompatible,
    (raw) => parsePositiveAmount(V.assessmentDailyCostCapGenericCompatible, raw),
  );
  if (!assessmentDailyCostCapGenericCompatible.ok) {
    return assessmentDailyCostCapGenericCompatible;
  }
  // Optional sampling temperature in [0, 1] for the vendor-neutral
  // provider: sent only when set, otherwise no sampling parameter
  // travels. Optional completion budget override (default 4096, bounded
  // so a thinking model is not cut off while caps stay meaningful).
  const assessmentGenericCompatibleTemperature = optionalField(
    env,
    V.assessmentGenericCompatibleTemperature,
    (raw) => parseBoundedNumber(V.assessmentGenericCompatibleTemperature, raw, 0, 1),
  );
  if (!assessmentGenericCompatibleTemperature.ok) {
    return assessmentGenericCompatibleTemperature;
  }
  const assessmentGenericCompatibleMaxTokens = optionalField(
    env,
    V.assessmentGenericCompatibleMaxTokens,
    (raw) => parseInteger(V.assessmentGenericCompatibleMaxTokens, raw, 1, 128000),
  );
  if (!assessmentGenericCompatibleMaxTokens.ok) {
    return assessmentGenericCompatibleMaxTokens;
  }
  // Experimental AI personalize toggle (S-069, P-27): optional in every
  // setup, so local and CI runs stay key-free with the mapping route
  // answering `not-configured`. Unset or "off" means disabled; a named
  // provider reuses the assessment connection settings, so no second key
  // or endpoint travels beside this variable.
  const personalizeProvider = optionalField(env, V.personalizeProvider, parsePersonalizeProvider);
  if (!personalizeProvider.ok) {
    return personalizeProvider;
  }
  // Daily cap for personalize mapping calls per API key: optional in
  // every setup, so local runs stay lean. The composition falls back to
  // its small placeholder default when unset.
  const personalizeDailyCapPerKey = optionalField(env, V.personalizeDailyCapPerKey, (raw) =>
    parseInteger(V.personalizeDailyCapPerKey, raw, 1, 1000000),
  );
  if (!personalizeDailyCapPerKey.ok) {
    return personalizeDailyCapPerKey;
  }
  // Investigation loop settings (S-073, P-29, P-34): optional in every
  // setup, so local and CI runs stay key-free with the loop answering
  // `not-configured`. The demo sets the key alongside the assessment keys.
  const investigateProvider = optionalField(env, V.investigateProvider, parseInvestigateProvider);
  if (!investigateProvider.ok) {
    return investigateProvider;
  }
  const investigateMetaBaseUrl = optionalField(env, V.investigateMetaBaseUrl, (raw) =>
    parseHttpsUrl(V.investigateMetaBaseUrl, raw),
  );
  if (!investigateMetaBaseUrl.ok) {
    return investigateMetaBaseUrl;
  }
  const investigateMetaApiKey = optionalField(env, V.investigateMetaApiKey, (raw) =>
    parseSecret(V.investigateMetaApiKey, raw),
  );
  if (!investigateMetaApiKey.ok) {
    return investigateMetaApiKey;
  }
  const investigateMetaModelId = optionalField(env, V.investigateMetaModelId, (raw) =>
    mapDomain(
      V.investigateMetaModelId,
      "must be a 1-256 character model identifier",
      ModelId.parse(raw),
    ),
  );
  if (!investigateMetaModelId.ok) {
    return investigateMetaModelId;
  }
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
  // Opt-in overlay providers (explain, chat, rug): optional in every
  // setup, so local and CI runs stay key-free with each overlay answering
  // `not-configured`. The demo sets the provider alongside the Meta key.
  const explainProvider = optionalField(env, V.explainProvider, (raw) =>
    parseOverlayProvider(V.explainProvider, raw),
  );
  if (!explainProvider.ok) {
    return explainProvider;
  }
  const explainMetaBaseUrl = optionalField(env, V.explainMetaBaseUrl, (raw) =>
    parseHttpsUrl(V.explainMetaBaseUrl, raw),
  );
  if (!explainMetaBaseUrl.ok) {
    return explainMetaBaseUrl;
  }
  const explainMetaApiKey = optionalField(env, V.explainMetaApiKey, (raw) =>
    parseSecret(V.explainMetaApiKey, raw),
  );
  if (!explainMetaApiKey.ok) {
    return explainMetaApiKey;
  }
  const explainMetaModelId = optionalField(env, V.explainMetaModelId, (raw) =>
    mapDomain(
      V.explainMetaModelId,
      "must be a 1-256 character model identifier",
      ModelId.parse(raw),
    ),
  );
  if (!explainMetaModelId.ok) {
    return explainMetaModelId;
  }
  const chatProvider = optionalField(env, V.chatProvider, (raw) =>
    parseOverlayProvider(V.chatProvider, raw),
  );
  if (!chatProvider.ok) {
    return chatProvider;
  }
  const chatMetaBaseUrl = optionalField(env, V.chatMetaBaseUrl, (raw) =>
    parseHttpsUrl(V.chatMetaBaseUrl, raw),
  );
  if (!chatMetaBaseUrl.ok) {
    return chatMetaBaseUrl;
  }
  const chatMetaApiKey = optionalField(env, V.chatMetaApiKey, (raw) =>
    parseSecret(V.chatMetaApiKey, raw),
  );
  if (!chatMetaApiKey.ok) {
    return chatMetaApiKey;
  }
  const chatMetaModelId = optionalField(env, V.chatMetaModelId, (raw) =>
    mapDomain(
      V.chatMetaModelId,
      "must be a 1-256 character model identifier",
      ModelId.parse(raw),
    ),
  );
  if (!chatMetaModelId.ok) {
    return chatMetaModelId;
  }
  const rugProvider = optionalField(env, V.rugProvider, (raw) =>
    parseOverlayProvider(V.rugProvider, raw),
  );
  if (!rugProvider.ok) {
    return rugProvider;
  }
  const rugMetaBaseUrl = optionalField(env, V.rugMetaBaseUrl, (raw) =>
    parseHttpsUrl(V.rugMetaBaseUrl, raw),
  );
  if (!rugMetaBaseUrl.ok) {
    return rugMetaBaseUrl;
  }
  const rugMetaApiKey = optionalField(env, V.rugMetaApiKey, (raw) =>
    parseSecret(V.rugMetaApiKey, raw),
  );
  if (!rugMetaApiKey.ok) {
    return rugMetaApiKey;
  }
  const rugMetaModelId = optionalField(env, V.rugMetaModelId, (raw) =>
    mapDomain(
      V.rugMetaModelId,
      "must be a 1-256 character model identifier",
      ModelId.parse(raw),
    ),
  );
  if (!rugMetaModelId.ok) {
    return rugMetaModelId;
  }
  const explainCodeProvider = optionalField(env, V.explainCodeProvider, (raw) =>
    parseOverlayProvider(V.explainCodeProvider, raw),
  );
  if (!explainCodeProvider.ok) {
    return explainCodeProvider;
  }
  const explainCodeMetaBaseUrl = optionalField(env, V.explainCodeMetaBaseUrl, (raw) =>
    parseHttpsUrl(V.explainCodeMetaBaseUrl, raw),
  );
  if (!explainCodeMetaBaseUrl.ok) {
    return explainCodeMetaBaseUrl;
  }
  const explainCodeMetaApiKey = optionalField(env, V.explainCodeMetaApiKey, (raw) =>
    parseSecret(V.explainCodeMetaApiKey, raw),
  );
  if (!explainCodeMetaApiKey.ok) {
    return explainCodeMetaApiKey;
  }
  const explainCodeMetaModelId = optionalField(env, V.explainCodeMetaModelId, (raw) =>
    mapDomain(
      V.explainCodeMetaModelId,
      "must be a 1-256 character model identifier",
      ModelId.parse(raw),
    ),
  );
  if (!explainCodeMetaModelId.ok) {
    return explainCodeMetaModelId;
  }
  const explainDailyCapPerKey = optionalField(env, V.explainDailyCapPerKey, (raw) =>
    parseInteger(V.explainDailyCapPerKey, raw, 1, 1000000000),
  );
  if (!explainDailyCapPerKey.ok) {
    return explainDailyCapPerKey;
  }
  const chatDailyCapPerKey = optionalField(env, V.chatDailyCapPerKey, (raw) =>
    parseInteger(V.chatDailyCapPerKey, raw, 1, 1000000000),
  );
  if (!chatDailyCapPerKey.ok) {
    return chatDailyCapPerKey;
  }
  const rugDailyCapPerKey = optionalField(env, V.rugDailyCapPerKey, (raw) =>
    parseInteger(V.rugDailyCapPerKey, raw, 1, 1000000000),
  );
  if (!rugDailyCapPerKey.ok) {
    return rugDailyCapPerKey;
  }
  const explainCodeDailyCapPerKey = optionalField(env, V.explainCodeDailyCapPerKey, (raw) =>
    parseInteger(V.explainCodeDailyCapPerKey, raw, 1, 1000000000),
  );
  if (!explainCodeDailyCapPerKey.ok) {
    return explainCodeDailyCapPerKey;
  }
  // Market listing provider (DX-B1): optional in every setup, so local
  // and CI runs stay idle with the listing answering `not-configured`.
  // Unset or "off" means disabled; "dexscreener" binds the public listing
  // adapter, which needs no key. Anything else is a typed startup error
  // naming the variable.
  const marketProvider = optionalField(env, V.marketProvider, (raw) =>
    parseEnum<"dexscreener" | "off">(
      V.marketProvider,
      ["dexscreener", "off"],
      "dexscreener or off",
    )(raw),
  );
  if (!marketProvider.ok) {
    return marketProvider;
  }
  // Verified-source provider (VS-B2): optional in every setup, so
  // local and CI runs stay idle with the source route answering
  // `unavailable`. Unset or "off" means disabled; "sourcify" binds the
  // open source-verification API with the explorer fallback. Anything
  // else is a typed startup error naming the variable.
  const sourceProvider = optionalField(env, V.sourceProvider, (raw) =>
    parseEnum<"sourcify" | "off">(
      V.sourceProvider,
      ["sourcify", "off"],
      "sourcify or off",
    )(raw),
  );
  if (!sourceProvider.ok) {
    return sourceProvider;
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
    logLevel: logLevel.value,
    ...(httpPort.value === undefined ? {} : { httpPort: httpPort.value }),
    ...(cacheDir.value === undefined ? {} : { cacheDir: cacheDir.value }),
    ...(apiKeys.value === undefined ? {} : { apiKeys: apiKeys.value }),
    ...(chainId.value === undefined ? {} : { chainId: chainId.value }),
    ...(rpcUrls.value === undefined ? {} : { rpcUrls: rpcUrls.value }),
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
    ...(assessmentGenericCompatibleApiKey.value === undefined
      ? {}
      : { assessmentGenericCompatibleApiKey: assessmentGenericCompatibleApiKey.value }),
    ...(assessmentGenericCompatibleModelId.value === undefined
      ? {}
      : { assessmentGenericCompatibleModelId: assessmentGenericCompatibleModelId.value }),
    ...(assessmentGenericCompatibleBaseUrl.value === undefined
      ? {}
      : { assessmentGenericCompatibleBaseUrl: assessmentGenericCompatibleBaseUrl.value }),
    ...(budgetDailyCapAssessmentCallsGenericCompatible.value === undefined
      ? {}
      : {
          budgetDailyCapAssessmentCallsGenericCompatible:
            budgetDailyCapAssessmentCallsGenericCompatible.value,
        }),
    ...(assessmentDailyCostCapGenericCompatible.value === undefined
      ? {}
      : { assessmentDailyCostCapGenericCompatible: assessmentDailyCostCapGenericCompatible.value }),
    ...(assessmentGenericCompatibleTemperature.value === undefined
      ? {}
      : { assessmentGenericCompatibleTemperature: assessmentGenericCompatibleTemperature.value }),
    ...(assessmentGenericCompatibleMaxTokens.value === undefined
      ? {}
      : { assessmentGenericCompatibleMaxTokens: assessmentGenericCompatibleMaxTokens.value }),
    ...(personalizeProvider.value === undefined || personalizeProvider.value === "off"
      ? {}
      : { personalizeProvider: personalizeProvider.value }),
    ...(personalizeDailyCapPerKey.value === undefined
      ? {}
      : { personalizeDailyCapPerKey: personalizeDailyCapPerKey.value }),
    // "off" stays in the config (unlike the personalize toggle): the
    // shared vendor-neutral path below must see it and stay disabled.
    ...(investigateProvider.value === undefined
      ? {}
      : { investigateProvider: investigateProvider.value }),
    ...(investigateMetaBaseUrl.value === undefined
      ? {}
      : { investigateMetaBaseUrl: investigateMetaBaseUrl.value }),
    ...(investigateMetaApiKey.value === undefined
      ? {}
      : { investigateMetaApiKey: investigateMetaApiKey.value }),
    ...(investigateMetaModelId.value === undefined
      ? {}
      : { investigateMetaModelId: investigateMetaModelId.value }),
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
    // "off" stays out of the config like the personalize toggle: an
    // unset or "off" provider leaves each overlay disabled.
    ...(explainProvider.value === undefined || explainProvider.value === "off"
      ? {}
      : { explainProvider: explainProvider.value }),
    ...(explainMetaBaseUrl.value === undefined
      ? {}
      : { explainMetaBaseUrl: explainMetaBaseUrl.value }),
    ...(explainMetaApiKey.value === undefined
      ? {}
      : { explainMetaApiKey: explainMetaApiKey.value }),
    ...(explainMetaModelId.value === undefined
      ? {}
      : { explainMetaModelId: explainMetaModelId.value }),
    ...(chatProvider.value === undefined || chatProvider.value === "off"
      ? {}
      : { chatProvider: chatProvider.value }),
    ...(chatMetaBaseUrl.value === undefined ? {} : { chatMetaBaseUrl: chatMetaBaseUrl.value }),
    ...(chatMetaApiKey.value === undefined ? {} : { chatMetaApiKey: chatMetaApiKey.value }),
    ...(chatMetaModelId.value === undefined ? {} : { chatMetaModelId: chatMetaModelId.value }),
    ...(rugProvider.value === undefined || rugProvider.value === "off"
      ? {}
      : { rugProvider: rugProvider.value }),
    ...(rugMetaBaseUrl.value === undefined ? {} : { rugMetaBaseUrl: rugMetaBaseUrl.value }),
    ...(rugMetaApiKey.value === undefined ? {} : { rugMetaApiKey: rugMetaApiKey.value }),
    ...(rugMetaModelId.value === undefined ? {} : { rugMetaModelId: rugMetaModelId.value }),
    ...(explainCodeProvider.value === undefined || explainCodeProvider.value === "off"
      ? {}
      : { explainCodeProvider: explainCodeProvider.value }),
    ...(explainCodeMetaBaseUrl.value === undefined
      ? {}
      : { explainCodeMetaBaseUrl: explainCodeMetaBaseUrl.value }),
    ...(explainCodeMetaApiKey.value === undefined
      ? {}
      : { explainCodeMetaApiKey: explainCodeMetaApiKey.value }),
    ...(explainCodeMetaModelId.value === undefined
      ? {}
      : { explainCodeMetaModelId: explainCodeMetaModelId.value }),
    ...(explainDailyCapPerKey.value === undefined
      ? {}
      : { explainDailyCapPerKey: explainDailyCapPerKey.value }),
    ...(chatDailyCapPerKey.value === undefined
      ? {}
      : { chatDailyCapPerKey: chatDailyCapPerKey.value }),
    ...(rugDailyCapPerKey.value === undefined
      ? {}
      : { rugDailyCapPerKey: rugDailyCapPerKey.value }),
    ...(explainCodeDailyCapPerKey.value === undefined
      ? {}
      : { explainCodeDailyCapPerKey: explainCodeDailyCapPerKey.value }),
    ...(feedEtherscanApiKey.value === undefined
      ? {}
      : { feedEtherscanApiKey: feedEtherscanApiKey.value }),
    ...(feedRpcUrl.value === undefined ? {} : { feedRpcUrl: feedRpcUrl.value }),
    ...(feedWethAddress.value === undefined ? {} : { feedWethAddress: feedWethAddress.value }),
    ...(feedStatePath.value === undefined ? {} : { feedStatePath: feedStatePath.value }),
    // "off" stays in the config like the investigate toggle: the
    // composition must see it and stay disabled.
    ...(marketProvider.value === undefined ? {} : { marketProvider: marketProvider.value }),
    // "off" stays in the config like the market toggle: the
    // composition must see it and stay disabled.
    ...(sourceProvider.value === undefined ? {} : { sourceProvider: sourceProvider.value }),
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
