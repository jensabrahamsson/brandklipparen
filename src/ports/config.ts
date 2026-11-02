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
export type AssessmentProvider = "meta-model-api";

// Validated operational configuration (I-08). Fields required only in some
// setups stay optional here; loadConfig enforces the per-setup rules and
// freezes the whole value before returning it.
export type AppConfig = {
  readonly env: EnvironmentName;
  readonly modelVersion: ModelVersion;
  readonly modelArtifactPath: string;
  readonly cloneIndexVersion: IndexVersion;
  readonly logLevel: LogLevel;
  readonly httpPort?: number;
  readonly cacheDir?: string;
  readonly apiKeys?: readonly SecretString[];
  readonly chainId?: ChainId;
  readonly rpcUrls?: readonly SecretString[];
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
  // SEC-1 S-2: per-key share of the global minute window, in percent.
  readonly rateLimitPerKeyGlobalSharePercent?: number;
  // SEC-1 S-8: global daily cap for Meta Model API calls across keys.
  readonly aiGlobalDailyCalls?: number;
  // Daily cap for assessment calls per API key: the only enforced
  // provider-adjacent cap. There is no global per-provider daily cap.
  readonly budgetPerKeyDailyCapAssessmentCalls?: number;
  // Assessment provider selection: the loader accepts "meta-model-api"
  // or "off" (and unset); "off" and unset both map to disabled by storing
  // no provider here, so composition treats both the same.
  readonly assessmentProvider?: AssessmentProvider;
  readonly assessmentPromptVersion?: PromptVersion;
  readonly assessmentMetaApiKey?: SecretString;
  readonly assessmentMetaModelId?: ModelId;
  readonly assessmentMetaBaseUrl?: string;
  // Experimental AI personalize toggle (S-069, P-27): unset means the
  // feature stays off. The meta-model-api personalize adapter reuses the
  // assessment Meta triple above, so no second key or endpoint travels.
  // The union mirrors PluginPersonalizeProvider beside the port, the same
  // way AssessmentProvider is mirrored here (ports stay self-contained).
  readonly personalizeProvider?: "meta-model-api";
  // Daily cap for personalize mapping calls per API key (S-069): the
  // composition falls back to its small placeholder default when unset.
  readonly personalizeDailyCapPerKey?: number;
  // Investigation loop provider selection: unset or "off" leaves the
  // loop disabled with the deterministic analysis standing; a named
  // provider binds its adapter when its connection triple is complete,
  // otherwise the loop answers `not-configured` with zero provider calls
  // instead of failing startup.
  readonly investigateProvider?: "meta-model-api" | "off";
  // Meta Model API connection for the investigation loop: the key loads
  // only via its pointer file in the demo, the model id defaults to
  // muse-spark-1.3 in the adapter, and the base URL is validated as an
  // https URL at startup like the assessment Meta base URL.
  readonly investigateMetaBaseUrl?: string;
  readonly investigateMetaApiKey?: SecretString;
  readonly investigateMetaModelId?: ModelId;
  readonly investigateDeadlineMs?: number;
  readonly investigateMaxInputBytes?: number;
  readonly investigateMaxOutputBytes?: number;
  readonly investigateMaxSteps?: number;
  readonly investigateMaxTokens?: number;
  readonly investigateToolTimeoutMs?: number;
  readonly investigatePromptVersion?: PromptVersion;
  readonly investigateDailyCapPerKey?: number;
  // Opt-in overlay providers (explain, chat, rug, explain-code): unset or
  // "off" leaves each feature disabled with zero provider calls. A
  // selected provider binds its Meta Model API adapter when its
  // connection triple below is complete (the model id defaults to
  // muse-spark-1.3 in the adapter), otherwise the feature stays disabled
  // instead of failing startup.
  readonly explainProvider?: "meta-model-api" | "off";
  readonly explainMetaBaseUrl?: string;
  readonly explainMetaApiKey?: SecretString;
  readonly explainMetaModelId?: ModelId;
  readonly chatProvider?: "meta-model-api" | "off";
  readonly chatMetaBaseUrl?: string;
  readonly chatMetaApiKey?: SecretString;
  readonly chatMetaModelId?: ModelId;
  readonly rugProvider?: "meta-model-api" | "off";
  readonly rugMetaBaseUrl?: string;
  readonly rugMetaApiKey?: SecretString;
  readonly rugMetaModelId?: ModelId;
  readonly explainCodeProvider?: "meta-model-api" | "off";
  readonly explainCodeMetaBaseUrl?: string;
  readonly explainCodeMetaApiKey?: SecretString;
  readonly explainCodeMetaModelId?: ModelId;
  // Daily caps for overlay calls per API key: the composition falls back
  // to its small placeholder default when unset.
  readonly explainDailyCapPerKey?: number;
  readonly chatDailyCapPerKey?: number;
  readonly rugDailyCapPerKey?: number;
  readonly explainCodeDailyCapPerKey?: number;
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
  // Market listing provider (DX-B1): unset or "off" leaves the listing
  // answering not-configured with zero sends. "dexscreener" binds the
  // public listing adapter, which needs no key. The demo selects
  // dexscreener unless set explicitly; other setups stay off when unset.
  readonly marketProvider?: "dexscreener" | "off";
  // Verified-source provider (VS-B2): unset or "off" leaves the source
  // route answering unavailable with zero sends. "sourcify" binds the
  // open source-verification API as primary with the block explorer
  // source endpoint as fallback (only when the explorer key is
  // configured). The demo selects sourcify unless set explicitly;
  // other setups stay off when unset. Never in the score.
  readonly sourceProvider?: "sourcify" | "off";
};

// Kept for traceability: docs/architecture.md (A-05) names this value DriftConfig.
export type DriftConfig = AppConfig;

export interface ConfigPort {
  config(): DriftConfig;
}
