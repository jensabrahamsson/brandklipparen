// Config port: validated operational configuration as a typed value (A-05).
// The schema mirrors the variable table in docs/infrastructure.md (I-08).
// Secrets travel wrapped in SecretString so they can never be printed or
// serialized by accident; only an explicit reveal() call exposes the value.
import type { ChainId, IndexVersion, ModelId, ModelVersion, PromptVersion } from "../domain/types.ts";

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
export type AssessmentProvider = "meta-model-api" | "hosted-open-weights";

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
};

// Kept for traceability: docs/architecture.md (A-05) names this value DriftConfig.
export type DriftConfig = AppConfig;

export interface ConfigPort {
  config(): DriftConfig;
}
