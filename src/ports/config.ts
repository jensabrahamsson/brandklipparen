// Config port: validated operational configuration as a typed value (A-05).
// The schema mirrors the variable table in docs/infrastructure.md (I-08).
// Secrets travel wrapped in SecretString so they can never be printed or
// serialized by accident; only an explicit reveal() call exposes the value.
import type { Address, ChainId, IndexVersion, ModelId, ModelVersion, PromptVersion } from "../domain/types.ts";

// Fixed marker written wherever a secret value would otherwise appear.
export const REDACTED = "[REDACTED]";

// A secret value with redacted display and serialization (K-505, K-510, M-11).
// The value lives in a private field, so spreading or enumerating the
// instance leaks nothing. Printing, string interpolation, JSON output and
// util.inspect all show the redaction marker. Pass the instance itself
// through the config; call reveal() only at the single point of use
// (for example when building a server-side authentication header).
export class SecretString {
  readonly #value: string;

  constructor(raw: string) {
    this.#value = raw;
    Object.freeze(this);
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}

// Startup errors name the variable with values kept outside the text (A-15).
export type ConfigError =
  | { kind: "missing-variable"; variable: string }
  | { kind: "invalid-value"; variable: string; reason: string };

export function formatConfigError(error: ConfigError): string {
  if (error.kind === "missing-variable") {
    return `missing required variable: ${error.variable}`;
  }
  return `invalid value for ${error.variable}: ${error.reason}`;
}

export type EnvironmentName = "local" | "ci" | "demo";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type AssessmentProvider = "meta-model-api" | "hosted-open-weights" | "generic-compatible";

// Validated operational configuration (I-08). Fields required only in some
// setups stay optional here; loadConfig enforces the per-setup rules and
// freezes the whole value before returning it.
export type AppConfig = {
  readonly env: EnvironmentName;
  readonly modelVersion: ModelVersion;
  readonly modelArtifactPath: string;
  readonly cloneIndexVersion: IndexVersion;
  readonly extdecompDeadlineMs: number;
  readonly extdecompMaxMemoryMb: number;
  readonly extdecompMaxOutputBytes: number;
  readonly logLevel: LogLevel;
  readonly httpPort?: number;
  readonly cacheDir?: string;
  readonly apiKeys?: readonly SecretString[];
  readonly chainId?: ChainId;
  readonly rpcUrls?: readonly SecretString[];
  readonly extdecompMaxConcurrency?: number;
  readonly extdecompBinaryPath?: string;
  readonly rpcDeadlineMs?: number;
  readonly rpcMaxConcurrency?: number;
  readonly rpcRetryBudget?: number;
  readonly rpcMaxResponseBytes?: number;
  readonly proxyMaxDepth?: number;
  readonly assessmentDeadlineMs?: number;
  readonly assessmentMaxInputBytes?: number;
  readonly assessmentMaxOutputBytes?: number;
  readonly assessmentMaxConcurrency?: number;
  readonly demoPublicUrl?: string;
  readonly apiKeyPepper?: SecretString;
  readonly rateLimitPerKeyPerMinute?: number;
  readonly quotaPerKeyPerDay?: number;
  readonly globalRatePerMinute?: number;
  readonly budgetDailyCapRpcCalls?: number;
  readonly budgetPerKeyDailyCapRpcCalls?: number;
  readonly budgetDailyCapAssessmentCalls?: number;
  readonly budgetDailyCapAssessmentCallsMeta?: number;
  readonly budgetDailyCapAssessmentCallshosted?: number;
  readonly budgetPerKeyDailyCapAssessmentCalls?: number;
  readonly assessmentDailyCostCapMeta?: number;
  readonly assessmentDailyCostCaphosted?: number;
  readonly alarmLevelsPercent?: readonly number[];
  readonly assessmentProvider?: AssessmentProvider;
  readonly assessmentPromptVersion?: PromptVersion;
  readonly assessmentMetaApiKey?: SecretString;
  readonly assessmentMetaModelId?: ModelId;
  readonly assessmentMetaBaseUrl?: string;
  readonly assessmenthostedApiKey?: SecretString;
  readonly assessmenthostedModelId?: ModelId;
  readonly assessmenthostedBaseUrl?: string;
  readonly assessmenthostedDeploymentId?: string;
  // Vendor-neutral chat-completions triple for a temporary local endpoint
  // during development (local development only). All optional here;
  // loadConfig enforces the per-setup rules and freezes the whole value.
  readonly assessmentGenericCompatibleApiKey?: SecretString;
  readonly assessmentGenericCompatibleModelId?: ModelId;
  readonly assessmentGenericCompatibleBaseUrl?: string;
  // Experimental AI personalize toggle (S-069, P-27): unset means the
  // feature stays off. The meta-model-api and generic-compatible
  // personalize adapters reuse their assessment triples above, so no
  // second key or endpoint travels. The union mirrors
  // PluginPersonalizeProvider beside the port, the same way
  // AssessmentProvider is mirrored here (ports stay self-contained).
  readonly personalizeProvider?: "hosted-open-weights" | "generic-compatible" | "meta-model-api";
  // Daily cap for personalize mapping calls per API key (S-069): the
  // composition falls back to its small placeholder default when unset.
  readonly personalizeDailyCapPerKey?: number;
  // Optional sampling temperature in [0, 1] for the vendor-neutral
  // provider: sent only when set, otherwise no sampling parameter
  // travels. Optional completion budget override (default 4096).
  readonly assessmentGenericCompatibleTemperature?: number;
  readonly assessmentGenericCompatibleMaxTokens?: number;
  readonly budgetDailyCapAssessmentCallsGenericCompatible?: number;
  readonly assessmentDailyCostCapGenericCompatible?: number;
  // Investigation loop provider selection: unset or "off" leaves the
  // loop disabled with the deterministic analysis standing; a named
  // provider binds its adapter when its connection triple is complete,
  // otherwise the loop answers `not-configured` with zero provider calls
  // instead of failing startup.
  readonly investigateProvider?: "meta-model-api" | "hosted-open-weights" | "off";
  // Meta Model API connection for the investigation loop: the key loads
  // only via its pointer file in the demo, the model id defaults to
  // muse-spark-1.3 in the adapter, and the base URL is validated as an
  // https URL at startup like the assessment Meta base URL.
  readonly investigateMetaBaseUrl?: string;
  readonly investigateMetaApiKey?: SecretString;
  readonly investigateMetaModelId?: ModelId;
  // Investigation loop on open weights (S-073, P-29, P-30, P-34): all
  // optional in every setup. An absent key leaves the loop answering
  // `not-configured` with zero provider calls instead of failing startup.
  readonly investigatehostedBaseUrl?: string;
  readonly investigatehostedApiKey?: SecretString;
  readonly investigatehostedModelId?: ModelId;
  readonly investigateDeadlineMs?: number;
  readonly investigateMaxInputBytes?: number;
  readonly investigateMaxOutputBytes?: number;
  readonly investigateMaxSteps?: number;
  readonly investigateMaxTokens?: number;
  readonly investigateToolTimeoutMs?: number;
  readonly investigatePromptVersion?: PromptVersion;
  readonly investigateDailyCapPerKey?: number;
  // New-LP-pairs feed on mainnet (S-087, S-088, K-039, K-505): all
  // optional in every setup. An absent Etherscan key or fallback URL
  // leaves the feed answering `not-configured` with zero sends instead
  // of failing startup; an absent WETH quote leaves the WETH side
  // unresolvable with the same typed outcome.
  readonly feedEtherscanApiKey?: SecretString;
  readonly feedRpcUrl?: SecretString;
  readonly feedWethAddress?: Address;
  // Feed cursor and pending-queue file (S-103): optional in every setup.
  // An unset path leaves state in memory only, so local and CI runs stay
  // file-free; the poller writes through this path when it is set.
  readonly feedStatePath?: string | undefined;
};

// Kept for traceability: docs/architecture.md (A-05) names this value DriftConfig.
export type DriftConfig = AppConfig;

export interface ConfigPort {
  config(): DriftConfig;
}
