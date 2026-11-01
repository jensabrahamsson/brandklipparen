// Coverage truth (C-26, F-26): budget hits, capped reaches and throws
// must surface as `complete: false` instead of reading as "nothing
// found". Synthetic bytecode only; no network happens here.
import { describe, expect, test } from "vitest";
import { buildCfg, lift, resolveEntryReachV2 } from "../../../src/domain/evmLift.ts";
import type { Result } from "../../../src/domain/result.ts";
import {
  analyzeOwnerControl,
  coverageOf,
  interpretRegionExprs,
} from "../../../src/domain/ownerControl.ts";
import { Bytecode, Selector } from "../../../src/domain/types.ts";
import type { Bytecode as BytecodeType } from "../../../src/domain/types.ts";
import { explainExtendedProof } from "../../../src/plugins/detectors/extendedProof.ts";
import { Asm } from "../../helpers/evmAsm.ts";

function mustOk<T>(result: Result<T, { message: string }>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function bytecodeOf(hex: string): BytecodeType {
  return mustOk(Bytecode.parse(hex));
}

const CHAIN_SELECTOR = mustOk(Selector.parse("0x12345678"));

// Seventeen dead JUMPDEST constants plus the shared helper visible from
// one raw entry: the same overflow shape as the p10 v2 cap fixture. The
// shared return stays unresolved past the per-jump cap of sixteen.
function cappedShape(): { hex: string; entryPc: number } {
  const asm = new Asm();
  asm.label("entry");
  const entryPc = asm.pc;
  asm.op(0x5b);
  const dead: string[] = [];
  for (let index = 1; index <= 17; index += 1) {
    const name = `dead${index.toString().padStart(2, "0")}`;
    dead.push(name);
    asm.pushLabel2(name);
  }
  asm.pushLabel2("shared");
  asm.op(0x56);
  asm.label("shared");
  asm.op(0x5b);
  asm.push1(0x01).push1(0x02).op(0x01);
  asm.op(0x56);
  asm.op(0xfe);
  for (const name of dead) {
    asm.label(name).op(0x5b, 0x00);
  }
  return { hex: asm.build(), entryPc };
}

// One internal call through a shared helper: two return continuations at
// most, so the return resolves and the reach stays complete.
function singleCallShape(): { hex: string; entryPc: number } {
  const asm = new Asm();
  asm.label("entry");
  const entryPc = asm.pc;
  asm.op(0x5b);
  asm.pushLabel2("ret");
  asm.pushLabel2("shared");
  asm.op(0x56);
  asm.label("shared");
  asm.op(0x5b);
  asm.push1(0x01).push1(0x02).op(0x01);
  asm.op(0x56);
  asm.op(0xfe);
  asm.label("ret").op(0x5b, 0x00);
  return { hex: asm.build(), entryPc };
}

function reachOf(hex: string, entryPc: number) {
  const code = bytecodeOf(hex);
  const cfg = buildCfg(lift(code));
  const entryBlock = cfg.blocks.find((block) => block.range.startPc === entryPc);
  if (entryBlock === undefined) {
    throw new Error("expected an entry block");
  }
  return resolveEntryReachV2(cfg, entryBlock.index);
}

describe("coverage truth (C-26)", () => {
  test("c26_reach_cap_marks_incomplete", () => {
    const capped = cappedShape();
    expect(reachOf(capped.hex, capped.entryPc).complete).toBe(false);
    const single = singleCallShape();
    expect(reachOf(single.hex, single.entryPc).complete).toBe(true);
  });

  test("c26_interpreter_reach_cap_marks_incomplete", () => {
    // One dispatcher entry whose region holds the capped shape: eighteen
    // JUMPDEST constants against a cap of sixteen, so the entry reach
    // gives up and the interpreter result is incomplete.
    const asm = new Asm();
    asm.op(0x80).push4("12345678").op(0x14);
    asm.pushLabel2("entry").op(0x57);
    asm.label("fallback").op(0x5b).push1(0x00).op(0x80, 0xfd);
    asm.label("entry").op(0x5b);
    for (let index = 0; index < 17; index += 1) {
      asm.pushLabel2(`dead${index}`);
    }
    asm.pushLabel2("shared").op(0x56);
    asm.label("shared").op(0x5b).push1(0x01).push1(0x02).op(0x01);
    asm.op(0x56);
    asm.op(0xfe);
    for (let index = 0; index < 17; index += 1) {
      asm.label(`dead${index}`).op(0x5b, 0x00);
    }
    const code = bytecodeOf(asm.build());
    expect(interpretRegionExprs(code, CHAIN_SELECTOR).complete).toBe(false);
    expect(analyzeOwnerControl(code, { reach: "v2" }).incompleteSelectors).toEqual([
      CHAIN_SELECTOR,
    ]);
    expect(coverageOf(code)).toEqual({ followed: 0, total: 1 });
  });

  test("c26_interpreter_budget_marks_incomplete", () => {
    // One selector region holding a proven chain longer than the visit
    // budget: every block is followed, but the queue is still non-empty
    // at the cap, so the result is partial and marked incomplete.
    const asm = new Asm();
    asm.op(0x80).push4("12345678").op(0x14);
    asm.pushLabel2("entry").op(0x57);
    asm.label("fallback").op(0x5b).push1(0x00).op(0x80, 0xfd);
    asm.label("entry").op(0x5b);
    const links = 4200;
    for (let index = 0; index < links; index += 1) {
      asm.pushLabel2(`link${index + 1}`);
      asm.op(0x56);
      asm.label(`link${index + 1}`).op(0x5b);
    }
    asm.op(0x00);
    const code = bytecodeOf(asm.build());
    expect(interpretRegionExprs(code, CHAIN_SELECTOR).complete).toBe(false);
    expect(analyzeOwnerControl(code, { reach: "v2" }).incompleteSelectors).toEqual([
      CHAIN_SELECTOR,
    ]);
    expect(coverageOf(code)).toEqual({ followed: 0, total: 1 });
    // A failing proof over truncated code names the budget instead of a
    // proven absence.
    const proofs = explainExtendedProof(code);
    expect(proofs.length).toBe(5);
    for (const proof of proofs) {
      expect(proof.steps.some((entry) => !entry.ok)).toBe(true);
      const budget = proof.steps.find((entry) => entry.step === "analysis-budget");
      expect(budget?.ok).toBe(false);
      expect(budget?.detail).toBe("stopped at the visit budget");
    }
  });

  test("c26_complete_region_has_no_budget_step", () => {
    // Small guarded region: fully followed, so proofs carry no
    // analysis-budget step and coverage counts the function as followed.
    const asm = new Asm();
    asm.op(0x80).push4("12345678").op(0x14);
    asm.pushLabel2("entry").op(0x57);
    asm.label("fallback").op(0x5b).push1(0x00).op(0x80, 0xfd);
    asm.label("entry").op(0x5b).push1(0x00);
    asm.op(0x55, 0x00);
    const code = bytecodeOf(asm.build());
    expect(interpretRegionExprs(code, CHAIN_SELECTOR).complete).toBe(true);
    expect(analyzeOwnerControl(code, { reach: "v2" }).incompleteSelectors).toEqual([]);
    expect(coverageOf(code)).toEqual({ followed: 1, total: 1 });
    for (const proof of explainExtendedProof(code)) {
      expect(proof.steps.some((entry) => entry.step === "analysis-budget")).toBe(false);
    }
  });
});
