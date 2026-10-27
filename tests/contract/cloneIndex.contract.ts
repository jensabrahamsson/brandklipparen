// Shared contract suite for CloneIndexPort (A-22, A-23, K-017, S-014).
// The suite runs unchanged against the fake and the real adapter with equal
// outcomes: a code-hash hit reports similarity 1 with group and count, a
// skeleton-hash hit reports the template similarity, unknown hashes yield a
// miss, and the index version is stated for reproduction per K-102.
import { describe, expect, test } from "vitest";
import type { CloneIndexPort } from "../../src/ports/cloneIndex.ts";
import type { CloneGroupId as CloneGroupIdType } from "../../src/domain/types.ts";
import type { CodeHash as CodeHashType } from "../../src/domain/types.ts";
import type { IndexVersion as IndexVersionType } from "../../src/domain/types.ts";
import type { SkeletonHash as SkeletonHashType } from "../../src/domain/types.ts";

export type CloneIndexContractFixture = {
  readonly makePort: () => CloneIndexPort;
  readonly version: IndexVersionType;
  readonly codeHash: CodeHashType;
  readonly skeletonHash: SkeletonHashType;
  readonly otherCodeHash: CodeHashType;
  readonly otherSkeletonHash: SkeletonHashType;
  readonly group: CloneGroupIdType;
  readonly priorCount: number;
};

export function runCloneIndexPortContract(fixture: CloneIndexContractFixture): void {
  describe("CloneIndexPort contract", () => {
    test("code_hash_hit_reports_similarity_group_and_count", () => {
      const port = fixture.makePort();
      const matched = port.match(fixture.codeHash, fixture.otherSkeletonHash);
      expect(matched.ok).toBe(true);
      if (!matched.ok || matched.value === null) {
        throw new Error("expected a clone hit for the known code hash");
      }
      expect(matched.value.similarity as number).toBe(1);
      expect(matched.value.group as string).toBe(fixture.group as string);
      expect(matched.value.priorCount).toBe(fixture.priorCount);
    });

    test("skeleton_hash_hit_reports_template_similarity_group_and_count", () => {
      const port = fixture.makePort();
      const matched = port.match(fixture.otherCodeHash, fixture.skeletonHash);
      expect(matched.ok).toBe(true);
      if (!matched.ok || matched.value === null) {
        throw new Error("expected a clone hit for the known skeleton hash");
      }
      expect(matched.value.similarity as number).toBeGreaterThan(0);
      expect(matched.value.similarity as number).toBeLessThanOrEqual(1);
      expect(matched.value.group as string).toBe(fixture.group as string);
      expect(matched.value.priorCount).toBe(fixture.priorCount);
    });

    test("unknown_hashes_yield_a_miss", () => {
      const port = fixture.makePort();
      const matched = port.match(fixture.otherCodeHash, fixture.otherSkeletonHash);
      expect(matched.ok).toBe(true);
      if (!matched.ok) {
        throw new Error("expected a result, not an error");
      }
      expect(matched.value).toBe(null);
    });

    test("port_names_the_index_version", () => {
      const port = fixture.makePort();
      expect(port.indexVersion() as string).toBe(fixture.version as string);
    });
  });
}
