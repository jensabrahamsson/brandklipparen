// Contract test for the real clone index adapter (A-22, A-23, K-017, S-014).
// The adapter loads the placeholder fixture table, so the shared suite pins
// the same outcomes as the fake: a code-hash hit, a skeleton-hash hit, a
// miss for unknown hashes and the stated index version.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { Bytecode, CloneGroupId, CodeHash, IndexVersion, SkeletonHash } from "../../src/domain/types.ts";
import type { Result } from "../../src/domain/result.ts";
import type { Bytecode as BytecodeType } from "../../src/domain/types.ts";
import type { CodeHash as CodeHashType } from "../../src/domain/types.ts";
import type { SkeletonHash as SkeletonHashType } from "../../src/domain/types.ts";
import { CloneIndexAdapter } from "../../src/adapters/clones/cloneIndex.ts";
import { runCloneIndexPortContract } from "./cloneIndex.contract.ts";

const here = dirname(fileURLToPath(import.meta.url));

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function mustCode(hex: string): BytecodeType {
  return mustOk(Bytecode.parse(hex));
}

function hashesOf(hex: string): { codeHash: CodeHashType; skeletonHash: SkeletonHashType } {
  const code = mustCode(hex);
  return { codeHash: mustOk(CodeHash.of(code)), skeletonHash: mustOk(SkeletonHash.of(code)) };
}

const OTHER_CODE = "0x8063deadbeef14600a575b00";
const TEMPLATE_A_CODE = "0x8063a9059cbb14600a575bff00";

function loadFixture(): unknown {
  return JSON.parse(
    readFileSync(join(here, "..", "fixtures", "clones", "trap-templates.json"), "utf8"),
  ) as unknown;
}

function mustAdapter(): CloneIndexAdapter {
  const created = CloneIndexAdapter.create(loadFixture());
  if (!created.ok) {
    throw new Error(`expected the fixture table to load: ${created.error.message}`);
  }
  return created.value;
}

describe("clone index adapter contract", () => {
  const template = hashesOf(TEMPLATE_A_CODE);
  const other = hashesOf(OTHER_CODE);

  runCloneIndexPortContract({
    makePort: mustAdapter,
    version: mustOk(IndexVersion.parse("1.0.0")),
    codeHash: template.codeHash,
    skeletonHash: template.skeletonHash,
    otherCodeHash: other.codeHash,
    otherSkeletonHash: other.skeletonHash,
    group: mustOk(CloneGroupId.parse("trap-fixed-fee")),
    priorCount: 3,
  });

  test("malformed_table_fails_with_index_unavailable", () => {
    const created = CloneIndexAdapter.create({ version: "1.0.0", templates: "nope" });
    expect(created.ok).toBe(false);
  });
});
