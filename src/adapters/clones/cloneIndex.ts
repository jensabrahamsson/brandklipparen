// In-memory CloneIndexPort adapter over a frozen placeholder template table
// (S-014, K-017, A-05). The table arrives as parsed JSON through the static
// factory, which validates the shape at the boundary (A-16) and derives code
// hashes and skeleton hashes through the domain constructors, so the fixture
// stays auditable as bytecode. Matching is an exact hash lookup through the
// pure domain function; a miss yields null and the analysis continues
// without a clone signal. All template values are synthetic placeholders
// with no predictive meaning; production values arrive through the
// versioned calibration chain per K-210 and A-20.
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import { matchCloneIndex } from "../../domain/clones.ts";
import type { CloneTemplate } from "../../domain/clones.ts";
import { Bytecode, CloneGroupId, CodeHash, IndexVersion, Probability, SkeletonHash } from "../../domain/types.ts";
import type {
  CodeHash as CodeHashType,
  IndexVersion as IndexVersionType,
  SkeletonHash as SkeletonHashType,
} from "../../domain/types.ts";
import type { CloneIndexError, CloneIndexPort, CloneMatch } from "../../ports/cloneIndex.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTemplate(entry: unknown): CloneTemplate | null {
  if (!isRecord(entry)) {
    return null;
  }
  const group = typeof entry["group"] === "string" ? CloneGroupId.parse(entry["group"]) : null;
  if (group === null || !group.ok) {
    return null;
  }
  const priorCount = entry["priorCount"];
  if (typeof priorCount !== "number" || !Number.isInteger(priorCount) || priorCount < 0) {
    return null;
  }
  const bytecode = typeof entry["bytecode"] === "string" ? Bytecode.parse(entry["bytecode"]) : null;
  if (bytecode === null || !bytecode.ok) {
    return null;
  }
  const similarity =
    typeof entry["skeletonSimilarity"] === "number" ? Probability.of(entry["skeletonSimilarity"]) : null;
  if (similarity === null || !similarity.ok) {
    return null;
  }
  const codeHash = CodeHash.of(bytecode.value);
  if (!codeHash.ok) {
    return null;
  }
  const skeletonHash = SkeletonHash.of(bytecode.value);
  if (!skeletonHash.ok) {
    return null;
  }
  return Object.freeze({
    group: group.value,
    codeHash: codeHash.value,
    skeletonHash: skeletonHash.value,
    priorCount,
    skeletonSimilarity: similarity.value,
  });
}

export class CloneIndexAdapter implements CloneIndexPort {
  private constructor(
    private readonly version: IndexVersionType,
    private readonly templates: readonly CloneTemplate[],
  ) {}

  // Boundary-validated construction (A-16): a malformed table yields the
  // index-unavailable branch, and a table whose version differs from the
  // configured clone index version yields index-version-mismatch.
  static create(input: unknown, expectedVersion?: IndexVersionType): Result<CloneIndexAdapter, CloneIndexError> {
    if (!isRecord(input)) {
      return err({ kind: "index-unavailable", message: "clone template table must be an object" });
    }
    const version = typeof input["version"] === "string" ? IndexVersion.parse(input["version"]) : null;
    if (version === null || !version.ok) {
      return err({ kind: "index-unavailable", message: "clone template table version must be semver MAJOR.MINOR.PATCH" });
    }
    if (expectedVersion !== undefined && (version.value as string) !== (expectedVersion as string)) {
      return err({
        kind: "index-version-mismatch",
        message: `clone template table version ${(version.value as string)} differs from the configured version`,
      });
    }
    if (!Array.isArray(input["templates"])) {
      return err({ kind: "index-unavailable", message: "clone template table must carry a templates array" });
    }
    const templates: CloneTemplate[] = [];
    for (const entry of input["templates"]) {
      const parsed = parseTemplate(entry);
      if (parsed === null) {
        return err({ kind: "index-unavailable", message: "clone template table holds an invalid template entry" });
      }
      templates.push(parsed);
    }
    templates.sort((left, right) => {
      const leftGroup = left.group as string;
      const rightGroup = right.group as string;
      if (leftGroup < rightGroup) {
        return -1;
      }
      if (leftGroup > rightGroup) {
        return 1;
      }
      return 0;
    });
    return ok(new CloneIndexAdapter(version.value, Object.freeze(templates)));
  }

  match(
    codeHash: CodeHashType,
    skeletonHash: SkeletonHashType,
  ): Result<CloneMatch | null, CloneIndexError> {
    const hit = matchCloneIndex({ codeHash, skeletonHash, templates: this.templates });
    if (hit === null) {
      return ok(null);
    }
    return ok(
      Object.freeze({ similarity: hit.similarity, group: hit.group, priorCount: hit.priorCount }),
    );
  }

  indexVersion(): IndexVersionType {
    return this.version;
  }
}
