// CloneIndexPort: code-hash and skeleton-hash matching against known trap
// templates (A-05, K-017, K-511). The port is owned by the core: the
// application service calls match in the fast path and turns a hit into a
// clone-match signal with evidence, while a miss yields no clone signal and
// the analysis continues without one. Error branches follow the catalogue
// in A-15: the service continues without a clone signal on either branch.
// The similarity for an exact code-hash hit is always 1; the similarity for
// a skeleton-hash hit is the placeholder value carried by the matched
// template entry. All template values are synthetic placeholders with no
// predictive meaning; production values arrive through the versioned
// calibration chain per K-210 and A-20.
import type { Result } from "../domain/result.ts";
import type {
  CloneGroupId as CloneGroupIdType,
  CodeHash as CodeHashType,
  IndexVersion as IndexVersionType,
  Probability as ProbabilityType,
  SkeletonHash as SkeletonHashType,
} from "../domain/types.ts";

// One template hit: the similarity share beside the mandatory group id and
// the number of earlier tokens in the group (K-017).
export type CloneMatch = {
  readonly similarity: ProbabilityType;
  readonly group: CloneGroupIdType;
  readonly priorCount: number;
};

// Error union per A-15. index-unavailable covers a table the adapter cannot
// read or validate; index-version-mismatch covers a table whose version
// differs from the configured clone index version.
export type CloneIndexError =
  | { kind: "index-unavailable"; message: string }
  | { kind: "index-version-mismatch"; message: string };

// Per-port limits per A-17. Values come from the operational configuration
// (I-08, I-14); the port only names the fields.
export type CloneIndexLimits = {
  readonly deadlineMs: number;
  readonly maxBytesIn: number;
  readonly maxBytesOut: number;
  readonly maxConcurrency: number;
  readonly retryBudget: number;
};

export interface CloneIndexPort {
  match(
    codeHash: CodeHashType,
    skeletonHash: SkeletonHashType,
  ): Result<CloneMatch | null, CloneIndexError>;
  indexVersion(): IndexVersionType;
}
