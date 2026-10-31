// P-10f OZ-4 shapes on a modern compiler layout. Synthetic
// hand-assembled fixtures only; no network, no real addresses. A shared
// `_checkOwner` internal function (calling `owner()` and `_msgSender()`
// helpers, reverting through an encoding helper that returns with a
// dynamic JUMP) guards the writers, the blacklist gate in the transfer
// path is split over two conditional jumps, and the limit compare sits
// in a helper continuation far from its slot load. The extended facts
// prove all three; negatives stay silent and v1 output stays unchanged.
import { describe, expect, test } from "vitest";
import { Bytecode, CodeHash, Selector } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import { analyzeOwnerControl, interpretRegionExprs, ownerCheckExpr } from "../../../src/domain/ownerControl.ts";
import { attributeFunctions } from "../../../src/domain/evmFlow.ts";
import { disassemble } from "../../../src/domain/selectors.ts";
import { pauseDetectorPlugin } from "../../../src/plugins/detectors/pause/index.ts";
import { blacklistDetectorPlugin } from "../../../src/plugins/detectors/blacklist/index.ts";
import { transferLimitsDetectorPlugin } from "../../../src/plugins/detectors/transfer-limits/index.ts";
import { explainExtendedProof } from "../../../src/plugins/detectors/extendedProof.ts";
import {
  OZ4_REVERT_LIMIT_SET,
  OZ4_REVERT_OWN_SET,
  OZ4_REVERT_SET,
  oz4RevertHelperTokenHex,
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

function inputForHex(hex: string): DetectorInput {
  const parsed = mustOk(Bytecode.parse(hex));
  return Object.freeze({ bytecode: parsed, codeHash: mustOk(CodeHash.of(parsed)) });
}

describe("p10f oz-4 revert-helper shapes", () => {
  test("guarded writers prove through the internal owner check", () => {
    const parsed = mustOk(Bytecode.parse(oz4RevertHelperTokenHex()));
    const attribution = attributeFunctions(parsed, { mode: "v2" });
    const insns = disassemble(parsed);
    for (const raw of [OZ4_REVERT_SET, OZ4_REVERT_LIMIT_SET, OZ4_REVERT_OWN_SET]) {
      const selector = mustSelector(raw);
      const member = (pc: number): boolean => attribution.holdersOf(pc).includes(selector);
      const exprs = interpretRegionExprs(parsed, selector);
      expect(ownerCheckExpr(insns, member, 0, exprs.jumpis, parsed)).not.toBe(null);
    }
    const [, blacklist] = explainExtendedProof(parsed);
    if (blacklist === undefined) {
      throw new Error("expected a blacklist report");
    }
    const writers = blacklist.steps[1];
    expect(writers?.ok).toBe(true);
    for (const raw of [OZ4_REVERT_SET, OZ4_REVERT_LIMIT_SET, OZ4_REVERT_OWN_SET]) {
      expect(writers?.detail).toContain(raw);
      expect(writers?.detail).toContain("via expr");
    }
  });

  test("blacklist fact proves through the split gate and helper revert", () => {
    const findings = blacklistDetectorPlugin.detect(inputForHex(oz4RevertHelperTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ fact: "blacklist", proof: "extended" });

    const parsed = mustOk(Bytecode.parse(oz4RevertHelperTokenHex()));
    const [, blacklist] = explainExtendedProof(parsed);
    if (blacklist === undefined) {
      throw new Error("expected a blacklist report");
    }
    for (const entry of blacklist.steps) {
      expect(entry.ok).toBe(true);
    }
  });

  test("transfer-limits fact proves through the helper-interleaved compare", () => {
    const findings = transferLimitsDetectorPlugin.detect(inputForHex(oz4RevertHelperTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("dev.brandklipparen.transfer-limits:transfer-limits-extended");
    expect(findings[0]?.payload).toEqual({
      fact: "transfer-limits",
      slot: 7,
      limitKind: "max-wallet",
      proof: "extended",
    });
  });

  test("negative fixtures stay silent", () => {
    expect(blacklistDetectorPlugin.detect(inputForHex(oz4RevertHelperTokenHex(5, 6)))).toEqual([]);
    expect(blacklistDetectorPlugin.detect(inputForHex(oz4RevertHelperTokenHex(4, 4, false)))).toEqual([]);
    expect(transferLimitsDetectorPlugin.detect(inputForHex(oz4RevertHelperTokenHex(4, 4, false)))).toEqual([]);
    expect(pauseDetectorPlugin.detect(inputForHex(oz4RevertHelperTokenHex()))).toEqual([]);
  });

  test("v1 views stay unchanged on the new fixture", () => {
    const parsed = mustOk(Bytecode.parse(oz4RevertHelperTokenHex()));
    expect(analyzeOwnerControl(parsed)).toEqual(analyzeOwnerControl(parsed, { reach: "v1" }));
    expect(analyzeOwnerControl(parsed).ownerSlot).toBe(null);
  });
});
