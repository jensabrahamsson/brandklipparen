// Tests for the extended-proof diagnostics (P-11 follow-up): the pure
// per-detector reports in `src/plugins/detectors/extendedProof.ts`.
// Behaviour under test, not implementation: found facts report every
// step ok in detector order, and silent cases name the first step that
// failed. All fixtures are synthetic hand-assembled dispatchers; no real
// bytecode, no addresses, no network.
import { describe, expect, test } from "vitest";
import { Bytecode } from "../../../src/domain/types.ts";
import { disassemble } from "../../../src/domain/selectors.ts";
import { explainExtendedProof } from "../../../src/plugins/detectors/extendedProof.ts";
import type { ExtendedProof } from "../../../src/plugins/detectors/extendedProof.ts";
import {
  ADD,
  AND,
  CALLDATALOAD,
  DIV,
  EXP,
  GT,
  ISZERO,
  KECCAK,
  LT,
  MSTORE,
  MUL,
  PACKED_MAPPING_SET,
  REVERT,
  SLOAD,
  SSTORE,
  STOP,
  SUB,
  TRANSFER_SELECTOR,
  branchOk,
  maskedPackedPauseToken,
  ownerGuard,
  packedMappingBlacklistToken,
  packedPauseToken,
  push1,
  byteMaskPauseTokenHex,
  roleOnlyPauseTokenHex,
  sharedBaseGateTokenHex,
  sharedBlacklistTokenHex,
  shortCircuitPackedPauseTokenHex,
  shuffledStoreBlacklistTokenHex,
  sstoreConstSlot,
  tokenBytecode,
} from "../../helpers/ownerControlFixtures.ts";

function explainOf(bytecodeHex: string): readonly ExtendedProof[] {
  const parsed = Bytecode.parse(bytecodeHex);
  if (!parsed.ok) {
    throw new Error("fixture bytecode must parse");
  }
  return explainExtendedProof(parsed.value);
}

function firstFailed(proof: ExtendedProof): string {
  const failed = proof.steps.find((entry) => !entry.ok);
  if (failed === undefined) {
    throw new Error("expected a failed step");
  }
  return failed.step;
}

describe("extended-proof diagnostics (P-11 follow-up)", () => {
  test("role-only pause proof does not fail at the owner slot", () => {
    const [pause] = explainOf(roleOnlyPauseTokenHex());
    if (pause === undefined) throw new Error("expected a pause report");
    expect(pause.detector).toBe("dev.brandklipparen.pause");
    expect(pause.steps[0]?.step).toBe("owner-slot");
    expect(pause.steps[0]?.ok).toBe(true);
    expect(pause.steps[0]?.detail).toContain("role guard");
    expect(pause.steps.every((entry) => entry.ok)).toBe(true);
  });

  test("masked pause fact reports every pause step ok in order", () => {
    const [pause, blacklist] = explainOf(`0x${Buffer.from(maskedPackedPauseToken()).toString("hex")}`);
    if (pause === undefined || blacklist === undefined) {
      throw new Error("expected one report per extended detector");
    }
    expect(pause.detector).toBe("dev.brandklipparen.pause");
    expect(pause.steps.map((entry) => entry.step)).toEqual([
      "owner-slot",
      "writer-regions",
      "candidate-slots",
      "packed-write-proof",
      "transfer-gate",
      "same-slot-and-bit",
      "reverting-jumpi",
    ]);
    for (const entry of pause.steps) {
      expect(entry.ok).toBe(true);
    }
    expect(pause.steps[3]?.detail).toContain("bit 8");
    // The pause writers store constant slots, so the blacklist report
    // fails at the candidate bases, never at a later step.
    expect(blacklist.detector).toBe("dev.brandklipparen.blacklist");
    expect(firstFailed(blacklist)).toBe("candidate-bases");
  });

  test("packed bool-in-mapping fact reports every blacklist step ok in order", () => {
    const bytecode = `0x${Buffer.from(packedMappingBlacklistToken()).toString("hex")}`;
    const [pause, blacklist] = explainOf(bytecode);
    if (pause === undefined || blacklist === undefined) {
      throw new Error("expected one report per extended detector");
    }
    expect(blacklist.detector).toBe("dev.brandklipparen.blacklist");
    expect(blacklist.steps.map((entry) => entry.step)).toEqual([
      "owner-slot",
      "writer-regions",
      "candidate-bases",
      "packed-write-proof",
      "transfer-gate",
      "same-base",
      "reverting-jumpi",
    ]);
    for (const entry of blacklist.steps) {
      expect(entry.ok).toBe(true);
    }
    expect(blacklist.steps[3]?.detail).toContain("packed read-modify-write");
    // The mapping writer stores no constant slot, so the pause report
    // fails at the candidate slots.
    expect(firstFailed(pause)).toBe("candidate-slots");
  });

  test("shared blacklist fact reports a plain writer store", () => {
    const [, blacklist] = explainOf(sharedBlacklistTokenHex());
    if (blacklist === undefined) {
      throw new Error("expected one report per extended detector");
    }
    for (const entry of blacklist.steps) {
      expect(entry.ok).toBe(true);
    }
    expect(blacklist.steps[3]?.detail).toContain("plain mapping store");
  });

  test("shuffled key store gate reports every blacklist step ok", () => {
    const [, blacklist] = explainOf(shuffledStoreBlacklistTokenHex());
    if (blacklist === undefined) {
      throw new Error("expected one report per extended detector");
    }
    for (const entry of blacklist.steps) {
      expect(entry.ok).toBe(true);
    }
    expect(blacklist.steps[4]?.detail).toContain("base 7");
  });

  test("byte-mask and short-circuit packed gates report every pause step ok", () => {
    const [byteMaskPause] = explainOf(byteMaskPauseTokenHex());
    const [shortPause] = explainOf(shortCircuitPackedPauseTokenHex());
    if (byteMaskPause === undefined || shortPause === undefined) {
      throw new Error("expected one report per extended detector");
    }
    for (const entry of byteMaskPause.steps) {
      expect(entry.ok).toBe(true);
    }
    for (const entry of shortPause.steps) {
      expect(entry.ok).toBe(true);
    }
  });

  test("packed pause fixture reports every pause step ok", () => {
    const [pause] = explainOf(`0x${Buffer.from(packedPauseToken()).toString("hex")}`);
    if (pause === undefined) {
      throw new Error("expected one report per extended detector");
    }
    for (const entry of pause.steps) {
      expect(entry.ok).toBe(true);
    }
    expect(pause.steps[3]?.detail).toContain("bit 8");
  });

  test("reports are deterministic", () => {
    const bytecode = `0x${Buffer.from(maskedPackedPauseToken()).toString("hex")}`;
    expect(explainOf(bytecode)).toEqual(explainOf(bytecode));
  });

  test("bytecode without selectors fails at the owner slot", () => {
    const parsed = Bytecode.parse("0x6001600055");
    if (!parsed.ok) {
      throw new Error("fixture bytecode must parse");
    }
    const [pause, blacklist] = explainExtendedProof(parsed.value);
    if (pause === undefined || blacklist === undefined) {
      throw new Error("expected one report per extended detector");
    }
    expect(firstFailed(pause)).toBe("owner-slot");
    expect(firstFailed(blacklist)).toBe("owner-slot");
    expect(pause.steps).toHaveLength(7);
    expect(blacklist.steps).toHaveLength(7);
  });

  test("standard token writer as the only writer fails at the writer regions", () => {
    // The guarded approve entry writes the gated mapping, but standard
    // token entries never prove a privileged writer.
    const bytecode = sharedBaseGateTokenHex({
      writerSelector: "0x095ea7b3",
      guarded: true,
      writeBase: 9,
      gateBase: 9,
    });
    const [, blacklist] = explainOf(bytecode);
    if (blacklist === undefined) {
      throw new Error("expected one report per extended detector");
    }
    expect(firstFailed(blacklist)).toBe("writer-regions");
  });

  test("privileged write with no transfer gate fails at the transfer gate", () => {
    // A guarded mapping write to base 3 with a transfer path that reads
    // the entry but never compares it: no gate, so the proof stops there.
    const bytecode = tokenBytecode([
      {
        selector: "0x0a9c6c1e",
        body: [
          ...ownerGuard(0, 200),
          CALLDATALOAD,
          CALLDATALOAD,
          ...push1(0),
          MSTORE,
          ...push1(3),
          ...push1(0x20),
          MSTORE,
          ...push1(0x40),
          ...push1(0x00),
          KECCAK,
          SSTORE,
          STOP,
        ],
      },
      {
        selector: TRANSFER_SELECTOR,
        body: [
          CALLDATALOAD,
          ...push1(0),
          MSTORE,
          ...push1(3),
          ...push1(0x20),
          MSTORE,
          ...push1(0x40),
          ...push1(0x00),
          KECCAK,
          SLOAD,
          ...push1(2),
          SSTORE,
          STOP,
        ],
      },
    ]);
    const [, blacklist] = explainOf(`0x${Buffer.from(bytecode).toString("hex")}`);
    if (blacklist === undefined) {
      throw new Error("expected one report per extended detector");
    }
    expect(firstFailed(blacklist)).toBe("transfer-gate");
  });

  test("packed gate on another base fails at the same base", () => {
    const bytecode = `0x${Buffer.from(packedMappingBlacklistToken(7, 8)).toString("hex")}`;
    const [, blacklist] = explainOf(bytecode);
    if (blacklist === undefined) {
      throw new Error("expected one report per extended detector");
    }
    expect(firstFailed(blacklist)).toBe("same-base");
  });

  test("packed gate with no reverting jump fails at the reverting jump", () => {
    // The packed shift-and-mask gate reads the written base but the
    // branch falls through with no revert: the block is not proven.
    const bytecode = tokenBytecode([
      {
        selector: PACKED_MAPPING_SET,
        body: [
          ...ownerGuard(0, 200),
          CALLDATALOAD,
          CALLDATALOAD,
          ...push1(0),
          MSTORE,
          ...push1(5),
          ...push1(0x20),
          MSTORE,
          ...push1(0x40),
          ...push1(0x00),
          KECCAK,
          SSTORE,
          STOP,
        ],
      },
      {
        selector: TRANSFER_SELECTOR,
        body: [
          CALLDATALOAD,
          ...push1(0),
          MSTORE,
          ...push1(5),
          ...push1(0x20),
          MSTORE,
          ...push1(0x40),
          ...push1(0x00),
          KECCAK,
          SLOAD,
          ...push1(2),
          ...push1(8),
          EXP,
          DIV,
          ...push1(0xff),
          AND,
          ISZERO,
          ...branchOk(),
          0x5b,
          ...sstoreConstSlot(2, [CALLDATALOAD]),
          STOP,
        ],
      },
    ]);
    const [, blacklist] = explainOf(`0x${Buffer.from(bytecode).toString("hex")}`);
    if (blacklist === undefined) {
      throw new Error("expected one report per extended detector");
    }
    expect(firstFailed(blacklist)).toBe("reverting-jumpi");
  });

  test("fee fact reports every fee step ok in detector order", () => {
    const bytecode = tokenBytecode([
      {
        selector: "0x0a9c6c1e",
        body: [
          ...ownerGuard(0, 200),
          ...sstoreConstSlot(5, [...push1(0x04), CALLDATALOAD]),
          ...sstoreConstSlot(6, [...push1(0x24), CALLDATALOAD]),
          STOP,
        ],
      },
      {
        selector: TRANSFER_SELECTOR,
        body: [
          ...push1(0x04),
          CALLDATALOAD,
          ...push1(5),
          0x80,
          0x50,
          SLOAD,
          0x81,
          MUL,
          SUB,
          ...sstoreConstSlot(2, [...push1(0x04), CALLDATALOAD]),
          ...push1(0x04),
          CALLDATALOAD,
          ...push1(6),
          0x80,
          0x50,
          SLOAD,
          GT,
          ...branchOk(),
          ...sstoreConstSlot(8, [...push1(0x04), CALLDATALOAD]),
          0x5b,
          STOP,
        ],
      },
    ]);
    const [, , fee, limits, mint] = explainOf(`0x${Buffer.from(bytecode).toString("hex")}`);
    if (fee === undefined || limits === undefined || mint === undefined) {
      throw new Error("expected one report per extended detector");
    }
    expect(fee.detector).toBe("dev.brandklipparen.transfer-fee");
    expect(fee.steps.map((entry) => entry.step)).toEqual([
      "owner-slot",
      "writer-regions",
      "candidate-slots",
      "transfer-use",
      "subtraction",
    ]);
    for (const entry of fee.steps) {
      expect(entry.ok).toBe(true);
    }
    expect(fee.steps[3]?.detail).toContain("cap slot 6");
    // A fee clamp never proves a limit, and no supply slot exists.
    expect(firstFailed(limits)).toBe("transfer-gate");
    expect(firstFailed(mint)).toBe("supply-slot");
  });

  test("fee arithmetic with no privileged writer fails at the writer regions", () => {
    // The guarded transfer proves the owner slot, but the setter has no
    // caller check, so no writer region proves.
    const bytecode = tokenBytecode([
      {
        selector: "0x0a9c6c1e",
        body: [...sstoreConstSlot(5, [...push1(0x04), CALLDATALOAD]), STOP],
      },
      {
        selector: TRANSFER_SELECTOR,
        body: [
          ...ownerGuard(0, 200),
          ...push1(0x04),
          CALLDATALOAD,
          ...push1(5),
          0x80,
          0x50,
          SLOAD,
          0x81,
          MUL,
          SUB,
          ...sstoreConstSlot(2, [...push1(0x04), CALLDATALOAD]),
          STOP,
        ],
      },
    ]);
    const [, , fee] = explainOf(`0x${Buffer.from(bytecode).toString("hex")}`);
    if (fee === undefined) {
      throw new Error("expected one report per extended detector");
    }
    expect(firstFailed(fee)).toBe("writer-regions");
  });

  test("limits fact reports every limits step ok", () => {
    const bytecode = tokenBytecode([
      {
        selector: "0x0a9c6c1e",
        body: [
          ...ownerGuard(0, 200),
          ...sstoreConstSlot(6, [...push1(0x04), CALLDATALOAD]),
          STOP,
        ],
      },
      {
        selector: TRANSFER_SELECTOR,
        body: [
          ...push1(0x04),
          CALLDATALOAD,
          ...push1(6),
          0x80,
          0x50,
          SLOAD,
          LT,
          ISZERO,
          ...branchOk(),
          ...push1(0),
          0x80,
          REVERT,
          0x5b,
          ...sstoreConstSlot(2, [...push1(0x04), CALLDATALOAD]),
          STOP,
        ],
      },
    ]);
    const [, , , limits, mint] = explainOf(`0x${Buffer.from(bytecode).toString("hex")}`);
    if (limits === undefined || mint === undefined) {
      throw new Error("expected one report per extended detector");
    }
    expect(limits.detector).toBe("dev.brandklipparen.transfer-limits");
    expect(limits.steps.map((entry) => entry.step)).toEqual([
      "owner-slot",
      "writer-regions",
      "candidate-slots",
      "transfer-gate",
      "same-slot",
      "reverting-jumpi",
    ]);
    for (const entry of limits.steps) {
      expect(entry.ok).toBe(true);
    }
    expect(firstFailed(mint)).toBe("supply-slot");
  });

  test("fee clamp beside an underflow revert fails limits at the transfer gate", () => {
    const bytecode = tokenBytecode([
      {
        selector: "0x0a9c6c1e",
        body: [
          ...ownerGuard(0, 200),
          ...sstoreConstSlot(5, [...push1(0x04), CALLDATALOAD]),
          ...sstoreConstSlot(4, [...push1(0x24), CALLDATALOAD]),
          STOP,
        ],
      },
      {
        selector: TRANSFER_SELECTOR,
        body: [
          ...push1(0x04),
          CALLDATALOAD,
          ...push1(5),
          0x80,
          0x50,
          SLOAD,
          MUL,
          ...push1(4),
          0x80,
          0x50,
          SLOAD,
          GT,
          ...branchOk(),
          ...sstoreConstSlot(8, [...push1(0x04), CALLDATALOAD]),
          0x5b,
          ...push1(0x04),
          CALLDATALOAD,
          0x80,
          SUB,
          ISZERO,
          ...branchOk(),
          ...push1(0),
          0x80,
          REVERT,
          0x5b,
          ...sstoreConstSlot(2, [...push1(0x04), CALLDATALOAD]),
          STOP,
        ],
      },
    ]);
    const [, , , limits] = explainOf(`0x${Buffer.from(bytecode).toString("hex")}`);
    if (limits === undefined) {
      throw new Error("expected one report per extended detector");
    }
    expect(firstFailed(limits)).toBe("transfer-gate");
  });

  test("mint fact reports every mint step ok in detector order", () => {
    const bytecode = tokenBytecode([
      {
        selector: "0x55a85fc0",
        body: [
          ...ownerGuard(0, 200),
          ...push1(1),
          SLOAD,
          ...Array.from({ length: 9 }, () => [0x80, 0x50]).flat(),
          ...push1(0x04),
          CALLDATALOAD,
          ADD,
          ...Array.from({ length: 9 }, () => [0x80, 0x50]).flat(),
          ...sstoreConstSlot(1, []),
          ...push1(0),
          SLOAD,
          ...push1(0x00),
          MSTORE,
          ...push1(2),
          ...push1(0x20),
          MSTORE,
          ...push1(0x24),
          CALLDATALOAD,
          ...push1(0x40),
          ...push1(0x00),
          KECCAK,
          SSTORE,
          STOP,
        ],
      },
      {
        selector: TRANSFER_SELECTOR,
        body: [...push1(0x04), CALLDATALOAD, ...push1(2), KECCAK, SSTORE, STOP],
      },
      {
        selector: "0x18160ddd",
        body: [...push1(1), SLOAD, STOP],
      },
    ]);
    const [, , , , mint] = explainOf(`0x${Buffer.from(bytecode).toString("hex")}`);
    if (mint === undefined) {
      throw new Error("expected one report per extended detector");
    }
    expect(mint.detector).toBe("dev.brandklipparen.mint");
    expect(mint.steps.map((entry) => entry.step)).toEqual([
      "supply-slot",
      "writer-regions",
      "supply-write",
      "balance-credit",
      "increase-proof",
    ]);
    for (const entry of mint.steps) {
      expect(entry.ok).toBe(true);
    }
    expect(mint.steps[3]?.detail).toContain("stored");
  });

describe("proof step code locations (VS-B1)", () => {
  function realPcs(bytecodeHex: string): Set<number> {
    const parsed = Bytecode.parse(bytecodeHex);
    if (!parsed.ok) {
      throw new Error("fixture bytecode must parse");
    }
    return new Set(disassemble(parsed.value).map((ins) => ins.pc));
  }

  test("proved pause steps carry real instruction locations", () => {
    const bytecodeHex = `0x${Buffer.from(maskedPackedPauseToken()).toString("hex")}`;
    const [pause, blacklist] = explainOf(bytecodeHex);
    if (pause === undefined || blacklist === undefined) {
      throw new Error("expected one report per extended detector");
    }
    for (const entry of pause.steps) {
      expect(entry.ok).toBe(true);
    }
    const pcs = realPcs(bytecodeHex);
    // The owner check, the write, the gate and the reverting jump each
    // name their selector and a real instruction PC.
    for (const entry of [pause.steps[0], pause.steps[3], pause.steps[4], pause.steps[5], pause.steps[6]]) {
      expect(typeof entry?.selector).toBe("string");
      expect(typeof entry?.pc).toBe("number");
      expect(pcs.has(entry?.pc ?? -1)).toBe(true);
    }
    // Aggregate steps prove no single line and carry no location.
    expect(pause.steps[1]?.selector).toBeUndefined();
    expect(pause.steps[1]?.pc).toBeUndefined();
    expect(pause.steps[2]?.selector).toBeUndefined();
    expect(pause.steps[2]?.pc).toBeUndefined();
    // The unproven tail on the sibling report carries no locations.
    const failedIndex = blacklist.steps.findIndex((entry) => !entry.ok);
    expect(failedIndex).toBeGreaterThan(-1);
    for (const entry of blacklist.steps.slice(failedIndex)) {
      expect(entry.selector).toBeUndefined();
      expect(entry.pc).toBeUndefined();
    }
  });

  test("proved blacklist steps carry real instruction locations", () => {
    const bytecodeHex = `0x${Buffer.from(packedMappingBlacklistToken()).toString("hex")}`;
    const [pause, blacklist] = explainOf(bytecodeHex);
    if (pause === undefined || blacklist === undefined) {
      throw new Error("expected one report per extended detector");
    }
    for (const entry of blacklist.steps) {
      expect(entry.ok).toBe(true);
    }
    const pcs = realPcs(bytecodeHex);
    for (const entry of [blacklist.steps[0], blacklist.steps[3], blacklist.steps[4], blacklist.steps[5], blacklist.steps[6]]) {
      expect(typeof entry?.selector).toBe("string");
      expect(typeof entry?.pc).toBe("number");
      expect(pcs.has(entry?.pc ?? -1)).toBe(true);
    }
    expect(blacklist.steps[1]?.selector).toBeUndefined();
    expect(blacklist.steps[1]?.pc).toBeUndefined();
    expect(blacklist.steps[2]?.selector).toBeUndefined();
    expect(blacklist.steps[2]?.pc).toBeUndefined();
    const failedIndex = pause.steps.findIndex((entry) => !entry.ok);
    expect(failedIndex).toBeGreaterThan(-1);
    for (const entry of pause.steps.slice(failedIndex)) {
      expect(entry.selector).toBeUndefined();
      expect(entry.pc).toBeUndefined();
    }
  });

  test("holder burn fails mint at the increase proof", () => {
    const bytecode = tokenBytecode([
      {
        selector: "0x42966c68",
        body: [
          ...ownerGuard(0, 200),
          ...push1(0x04),
          CALLDATALOAD,
          ...push1(1),
          SLOAD,
          SUB,
          ...sstoreConstSlot(1, []),
          ...push1(0x04),
          CALLDATALOAD,
          ...push1(0x00),
          MSTORE,
          ...push1(2),
          ...push1(0x20),
          MSTORE,
          ...push1(0x24),
          CALLDATALOAD,
          ...push1(0x40),
          ...push1(0x00),
          KECCAK,
          SSTORE,
          STOP,
        ],
      },
      {
        selector: TRANSFER_SELECTOR,
        body: [...push1(0x04), CALLDATALOAD, ...push1(2), KECCAK, SSTORE, STOP],
      },
      {
        selector: "0x18160ddd",
        body: [...push1(1), SLOAD, STOP],
      },
    ]);
    const [, , , , mint] = explainOf(`0x${Buffer.from(bytecode).toString("hex")}`);
    if (mint === undefined) {
      throw new Error("expected one report per extended detector");
    }
    // The burn stores supply, credits a balance and carries a guard,
    // but the SUB-driven value never proves an increase.
    expect(firstFailed(mint)).toBe("increase-proof");
  });
});
});
