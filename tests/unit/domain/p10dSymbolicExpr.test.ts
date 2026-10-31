// P-10d symbolic expressions in the v2 stack interpreter. Synthetic
// hand-assembled fixtures only; no network, no real addresses. An exact
// old-solc 0.4.x packed bool write proves the pause fact through
// expression matching, and an OZ-4-shaped onlyOwner check through two
// internal functions proves the blacklist fact. Negatives stay silent,
// fast-check never throws, and v1 output stays unchanged.
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { Bytecode, CodeHash, Selector } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import {
  analyzeOwnerControl,
  hasOwnerCallerCheck,
  interpretRegionExprs,
  interpretRegionSlots,
  ownerCheckExpr,
  packedBoolWriteAt,
  packedBoolWriteExpr,
} from "../../../src/domain/ownerControl.ts";
import type { Expr } from "../../../src/domain/ownerControl.ts";
import { attributeFunctions } from "../../../src/domain/evmFlow.ts";
import { disassemble } from "../../../src/domain/selectors.ts";
import { pauseDetectorPlugin } from "../../../src/plugins/detectors/pause/index.ts";
import { blacklistDetectorPlugin } from "../../../src/plugins/detectors/blacklist/index.ts";
import { explainExtendedProof } from "../../../src/plugins/detectors/extendedProof.ts";
import {
  OLD_SOLC_PAUSE_SET,
  OZ4_BLACKLIST_SET,
  TRANSFER_SELECTOR,
  oldSolcPauseBitMismatchToken,
  oldSolcPauseToken,
  oldSolcPauseUnguardedToken,
  oz4BlacklistTokenHex,
} from "../../helpers/ownerControlFixtures.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function mustSelector(raw: string) {
  return mustOk(Selector.parse(raw));
}

function inputForBytecode(bytecode: ReturnType<typeof oldSolcPauseToken>): DetectorInput {
  return Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
}

function inputForHex(hex: string): DetectorInput {
  const parsed = mustOk(Bytecode.parse(hex));
  return Object.freeze({ bytecode: parsed, codeHash: mustOk(CodeHash.of(parsed)) });
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

describe("p10d symbolic expressions in v2", () => {
  test("old-solc packed write proves the pause fact through expression matching", () => {
    const findings = pauseDetectorPlugin.detect(inputForBytecode(oldSolcPauseToken()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ fact: "pause", slot: 0, mode: "unknown", proof: "extended" });

    const [pause, blacklist] = explainExtendedProof(inputForBytecode(oldSolcPauseToken()).bytecode);
    if (pause === undefined || blacklist === undefined) {
      throw new Error("expected two reports");
    }
    for (const entry of pause.steps) {
      expect(entry.ok).toBe(true);
    }
    expect(pause.steps[3]?.detail).toContain("bit 160");
    expect(pause.steps[3]?.detail).toContain("via expr");
    expect(pause.steps[4]?.detail).toContain("via expr");

    // The legacy window matcher never names the 0x0100-built shift.
    const code = inputForBytecode(oldSolcPauseToken()).bytecode;
    const selector = mustSelector(OLD_SOLC_PAUSE_SET);
    const view = analyzeOwnerControl(code, { reach: "v2" });
    const region = view.regions.find((candidate) => candidate.selector === selector);
    if (region === undefined) {
      throw new Error("expected a writer region");
    }
    const store = region.stores[0];
    if (store === undefined) {
      throw new Error("expected a writer store");
    }
    const insns = disassemble(code);
    const index = insns.findIndex((instruction) => instruction.pc === store.pc);
    expect(packedBoolWriteAt(insns, index, 0)).toBe(null);
    const exprs = interpretRegionExprs(code, selector);
    expect(packedBoolWriteExpr(0, exprs.stores.get(store.pc))).toEqual({ bit: 160 });
  });

  test("oz-4 internal owner check proves the blacklist fact", () => {
    const findings = blacklistDetectorPlugin.detect(inputForHex(oz4BlacklistTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ fact: "blacklist", proof: "extended" });

    const parsed = mustOk(Bytecode.parse(oz4BlacklistTokenHex()));
    const [, blacklist] = explainExtendedProof(parsed);
    if (blacklist === undefined) {
      throw new Error("expected a blacklist report");
    }
    for (const entry of blacklist.steps) {
      expect(entry.ok).toBe(true);
    }
    expect(blacklist.steps[1]?.detail).toContain("via expr");
    expect(blacklist.steps[2]?.detail).toContain("via expr");

    // The linear window proof never sees CALLER after SLOAD across the
    // two internal helpers, while the expression matcher does.
    const selector = mustSelector(OZ4_BLACKLIST_SET);
    const attribution = attributeFunctions(parsed, { mode: "v2" });
    const member = (pc: number): boolean => attribution.holdersOf(pc).includes(selector);
    const insns = disassemble(parsed);
    expect(hasOwnerCallerCheck(insns, member, 0)).toBe(false);
    const exprs = interpretRegionExprs(parsed, selector);
    expect(ownerCheckExpr(insns, member, 0, exprs.jumpis)).not.toBe(null);
  });

  test("negative fixtures stay silent", () => {
    expect(pauseDetectorPlugin.detect(inputForBytecode(oldSolcPauseUnguardedToken()))).toEqual([]);
    expect(pauseDetectorPlugin.detect(inputForBytecode(oldSolcPauseBitMismatchToken()))).toEqual([]);
    expect(blacklistDetectorPlugin.detect(inputForHex(oz4BlacklistTokenHex(5, 6)))).toEqual([]);
    expect(blacklistDetectorPlugin.detect(inputForHex(oz4BlacklistTokenHex(5, 5, false)))).toEqual([]);

    const [, unguardedBlacklist] = explainExtendedProof(mustOk(Bytecode.parse(oz4BlacklistTokenHex(5, 5, false))));
    if (unguardedBlacklist === undefined) {
      throw new Error("expected a blacklist report");
    }
    expect(unguardedBlacklist.steps.some((entry) => !entry.ok)).toBe(true);
  });

  test("v1 views stay silent on the new fixtures", () => {
    const pauseCode = inputForBytecode(oldSolcPauseToken()).bytecode;
    expect(analyzeOwnerControl(pauseCode)).toEqual(analyzeOwnerControl(pauseCode, { reach: "v1" }));
    const blacklistCode = mustOk(Bytecode.parse(oz4BlacklistTokenHex()));
    expect(analyzeOwnerControl(blacklistCode)).toEqual(analyzeOwnerControl(blacklistCode, { reach: "v1" }));
    // No scored finding hides behind the extended facts.
    const pauseV1 = analyzeOwnerControl(pauseCode);
    for (const region of pauseV1.regions) {
      for (const store of region.stores) {
        if (store.slot.kind === "const" && store.slot.value === 0) {
          expect(store.valueIsZero).toBe(false);
          expect(store.valueConst).toBe(null);
        }
      }
    }
    void TRANSFER_SELECTOR;
  });

  test("expression walk never throws and respects caps", () => {
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
        const view = analyzeOwnerControl(code, { reach: "v2" });
        const insnCount = disassemble(code).length;
        for (const region of view.regions) {
          const exprs = interpretRegionExprs(code, region.selector);
          expect(exprs.stores.size).toBeLessThanOrEqual(insnCount);
          expect(exprs.loads.size).toBeLessThanOrEqual(insnCount);
          expect(exprs.jumpis.size).toBeLessThanOrEqual(insnCount);
          const slots = interpretRegionSlots(code, region.selector);
          expect(slots.size).toBeLessThanOrEqual(insnCount);
          const check = (expr: Expr): void => {
            expect(exprDepth(expr)).toBeLessThanOrEqual(12);
            expect(exprNodes(expr)).toBeLessThanOrEqual(64);
          };
          for (const record of exprs.stores.values()) {
            check(record.slot);
            check(record.value);
          }
          for (const slot of exprs.loads.values()) {
            check(slot);
          }
          for (const cond of exprs.jumpis.values()) {
            check(cond);
          }
        }
      }),
      { numRuns: 25 },
    );
  });
});
