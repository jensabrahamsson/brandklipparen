// Contract test for the fake CloneIndexPort (A-22, A-23, K-017, S-014).
// The fake serves one synthetic template entry, so the shared suite pins the
// same outcomes the real adapter must give.
import { describe, test } from "vitest";
import { Bytecode, CloneGroupId, CodeHash, IndexVersion, Probability, SkeletonHash } from "../../src/domain/types.ts";
import type { Result } from "../../src/domain/result.ts";
import type { Bytecode as BytecodeType } from "../../src/domain/types.ts";
import type { CodeHash as CodeHashType } from "../../src/domain/types.ts";
import type { SkeletonHash as SkeletonHashType } from "../../src/domain/types.ts";
import type { CloneMatch } from "../../src/ports/cloneIndex.ts";
import { FakeCloneIndexAdapter } from "../fakes/fakeCloneIndex.ts";
import { runCloneIndexPortContract } from "./cloneIndex.contract.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function mustCode(hex: string): BytecodeType {
  return mustOk(Bytecode.parse(hex));
}

const TEMPLATE_CODE = "0x8063a9059cbb14600a575bff00";
const OTHER_CODE = "0x8063deadbeef14600a575b00";

const GROUP = mustOk(CloneGroupId.parse("trap-fixed-fee"));
const VERSION = mustOk(IndexVersion.parse("1.0.0"));

function hashesOf(hex: string): { codeHash: CodeHashType; skeletonHash: SkeletonHashType } {
  const code = mustCode(hex);
  return { codeHash: mustOk(CodeHash.of(code)), skeletonHash: mustOk(SkeletonHash.of(code)) };
}

describe("fake clone index contract", () => {
  const template = hashesOf(TEMPLATE_CODE);
  const other = hashesOf(OTHER_CODE);
  const hit: CloneMatch = Object.freeze({
    similarity: mustOk(Probability.of(1)),
    group: GROUP,
    priorCount: 3,
  });
  const skeletonHit: CloneMatch = Object.freeze({
    similarity: mustOk(Probability.of(0.75)),
    group: GROUP,
    priorCount: 3,
  });
  const hits = new Map<string, CloneMatch>([
    [FakeCloneIndexAdapter.keyFor(template.codeHash, other.skeletonHash), hit],
    [FakeCloneIndexAdapter.keyFor(other.codeHash, template.skeletonHash), skeletonHit],
  ]);

  runCloneIndexPortContract({
    makePort: () => new FakeCloneIndexAdapter(VERSION, hits),
    version: VERSION,
    codeHash: template.codeHash,
    skeletonHash: template.skeletonHash,
    otherCodeHash: other.codeHash,
    otherSkeletonHash: other.skeletonHash,
    group: GROUP,
    priorCount: 3,
  });

  test("fake_counts_match_calls", () => {
    const port = new FakeCloneIndexAdapter(VERSION, hits);
    port.match(template.codeHash, template.skeletonHash);
    if (port.matchCalls.length !== 1) {
      throw new Error("expected one counted match call");
    }
  });
});
