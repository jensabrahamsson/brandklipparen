// Fake ModelArtifactPort for tests (A-23, K-210): returns one frozen artifact
// with its checksum, or the typed unknown-version branch for other versions.
// Production values come from the versioned model artifact; tests carry a
// small synthetic placeholder with no predictive meaning.
import { err, ok } from "../../src/domain/result.ts";
import type { Result } from "../../src/domain/result.ts";
import type { ModelVersion as ModelVersionType } from "../../src/domain/types.ts";
import type {
  LoadedArtifact,
  ModelArtifactError,
  ModelArtifactPort,
} from "../../src/ports/modelArtifact.ts";

export class FakeModelArtifactAdapter implements ModelArtifactPort {
  loadCalls = 0;

  constructor(private readonly loaded: LoadedArtifact) {}

  load(version: ModelVersionType): Result<LoadedArtifact, ModelArtifactError> {
    this.loadCalls += 1;
    if ((version as string) !== (this.loaded.artifact.version as string)) {
      return err({ kind: "unknown-version", message: `unknown model version: ${version as string}` });
    }
    return ok(this.loaded);
  }
}
