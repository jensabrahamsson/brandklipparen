// ModelArtifactPort: loading and checksum verification of the versioned
// model artifact (A-05, K-011, K-210, K-211). The artifact carries the learned
// thresholds, weights and limits; the port verifies the checksum at load and
// answers an unknown version or a wrong checksum with the branches in A-15.
// A new model version keys new cache entries, so older entries stay unused.
import type { Result } from "../domain/result.ts";
import type { ModelArtifact } from "../domain/risk.ts";
import type {
  ArtifactChecksum as ArtifactChecksumType,
  ModelVersion as ModelVersionType,
} from "../domain/types.ts";

// Error union per A-15. A startup failure names the latest valid model
// version in the surrounding configuration, never inside this union.
export type ModelArtifactError =
  | { kind: "unknown-version"; message: string }
  | { kind: "checksum-mismatch"; message: string }
  | { kind: "artifact-malformed"; message: string };

// The loaded artifact beside its verified SHA-256 checksum (A-20): the
// response in every interface states the model version, and the checksum
// travels in the reproduction fields per A-32 point 7.
export type LoadedArtifact = {
  readonly artifact: ModelArtifact;
  readonly checksum: ArtifactChecksumType;
};

export interface ModelArtifactPort {
  load(version: ModelVersionType): Result<LoadedArtifact, ModelArtifactError>;
}
