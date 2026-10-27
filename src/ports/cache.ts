// CachePort: reading and writing of analysis results per code hash and
// model version (A-05, K-013, K-511, I-14). The port is owned by the core:
// the application service looks the key up before any RPC, decompiler or
// model call and stores the assessed envelope after a miss, so equal code
// hash and model version give a cache hit with zero external calls. A new
// model version keys new entries, so older entries stay unused. Entries
// are validated at read in the adapter (A-16, M-14): a corrupt entry
// yields the entry-corrupt branch and the service analyses again.
import type { Result } from "../domain/result.ts";
import type { CantTellItem } from "../domain/cantTell.ts";
import type { Explanation } from "../domain/explain.ts";
import type { ProxyResolution } from "../domain/proxy.ts";
import type { RiskType, Signal } from "../domain/signals.ts";
import type { PluginResultEntry } from "../plugins/detector.ts";
import type {
  Address as AddressType,
  ArtifactChecksum as ArtifactChecksumType,
  BlockNumber as BlockNumberType,
  CacheKey as CacheKeyType,
  CodeHash as CodeHashType,
  IndexVersion as IndexVersionType,
  ModelVersion as ModelVersionType,
  Probability as ProbabilityType,
  RiskScore as RiskScoreType,
  TemplateVersion as TemplateVersionType,
  Timestamp as TimestampType,
} from "../domain/types.ts";

// Stored analysis result. The shape mirrors the assessed envelope from the
// application service field for field, so the service stores its envelope
// unchanged and serves a hit byte-identical to the original analysis
// (K-013, A-32). The key binds code hash and model version; the entry
// repeats both values so a read can reject an impersonating entry (M-14).
// Plugin findings travel in the additive `pluginResults` field beside the
// calibrated signals (S-043, P-11).
export type CachedAssessment = {
  readonly kind: "assessed";
  readonly target: AddressType;
  readonly block: BlockNumberType;
  readonly proxy: ProxyResolution;
  readonly codeHash: CodeHashType;
  readonly modelVersion: ModelVersionType;
  readonly artifactChecksum: ArtifactChecksumType;
  readonly indexVersion: IndexVersionType;
  readonly templateVersion: TemplateVersionType;
  readonly assessedAt: TimestampType;
  readonly probabilities: Readonly<Record<RiskType, ProbabilityType>>;
  readonly score: RiskScoreType;
  readonly signals: readonly Signal[];
  readonly pluginResults: readonly PluginResultEntry[];
  readonly explanation: Explanation;
  readonly cantTell: readonly CantTellItem[];
};

// Error union per A-15. A miss is a value (null), never an error: it gives
// a fresh analysis. entry-corrupt covers bytes that fail the boundary check
// at read (K-511) and gives a fresh analysis with a logged deviation;
// store-unavailable covers a store the adapter cannot reach and the service
// answers the same way, with the fast path standing on a miss.
export type CacheError =
  | { kind: "entry-corrupt"; message: string }
  | { kind: "store-unavailable"; message: string };

// Per-port limits per A-17. Values come from the operational configuration
// (I-08, I-14); the port only names the fields.
export type CacheLimits = {
  readonly deadlineMs: number;
  readonly maxBytesIn: number;
  readonly maxBytesOut: number;
  readonly maxConcurrency: number;
  readonly retryBudget: number;
};

export interface CachePort {
  get(key: CacheKeyType): Promise<Result<CachedAssessment | null, CacheError>>;
  put(key: CacheKeyType, value: CachedAssessment): Promise<Result<void, CacheError>>;
}
