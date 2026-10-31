// P-10e expression owner check and the reverting side on real compiler
// output. Synthetic hand-assembled fixtures only; no network, no real
// addresses. An exact old-solc 0.4.x onlyOwner inline modifier proves a
// guarded writer through expression matching (the linear window never
// spans the 70-byte guard), and an OZ-4-shaped onlyOwner check through
// the `owner()` and `_msgSender()` internal functions proves a guarded
// writer whose failing side builds Error(string) and reverts through a
// shared encoding helper. The transfer gate reverts through its own
// helper, so only the bounded reverting-side path proves it. Negatives
// with no EQ against CALLER stay silent, fast-check never throws, and
// the v1 view stays unchanged.
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { Bytecode, CodeHash, Selector } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import {
  REVERTING_SIDE_MAX_BLOCKS,
  analyzeOwnerControl,
  hasOwnerCallerCheck,
  hasRevertingSide,
  interpretRegionExprs,
  ownerCheckExpr,
} from "../../../src/domain/ownerControl.ts";
import type { Expr } from "../../../src/domain/ownerControl.ts";
import { attributeFunctions } from "../../../src/domain/evmFlow.ts";
import { buildCfg, lift, resolveEntryReachV2 } from "../../../src/domain/evmLift.ts";
import { disassemble } from "../../../src/domain/selectors.ts";
import { pauseDetectorPlugin } from "../../../src/plugins/detectors/pause/index.ts";
import { blacklistDetectorPlugin } from "../../../src/plugins/detectors/blacklist/index.ts";
import { explainExtendedProof } from "../../../src/plugins/detectors/extendedProof.ts";
import { Asm } from "../../helpers/evmAsm.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function mustSelector(raw: string) {
  return mustOk(Selector.parse(raw));
}

function inputForHex(hex: string): DetectorInput {
  const parsed = mustOk(Bytecode.parse(hex));
  return Object.freeze({ bytecode: parsed, codeHash: mustOk(CodeHash.of(parsed)) });
}

const TRANSFER_SELECTOR = "0xa9059cbb";
const PAUSE_SET_SELECTOR = "0x0e0e0e0e";
const OZ_SET_SELECTOR = "0x0b0b0b0b";

const MASK20: readonly number[] = Object.freeze(new Array<number>(20).fill(0xff));

function oldSolcGuardSeq(callerOpcode: number): number[] {
  return [
    0x5b, 0x60, 0x00, 0x80, 0x90, 0x54, 0x90, 0x61, 0x01, 0x00, 0x0a, 0x90, 0x04,
    0x73, ...MASK20, 0x16, 0x73, ...MASK20, 0x16, callerOpcode, 0x73, ...MASK20, 0x16,
    0x14, 0x15, 0x15,
  ];
}

function oldSolcPackedWriteSeq(): number[] {
  return [
    0x60, 0x01, 0x60, 0x00, 0x60, 0x14, 0x61, 0x01, 0x00, 0x0a, 0x81, 0x54, 0x81,
    0x60, 0xff, 0x02, 0x19, 0x16, 0x90, 0x83, 0x15, 0x15, 0x02, 0x17, 0x90, 0x55,
  ];
}

// Fixture A: the exact old-solc 0.4.x onlyOwner inline modifier sequence
// with a following packed pause write to slot 0 bit 160, plus a transfer
// path gating on the same bit. The caller side uses `callerOpcode`
// (CALLER in the positive, CALLDATALOAD in the negative).
function fixtureAHex(callerOpcode: number): string {
  const asm = new Asm();
  asm.op(0x80).push4(TRANSFER_SELECTOR).op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4(PAUSE_SET_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("setEntry").op(0x57);
  asm.label("fallback").op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("transferEntry").op(0x5b);
  asm.op(0x60, 0x00, 0x54, 0x60, 0x14, 0x61, 0x01, 0x00, 0x0a, 0x04, 0x60, 0xff, 0x16, 0x15);
  asm.pushLabel2("tokA").op(0x57);
  asm.op(0x60, 0x00, 0x80, 0xfd);
  asm.label("tokA").op(0x5b);
  asm.op(0x35, 0x60, 0x02, 0x55, 0x00);
  asm.label("setEntry").op(...oldSolcGuardSeq(callerOpcode));
  asm.pushLabel2("okA").op(0x57);
  asm.op(0x60, 0x00, 0x80, 0xfd);
  asm.label("okA").op(0x5b, ...oldSolcPackedWriteSeq());
  asm.op(0x00);
  return asm.build();
}

// Fixture B: the OZ-4 `_checkOwner` shape. The setter calls the
// `owner()` and `_msgSender()` internal functions (the mask is built as
// PUSH1 1, PUSH1 1, PUSH1 0xa0, SHL, SUB), compares the results, and its
// failing side builds Error(string) before reverting through a shared
// encoding helper. The transfer gate reverts through its own helper.
// The sender side uses `senderOpcode` (CALLER in the positive,
// CALLDATALOAD in the negative).
function fixtureBHex(senderOpcode: number): string {
  const asm = new Asm();
  asm.op(0x80).push4(TRANSFER_SELECTOR).op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4(OZ_SET_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("setEntry").op(0x57);
  asm.label("fallback").op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("transferEntry").op(0x5b);
  asm.op(0x35).push1(0x00).op(0x52);
  asm.push1(0x07).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x54, 0x15);
  asm.pushLabel2("gateOk").op(0x57);
  asm.pushLabel2("gateHelper").op(0x56);
  asm.label("gateOk").op(0x5b);
  asm.op(0x60, 0x01, 0x60, 0x02, 0x55, 0x00);
  asm.label("gateHelper").op(0x5b);
  asm.pushLabel2("gateHelper2").op(0x56);
  asm.label("gateHelper2").op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("setEntry").op(0x5b);
  asm.pushLabel2("retOwner").pushLabel2("funcOwner").op(0x56);
  asm.label("retOwner").op(0x5b);
  asm.pushLabel2("retSender").pushLabel2("funcSender").op(0x56);
  asm.label("retSender").op(0x5b);
  asm.op(0x14, 0x15);
  asm.pushLabel2("revertBuild").op(0x57);
  asm.op(0x35, 0x35).push1(0x00).op(0x52);
  asm.push1(0x07).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x55, 0x00);
  asm.label("revertBuild").op(0x5b);
  asm.op(0x60, 0x40, 0x51, 0x62, 0x46, 0x1b, 0xcd, 0x60, 0xe5, 0x1b);
  asm.op(0x60, 0x00, 0x52, 0x60, 0x20, 0x52);
  asm.pushLabel2("errHelper").op(0x56);
  asm.label("errHelper").op(0x5b);
  asm.pushLabel2("errHelper2").op(0x56);
  asm.label("errHelper2").op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("funcOwner").op(0x5b);
  asm.op(0x60, 0x00, 0x54);
  asm.op(0x60, 0x01, 0x60, 0x01, 0x60, 0xa0, 0x1b, 0x03, 0x16, 0x90, 0x56);
  asm.label("funcSender").op(0x5b);
  asm.op(senderOpcode);
  asm.op(0x60, 0x01, 0x60, 0x01, 0x60, 0xa0, 0x1b, 0x03, 0x16, 0x90, 0x56);
  asm.label("endPad").op(0x5b, 0xfe);
  return asm.build();
}

function exprDepth(expr: Expr): number {
  if (expr.kind === "const" || expr.kind === "caller" || expr.kind === "callvalue" || expr.kind === "unknown") {
    return 0;
  }
  if (expr.kind === "calldata") {
    return 1 + exprDepth(expr.offset);
  }
  if (expr.kind === "sload") {
    return 1 + exprDepth(expr.slot);
  }
  if (expr.kind === "keccak") {
    return 1 + Math.max(0, ...expr.words.map((word) => exprDepth(word)));
  }
  return 1 + Math.max(0, ...expr.args.map((arg) => exprDepth(arg)));
}

function exprNodes(expr: Expr): number {
  if (expr.kind === "const" || expr.kind === "caller" || expr.kind === "callvalue" || expr.kind === "unknown") {
    return 1;
  }
  if (expr.kind === "calldata") {
    return 1 + exprNodes(expr.offset);
  }
  if (expr.kind === "sload") {
    return 1 + exprNodes(expr.slot);
  }
  if (expr.kind === "keccak") {
    return 1 + expr.words.reduce((total, word) => total + exprNodes(word), 0);
  }
  return 1 + expr.args.reduce((total, arg) => total + exprNodes(arg), 0);
}

describe("p10e owner check and reverting side on real compiler output", () => {
  test("old-solc inline modifier proves a guarded writer via expr", () => {
    const findings = pauseDetectorPlugin.detect(inputForHex(fixtureAHex(0x33)));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ fact: "pause", slot: 0, mode: "unknown", proof: "extended" });

    const parsed = mustOk(Bytecode.parse(fixtureAHex(0x33)));
    const [pause] = explainExtendedProof(parsed);
    if (pause === undefined) {
      throw new Error("expected a pause report");
    }
    for (const entry of pause.steps) {
      expect(entry.ok).toBe(true);
    }
    const writers = pause.steps[1];
    expect(writers?.ok).toBe(true);
    expect(writers?.detail).toContain("via expr");

    // The linear window never spans the 70-byte guard: no EQ or ISZERO
    // sits within the beside window of the slot load.
    const selector = mustSelector(PAUSE_SET_SELECTOR);
    const attribution = attributeFunctions(parsed, { mode: "v2" });
    const member = (pc: number): boolean => attribution.holdersOf(pc).includes(selector);
    const insns = disassemble(parsed);
    expect(hasOwnerCallerCheck(insns, member, 0)).toBe(false);
    const exprs = interpretRegionExprs(parsed, selector);
    expect(ownerCheckExpr(insns, member, 0, exprs.jumpis, parsed)).not.toBe(null);
  });

  test("oz-4 internal owner check with error helper proves a blacklist fact", () => {
    const findings = blacklistDetectorPlugin.detect(inputForHex(fixtureBHex(0x33)));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ fact: "blacklist", proof: "extended" });

    const parsed = mustOk(Bytecode.parse(fixtureBHex(0x33)));
    const [, blacklist] = explainExtendedProof(parsed);
    if (blacklist === undefined) {
      throw new Error("expected a blacklist report");
    }
    for (const entry of blacklist.steps) {
      expect(entry.ok).toBe(true);
    }
    expect(blacklist.steps[1]?.detail).toContain("via expr");
    expect(blacklist.steps[2]?.detail).toContain("via expr");

    // The guard EQ is proven through the internal returns with the
    // SHL/SUB-built mask, and the odd ISZERO parity fails through the
    // jump target into the error helper.
    const selector = mustSelector(OZ_SET_SELECTOR);
    const attribution = attributeFunctions(parsed, { mode: "v2" });
    const member = (pc: number): boolean => attribution.holdersOf(pc).includes(selector);
    const insns = disassemble(parsed);
    expect(hasOwnerCallerCheck(insns, member, 0)).toBe(false);
    const exprs = interpretRegionExprs(parsed, selector);
    expect(ownerCheckExpr(insns, member, 0, exprs.jumpis, parsed)).not.toBe(null);
  });

  test("same shapes without the EQ against CALLER stay silent", () => {
    expect(pauseDetectorPlugin.detect(inputForHex(fixtureAHex(0x35)))).toEqual([]);
    expect(blacklistDetectorPlugin.detect(inputForHex(fixtureAHex(0x35)))).toEqual([]);
    expect(blacklistDetectorPlugin.detect(inputForHex(fixtureBHex(0x35)))).toEqual([]);
    expect(pauseDetectorPlugin.detect(inputForHex(fixtureBHex(0x35)))).toEqual([]);

    const [, unguardedBlacklist] = explainExtendedProof(mustOk(Bytecode.parse(fixtureBHex(0x35))));
    if (unguardedBlacklist === undefined) {
      throw new Error("expected a blacklist report");
    }
    expect(unguardedBlacklist.steps.some((entry) => !entry.ok)).toBe(true);
    const [unguardedPause] = explainExtendedProof(mustOk(Bytecode.parse(fixtureAHex(0x35))));
    if (unguardedPause === undefined) {
      throw new Error("expected a pause report");
    }
    expect(unguardedPause.steps.some((entry) => !entry.ok)).toBe(true);
  });

  test("call-position returns resolve even with PUSH1 addresses", () => {
    // PUSH1 ret, PUSH1 func, JUMP: the width scan never seeds the
    // continuation, but the call position proves it.
    const bytes = [
      0x5b, 0x60, 0x0b, 0x60, 0x06, 0x56,
      0x5b, 0x60, 0x01, 0x90, 0x56,
      0x5b, 0x00,
    ];
    const parsed = mustOk(Bytecode.parse(`0x${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`));
    const cfg = buildCfg(lift(parsed));
    const reach = resolveEntryReachV2(cfg, 0);
    expect(reach.resolvedJumpAtPc).toEqual([10]);
    expect(reach.unresolvedJumpAtPc).toEqual([]);
  });

  test("reverting side stays bounded and total", () => {
    expect(REVERTING_SIDE_MAX_BLOCKS).toBe(24);
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 256 }), (bytes) => {
        let hex = "0x";
        for (const byte of bytes) {
          hex += byte.toString(16).padStart(2, "0");
        }
        const parsed = Bytecode.parse(hex);
        if (!parsed.ok) {
          return;
        }
        const code = parsed.value;
        const insns = disassemble(code);
        const selector = mustSelector(TRANSFER_SELECTOR);
        const attribution = attributeFunctions(code, { mode: "v2" });
        const member = (pc: number): boolean => attribution.holdersOf(pc).includes(selector);
        for (const instruction of insns) {
          if (instruction.opcode !== 0x57 || !member(instruction.pc)) {
            continue;
          }
          expect(typeof hasRevertingSide(code, insns, member, instruction.pc, "fall")).toBe("boolean");
          expect(typeof hasRevertingSide(code, insns, member, instruction.pc, "jump")).toBe("boolean");
        }
        const view = analyzeOwnerControl(code, { reach: "v2" });
        for (const region of view.regions) {
          const exprs = interpretRegionExprs(code, region.selector);
          for (const record of exprs.stores.values()) {
            expect(exprDepth(record.slot)).toBeLessThanOrEqual(12);
            expect(exprNodes(record.slot)).toBeLessThanOrEqual(64);
          }
          for (const cond of exprs.jumpis.values()) {
            expect(exprDepth(cond)).toBeLessThanOrEqual(12);
            expect(exprNodes(cond)).toBeLessThanOrEqual(64);
          }
        }
      }),
      { numRuns: 25 },
    );
  });

  test("v1 views stay silent on the new fixtures", () => {
    const pauseCode = mustOk(Bytecode.parse(fixtureAHex(0x33)));
    expect(analyzeOwnerControl(pauseCode)).toEqual(analyzeOwnerControl(pauseCode, { reach: "v1" }));
    const blacklistCode = mustOk(Bytecode.parse(fixtureBHex(0x33)));
    expect(analyzeOwnerControl(blacklistCode)).toEqual(analyzeOwnerControl(blacklistCode, { reach: "v1" }));
    // The v1 window proof never resolves the packed flag value, and no
    // v1 region pairs a caller guard with the internal-function check.
    const pauseV1 = analyzeOwnerControl(pauseCode);
    for (const region of pauseV1.regions) {
      for (const store of region.stores) {
        if (store.slot.kind === "const" && store.slot.value === 0) {
          expect(store.valueIsZero).toBe(false);
          expect(store.valueConst).toBe(null);
        }
      }
    }
    const blacklistV1 = analyzeOwnerControl(blacklistCode);
    expect(blacklistV1.privileged).toEqual([]);
  });
});
