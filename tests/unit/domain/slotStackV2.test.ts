// Storage slot resolution through the stack in v2 (P-10c). Synthetic
// hand-assembled fixtures only; no network, no real addresses. The v2
// abstract stack interpreter resolves const slots through PUSH/DUP/SWAP
// chains and proves mapping bases through moved keccak results, while
// the scored v1 path stays byte-identical.
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { Bytecode, CodeHash, Selector } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import { attributeFunctions } from "../../../src/domain/evmFlow.ts";
import {
  analyzeOwnerControl,
  hasOwnerCallerCheck,
  interpretRegionSlots,
  mappingBaseNearAccess,
  regionBySelector,
} from "../../../src/domain/ownerControl.ts";
import type { SlotLookup } from "../../../src/domain/ownerControl.ts";
import { disassemble } from "../../../src/domain/selectors.ts";
import { pauseDetectorPlugin } from "../../../src/plugins/detectors/pause/index.ts";
import { blacklistDetectorPlugin } from "../../../src/plugins/detectors/blacklist/index.ts";
import {
  CALLDATALOAD,
  CALLER,
  EQ,
  KECCAK,
  MSTORE,
  OR,
  REVERT,
  SLOAD,
  SSTORE,
  STOP,
  branchOk,
  expPackedPauseToken,
  ownerGuard,
  packedPauseToken,
  push1,
  sharedBlacklistTokenHex,
  tokenBytecode,
} from "../../helpers/ownerControlFixtures.ts";

const DUP1 = 0x80;
const DUP2 = 0x81;
const SWAP1 = 0x90;
const POP = 0x50;
const ADD = 0x01;
const JUMPDEST = 0x5b;

const SET_OWNER = "0x12345678";
const SET_STATUS = "0x0a9c6c1e";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function mustSelector(raw: string) {
  return mustOk(Selector.parse(raw));
}

function detectorInputFor(bytecode: ReturnType<typeof tokenBytecode>): DetectorInput {
  return Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
}

// Old-solc style owner body: the slot travels on the stack through
// PUSH/DUP/SWAP chains, so no PUSH sits adjacent to the SLOAD/SSTORE.
// Guard: CALLER, PUSH1 0, DUP1, SLOAD, SWAP1, POP, EQ beside a reverting
// branch. Write: CALLDATALOAD value, PUSH1 0, DUP2, SWAP1, SSTORE.
function oldSolcStyleBody(): number[] {
  return [
    CALLER,
    ...push1(0),
    DUP1,
    SLOAD,
    SWAP1,
    POP,
    EQ,
    ...branchOk(),
    ...push1(0),
    REVERT,
    JUMPDEST,
    CALLDATALOAD,
    ...push1(0),
    DUP2,
    SWAP1,
    SSTORE,
    STOP,
  ];
}

// Bool-in-mapping setter through DUP/SWAP: the keccak result is moved by
// DUP/SWAP instead of sitting adjacent, and a wide JUMPDEST gap separates
// the MSTORE pattern from the hash so the legacy window scan cannot
// prove the base. A second store adds a const struct offset to the hash.
function mappingDupSwapBody(): number[] {
  const gap: number[] = new Array(45).fill(JUMPDEST);
  return [
    ...ownerGuard(0, 200),
    CALLDATALOAD,
    ...push1(0),
    MSTORE,
    ...push1(7),
    ...push1(0x20),
    MSTORE,
    ...gap,
    ...push1(0x40),
    ...push1(0x00),
    KECCAK,
    DUP1,
    SLOAD,
    ...push1(1),
    OR,
    SWAP1,
    SSTORE,
    CALLDATALOAD,
    ...push1(0),
    MSTORE,
    ...push1(7),
    ...push1(0x20),
    MSTORE,
    ...push1(0x40),
    ...push1(0x00),
    KECCAK,
    ...push1(1),
    ADD,
    SSTORE,
    STOP,
  ];
}

describe("p10c v2 slot resolution through the stack", () => {
  test("old-solc PUSH/DUP/SWAP slots resolve to const 0 in v2, unknown in v1", () => {
    const code = tokenBytecode([{ selector: SET_OWNER, body: oldSolcStyleBody() }]);
    const selector = mustSelector(SET_OWNER);
    const v1 = analyzeOwnerControl(code);
    const v2 = analyzeOwnerControl(code, { reach: "v2" });

    // v1 keeps the legacy proof: no adjacent PUSH, no keccak window.
    const first = regionBySelector(v1, selector);
    if (first === undefined) {
      throw new Error("expected a v1 region");
    }
    expect(first.loads.length).toBeGreaterThan(0);
    for (const load of first.loads) {
      expect(load.slot).toEqual({ kind: "unknown" });
    }
    for (const store of first.stores) {
      expect(store.slot).toEqual({ kind: "unknown" });
    }
    expect(v1.ownerSlot).toBe(null);

    // v2 follows the stack: the owner load and the write name slot 0,
    // so slot 0 proves as the owner slot with a privileged writer.
    const second = regionBySelector(v2, selector);
    if (second === undefined) {
      throw new Error("expected a v2 region");
    }
    expect(v2.ownerSlot).toBe(0);
    expect(second.loads.map((load) => load.slot)).toContainEqual({ kind: "const", value: 0 });
    expect(second.stores.map((store) => store.slot)).toContainEqual({ kind: "const", value: 0 });
    expect(v2.privileged).toContain(selector);

    // The interpreter names the load directly, and the privileged-writer
    // proof needs it: legacy stays silent, v2 proves the caller check.
    const slots = interpretRegionSlots(code, selector);
    const slotOf: SlotLookup = (pc) => slots.get(pc);
    const loadPc = second.loads[0]?.pc;
    if (loadPc === undefined) {
      throw new Error("expected a v2 load");
    }
    expect(slots.get(loadPc)).toEqual({ kind: "const", value: 0 });
    const insns = disassemble(code);
    expect(hasOwnerCallerCheck(insns, () => true, 0)).toBe(false);
    expect(hasOwnerCallerCheck(insns, () => true, 0, slotOf)).toBe(true);
  });

  test("bool-in-mapping write through DUP/SWAP resolves to mapping base 7 in v2", () => {
    const code = tokenBytecode([{ selector: SET_STATUS, body: mappingDupSwapBody() }]);
    const selector = mustSelector(SET_STATUS);
    const v1 = analyzeOwnerControl(code);
    const v2 = analyzeOwnerControl(code, { reach: "v2" });

    const second = regionBySelector(v2, selector);
    if (second === undefined) {
      throw new Error("expected a v2 region");
    }
    expect(second.stores.length).toBe(2);
    for (const store of second.stores) {
      expect(store.slot).toEqual({ kind: "mapping", base: 7 });
    }
    for (const load of second.loads) {
      if (load.slot.kind === "mapping") {
        expect(load.slot).toEqual({ kind: "mapping", base: 7 });
      }
    }

    // v1 sees the keccak window but never the base.
    const first = regionBySelector(v1, selector);
    if (first === undefined) {
      throw new Error("expected a v1 region");
    }
    for (const store of first.stores) {
      expect(store.slot).toEqual({ kind: "mapping", base: null });
    }

    // The legacy base scan cannot cross the JUMPDEST gap before the
    // first store, so only the interpreter lookup proves base 7 there;
    // the second store sits beside its pattern, so both proofs agree.
    const attribution = attributeFunctions(code, { mode: "v2" });
    const memberOf = (pc: number): boolean => attribution.holdersOf(pc).includes(selector);
    const insns = disassemble(code);
    const slots = interpretRegionSlots(code, selector);
    const slotOf: SlotLookup = (pc) => slots.get(pc);
    const gapped = second.stores[0];
    const adjacent = second.stores[1];
    if (gapped === undefined || adjacent === undefined) {
      throw new Error("expected two v2 stores");
    }
    expect(mappingBaseNearAccess(insns, memberOf, gapped.pc)).toBe(null);
    expect(mappingBaseNearAccess(insns, memberOf, gapped.pc, slotOf)).toBe(7);
    expect(mappingBaseNearAccess(insns, memberOf, adjacent.pc)).toBe(7);
    expect(mappingBaseNearAccess(insns, memberOf, adjacent.pc, slotOf)).toBe(7);
  });

  test("v1 owner-control views stay identical with or without the v2 wiring", () => {
    const styled = tokenBytecode([{ selector: SET_OWNER, body: oldSolcStyleBody() }]);
    const mapped = tokenBytecode([{ selector: SET_STATUS, body: mappingDupSwapBody() }]);
    const shared = mustOk(Bytecode.parse(sharedBlacklistTokenHex()));
    for (const code of [styled, mapped, packedPauseToken(), expPackedPauseToken(), shared]) {
      expect(analyzeOwnerControl(code)).toEqual(analyzeOwnerControl(code, { reach: "v1" }));
      expect(analyzeOwnerControl(code)).toEqual(analyzeOwnerControl(code, {}));
    }
  });

  test("p11 pause and blacklist fixtures still report their extended facts", () => {
    const packed = pauseDetectorPlugin.detect(detectorInputFor(packedPauseToken()));
    expect(packed).toHaveLength(1);
    expect(packed[0]?.id).toBe("dev.brandklipparen.pause:pause-extended");
    expect(packed[0]?.payload).toEqual({ fact: "pause", slot: 0, mode: "pause", proof: "extended" });

    const exp = pauseDetectorPlugin.detect(detectorInputFor(expPackedPauseToken()));
    expect(exp).toHaveLength(1);
    expect(exp[0]?.id).toBe("dev.brandklipparen.pause:pause-extended");
    expect(exp[0]?.payload).toEqual({ fact: "pause", slot: 0, mode: "pause", proof: "extended" });

    const shared = mustOk(Bytecode.parse(sharedBlacklistTokenHex()));
    const gated = blacklistDetectorPlugin.detect(detectorInputFor(shared));
    expect(gated).toHaveLength(1);
    expect(gated[0]?.id).toBe("dev.brandklipparen.blacklist:blacklist-extended");
    expect(gated[0]?.payload).toEqual({ fact: "blacklist", proof: "extended" });
  });

  test("v2 slot work cap holds on large random-ish bytecode", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 1024 }), (bytes) => {
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
        for (const region of view.regions) {
          const slots = interpretRegionSlots(code, region.selector);
          expect(slots.size).toBeLessThanOrEqual(disassemble(code).length);
        }
      }),
      { numRuns: 25 },
    );
  });
});
