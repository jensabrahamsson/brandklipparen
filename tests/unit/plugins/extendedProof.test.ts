// Tests for the extended-proof diagnostics (P-11 follow-up): the pure
// per-detector reports in `src/plugins/detectors/extendedProof.ts`.
// Behaviour under test, not implementation: found facts report every
// step ok in detector order, and silent cases name the first step that
// failed. All fixtures are synthetic hand-assembled dispatchers; no real
// bytecode, no addresses, no network.
import { describe, expect, test } from "vitest";
import { Bytecode } from "../../../src/domain/types.ts";
import { explainExtendedProof } from "../../../src/plugins/detectors/extendedProof.ts";
import type { ExtendedProof } from "../../../src/plugins/detectors/extendedProof.ts";
import {
  AND,
  CALLDATALOAD,
  DIV,
  EXP,
  ISZERO,
  KECCAK,
  MSTORE,
  PACKED_MAPPING_SET,
  SLOAD,
  SSTORE,
  STOP,
  TRANSFER_SELECTOR,
  branchOk,
  maskedPackedPauseToken,
  ownerGuard,
  packedMappingBlacklistToken,
  packedPauseToken,
  push1,
  sharedBaseGateTokenHex,
  sharedBlacklistTokenHex,
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
});
