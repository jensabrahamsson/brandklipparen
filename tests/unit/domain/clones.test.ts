// Unit tests for clone matching (K-017, S-014): a hit links to signal
// evidence, a miss yields no clone signal. Written first per A-21 (red):
// the domain module src/domain/clones.ts does not exist yet, so these tests
// fail until the implementation lands. All bytecode is small hand-assembled
// synthetic sequences in this file; risk mappings below are placeholders
// for the tests only and production values come from the versioned model
// artifact per K-210 and A-20.
import { describe, expect, test } from "vitest";
import { cloneMatchSignal, matchCloneIndex } from "../../../src/domain/clones.ts";
import type { CloneTemplate } from "../../../src/domain/clones.ts";
import type { Result } from "../../../src/domain/result.ts";
import {
  Bytecode,
  CloneGroupId,
  CodeHash,
  Probability,
  Selector,
  SkeletonHash,
} from "../../../src/domain/types.ts";
import type { Bytecode as BytecodeType } from "../../../src/domain/types.ts";
import type { CodeHash as CodeHashType } from "../../../src/domain/types.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function mustCode(hex: string): BytecodeType {
  return mustOk(Bytecode.parse(hex));
}

function codeHashOf(code: BytecodeType): CodeHashType {
  return mustOk(CodeHash.of(code));
}

// Dispatcher window for 0xa9059cbb with jump target 10, then JUMPDEST,
// SELFDESTRUCT and STOP: the synthetic trap template for the tests.
const TEMPLATE_CODE = "0x8063a9059cbb14600a575bff00";

// Same opcode skeleton with different PUSH operands: the code hash differs
// while the skeleton hash matches the template below.
const SKELETON_VARIANT_CODE = "0x806370a0823114600a575b60025500";
const SKELETON_TEMPLATE_CODE = "0x806370a0823114600a575b60005500";

function templateFor(
  hex: string,
  group: string,
  priorCount: number,
  skeletonSimilarity: number,
): CloneTemplate {
  const code = mustCode(hex);
  return Object.freeze({
    group: mustOk(CloneGroupId.parse(group)),
    codeHash: mustOk(CodeHash.of(code)),
    skeletonHash: mustOk(SkeletonHash.of(code)),
    priorCount,
    skeletonSimilarity: mustOk(Probability.of(skeletonSimilarity)),
  });
}

const MAPPING = Object.freeze({
  risk: "honeypot",
  direction: "raises",
  severity: "high",
} as const);

describe("k017 clone matching", () => {
  test("k017_clone_hit_linked_as_signal_evidence", () => {
    const code = mustCode(TEMPLATE_CODE);
    const templates = [templateFor(TEMPLATE_CODE, "trap-fixed-fee", 3, 0.75)];
    const hit = matchCloneIndex({
      codeHash: codeHashOf(code),
      skeletonHash: mustOk(SkeletonHash.of(code)),
      templates,
    });
    expect(hit).not.toBe(null);
    if (hit === null) {
      throw new Error("expected a clone hit");
    }
    expect(hit.similarity as number).toBe(1);
    expect(hit.group as string).toBe("trap-fixed-fee");
    expect(hit.priorCount).toBe(3);
    const signal = cloneMatchSignal({ codeHash: codeHashOf(code), bytecode: code, hit, mapping: MAPPING });
    expect(signal).not.toBe(null);
    if (signal === null) {
      throw new Error("expected a clone-match signal");
    }
    expect(signal.kind).toBe("clone-match");
    if (signal.kind !== "clone-match") {
      throw new Error("expected a clone-match signal");
    }
    expect(signal.group as string).toBe("trap-fixed-fee");
    expect(signal.priorCount).toBe(3);
    expect(signal.evidence.length).toBeGreaterThan(0);
    expect(signal.evidence[0]?.selector).toBe("0xa9059cbb");
    expect(signal.evidence[0]?.offset).toBe(10);
  });

  test("k017_skeleton_hit_reports_template_similarity_with_evidence", () => {
    const code = mustCode(SKELETON_VARIANT_CODE);
    const templates = [templateFor(SKELETON_TEMPLATE_CODE, "trap-mint-gate", 7, 0.75)];
    const hit = matchCloneIndex({
      codeHash: codeHashOf(code),
      skeletonHash: mustOk(SkeletonHash.of(code)),
      templates,
    });
    expect(hit).not.toBe(null);
    if (hit === null) {
      throw new Error("expected a skeleton hit");
    }
    expect(hit.similarity as number).toBe(0.75);
    expect(hit.group as string).toBe("trap-mint-gate");
    expect(hit.priorCount).toBe(7);
    const signal = cloneMatchSignal({ codeHash: codeHashOf(code), bytecode: code, hit, mapping: MAPPING });
    expect(signal).not.toBe(null);
  });

  test("k017_clone_miss_yields_no_hit_and_no_signal", () => {
    const code = mustCode("0x8063deadbeef14600a575b00");
    const templates = [templateFor(TEMPLATE_CODE, "trap-fixed-fee", 3, 0.75)];
    const hit = matchCloneIndex({
      codeHash: codeHashOf(code),
      skeletonHash: mustOk(SkeletonHash.of(code)),
      templates,
    });
    expect(hit).toBe(null);
  });

  test("k017_bytecode_without_selectors_yields_no_signal", () => {
    const code = mustCode("0x6001600055");
    const templates = [templateFor(TEMPLATE_CODE, "trap-fixed-fee", 3, 0.75)];
    const forced = {
      similarity: mustOk(Probability.of(1)),
      group: mustOk(CloneGroupId.parse("trap-fixed-fee")),
      priorCount: 3,
    };
    expect(templates.length).toBeGreaterThan(0);
    const signal = cloneMatchSignal({ codeHash: codeHashOf(code), bytecode: code, hit: forced, mapping: MAPPING });
    expect(signal).toBe(null);
  });

  test("k017_selector_parses_for_template_constructors", () => {
    expect(mustOk(Selector.parse("0xa9059cbb"))).toBe("0xa9059cbb");
  });
});
