// SCORE-3: getter-derived owner attribution for the shared
// `_checkOwner` helper shape. The setter's caller check lives in an
// internal helper reached by JUMP (owner and sender sub-helpers return
// through dynamic jumps, the owner word masked to its low 160 bits),
// so no single region holds the check. The owner seat comes from the
// slot `owner()`/`getOwner()` returns; a check against a different
// slot, or the same helper with no dispatched getter, stays non-owner.
import { describe, expect, test } from "vitest";
import { analyzeOwnerControl } from "../../../src/domain/ownerControl.ts";
import { Bytecode, CodeHash } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import { blacklistDetectorPlugin } from "../../../src/plugins/detectors/blacklist/index.ts";
import { ownershipDetectorPlugin } from "../../../src/plugins/detectors/ownership/index.ts";
import { HELPER_OWNER_SET, helperOwnerTokenHex } from "../../helpers/ownerControlFixtures.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function inputForHex(hex: string): DetectorInput {
  const bytecode = mustOk(Bytecode.parse(hex));
  return Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
}

describe("helper-owner attribution (SCORE-3)", () => {
  test("owner() slot attributes the shared-helper setter", () => {
    const input = inputForHex(helperOwnerTokenHex(3));
    const view = analyzeOwnerControl(input.bytecode);
    expect(view.ownerSlot).toBe(3);
    expect(view.ownerChecks.map((check) => check.selector as string)).toContain(HELPER_OWNER_SET);
    expect(view.privileged as readonly string[]).toContain(HELPER_OWNER_SET);
    const findings = ownershipDetectorPlugin.detect(input);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ feature: "owner-slot", slot: 3, privilegedFunctions: 1 });
    expect(blacklistDetectorPlugin.detect(input)).toHaveLength(1);
  });

  test("getOwner() slot attributes the shared-helper setter", () => {
    const input = inputForHex(helperOwnerTokenHex(4, 4, "getOwner"));
    const view = analyzeOwnerControl(input.bytecode);
    expect(view.ownerSlot).toBe(4);
    expect(view.privileged as readonly string[]).toContain(HELPER_OWNER_SET);
    const findings = ownershipDetectorPlugin.detect(input);
    expect(findings[0]?.payload).toEqual({ feature: "owner-slot", slot: 4, privilegedFunctions: 1 });
  });

  test("a check against a different slot remains non-owner", () => {
    const input = inputForHex(helperOwnerTokenHex(3, 9));
    const view = analyzeOwnerControl(input.bytecode);
    expect(view.ownerSlot).toBe(null);
    expect(view.ownerChecks).toEqual([]);
    expect(view.privileged as readonly string[]).not.toContain(HELPER_OWNER_SET);
    expect(ownershipDetectorPlugin.detect(input)).toEqual([]);
  });

  test("the same helper with no dispatched getter remains non-owner", () => {
    const input = inputForHex(helperOwnerTokenHex(3, 3, null));
    const view = analyzeOwnerControl(input.bytecode);
    expect(view.ownerSlot).toBe(null);
    expect(ownershipDetectorPlugin.detect(input)).toEqual([]);
  });
});
