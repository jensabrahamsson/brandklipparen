// File-backed ModelArtifactPort adapter with checksum verification
// (K-211, S-019, H-11, M-17). The adapter reads the frozen artifact file
// `artifact-<version>.json` from the configured directory, verifies its
// shape and SHA-256 checksum through the pure domain verifier and answers
// an unknown version, a changed byte or a malformed file with the typed
// branches in A-15, so scoring refuses to run with an unverified artifact.
// File reading is the adapter's only I/O; parsing and verification stay in
// src/domain/artifact.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import { verifyArtifactFile } from "../../domain/artifact.ts";
import type { ModelVersion as ModelVersionType } from "../../domain/types.ts";
import type {
  LoadedArtifact,
  ModelArtifactError,
  ModelArtifactPort,
} from "../../ports/modelArtifact.ts";

export class FileModelArtifactAdapter implements ModelArtifactPort {
  constructor(private readonly directory: string) {}

  load(version: ModelVersionType): Result<LoadedArtifact, ModelArtifactError> {
    const versionText = version as string;
    if (versionText.includes("/") || versionText.includes("\\") || versionText.includes("..")) {
      return err({ kind: "unknown-version", message: `unknown model version: ${versionText}` });
    }
    let raw: string;
    try {
      raw = readFileSync(join(this.directory, `artifact-${versionText}.json`), "utf8");
    } catch {
      return err({ kind: "unknown-version", message: `unknown model version: ${versionText}` });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return err({ kind: "artifact-malformed", message: `model artifact for ${versionText} is not valid JSON` });
    }
    const verified = verifyArtifactFile(parsed);
    if (!verified.ok) {
      if (verified.error.kind === "checksum-mismatch") {
        return err({ kind: "checksum-mismatch", message: verified.error.message });
      }
      return err({ kind: "artifact-malformed", message: verified.error.message });
    }
    if ((verified.value.artifact.version as string) !== versionText) {
      return err({ kind: "unknown-version", message: `unknown model version: ${versionText}` });
    }
    return ok({ artifact: verified.value.artifact, checksum: verified.value.checksum });
  }
}
