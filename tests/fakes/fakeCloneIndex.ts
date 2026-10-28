// Fake CloneIndexPort for tests (A-23, K-017): in-memory template hits with
// call counts. The fake answers the configured hit for a code-hash or
// skeleton-hash key and null otherwise, so tests verify hit wiring, miss
// behaviour and error branches without touching the fixture table.
import { err, ok } from "../../src/domain/result.ts";
import type { Result } from "../../src/domain/result.ts";
import type { CodeHash as CodeHashType } from "../../src/domain/types.ts";
import type { IndexVersion as IndexVersionType } from "../../src/domain/types.ts";
import type { SkeletonHash as SkeletonHashType } from "../../src/domain/types.ts";
import type {
  CloneIndexError,
  CloneIndexPort,
  CloneMatch,
} from "../../src/ports/cloneIndex.ts";

function keyOf(codeHash: CodeHashType, skeletonHash: SkeletonHashType): string {
  return `${codeHash as string}|${skeletonHash as string}`;
}

export class FakeCloneIndexAdapter implements CloneIndexPort {
  readonly matchCalls: Array<{ codeHash: string; skeletonHash: string }> = [];

  private readonly version: IndexVersionType;
  private readonly hits: ReadonlyMap<string, CloneMatch>;
  private readonly failure: CloneIndexError | null;

  constructor(
    version: IndexVersionType,
    hits: ReadonlyMap<string, CloneMatch> = new Map(),
    failure: CloneIndexError | null = null,
  ) {
    this.version = version;
    this.hits = hits;
    this.failure = failure;
  }

  static keyFor(codeHash: CodeHashType, skeletonHash: SkeletonHashType): string {
    return keyOf(codeHash, skeletonHash);
  }

  match(
    codeHash: CodeHashType,
    skeletonHash: SkeletonHashType,
  ): Result<CloneMatch | null, CloneIndexError> {
    this.matchCalls.push({
      codeHash: codeHash as string,
      skeletonHash: skeletonHash as string,
    });
    if (this.failure !== null) {
      return err(this.failure);
    }
    return ok(this.hits.get(keyOf(codeHash, skeletonHash)) ?? null);
  }

  indexVersion(): IndexVersionType {
    return this.version;
  }
}
