// Tests for S-115 (K-009, K-010): the pause detector plugin
// `dev.brandklipparen.pause`. Written first (red) per A-21. The shared
// detector contract proves determinism, schema agreement, evidence
// presence and unchanged inputs; the tests below prove the behaviour: a
// privileged boolean-slot write gating the transfer path reports one
// finding, with the one-way trading-toggle mode when the setter never
// writes zero and the pause mode when it does. An ungated flag, or a
// gate with no privileged writer, stays silent.
import { describe, expect, test } from "vitest";
import { Bytecode, CodeHash } from "../../../src/domain/types.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import { validatePluginOutput } from "../../../src/plugins/detector.ts";
import type { Result } from "../../../src/domain/result.ts";
import { pauseDetectorPlugin } from "../../../src/plugins/detectors/pause/index.ts";
import { runDetectorPluginContract } from "../../contract/detector.contract.ts";
import {
  CALLDATALOAD,
  CALLER,
  EQ,
  EXP_PAUSE_SET,
  ISZERO,
  MASKED_PAUSE_CLEAR,
  MASKED_PAUSE_SET,
  PACKED_PAUSE_SET,
  PUSH0,
  REVERT,
  SLOAD,
  SSTORE,
  STOP,
  ownerGuard,
  expGatedTransferBody,
  expPackedPauseToken,
  maskedPackedPauseToken,
  maskedPauseClearBody,
  maskedPauseSetBody,
  packedPauseToken,
  push1,
  sstoreConstSlot,
  tokenBytecode,
  branchOk,
} from "../../helpers/ownerControlFixtures.ts";
import { ownershipDetectorPlugin } from "../../../src/plugins/detectors/ownership/index.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

const SET_PAUSE = "0x0a9c6c1e";
const TRANSFER = "0xa9059cbb";

function gatedTransferBody(): number[] {
  // Transfer path reverts while flag slot 4 reads set.
  return [
    ...push1(4),
    SLOAD,
    ISZERO,
    ...branchOk(),
    ...push1(0),
    0x80,
    REVERT,
    0x5b,
    ...sstoreConstSlot(2, [CALLDATALOAD]),
    STOP,
  ];
}

function oneWaySetterBody(): number[] {
  // onlyOwner guard, then a one-way enable of flag slot 4.
  return [...ownerGuard(0, 200), ...sstoreConstSlot(4, [...push1(1)]), STOP];
}

function makeInput(): DetectorInput {
  const bytecode = tokenBytecode([
    { selector: SET_PAUSE, body: oneWaySetterBody() },
    { selector: TRANSFER, body: gatedTransferBody() },
  ]);
  return Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
}

runDetectorPluginContract("dev.brandklipparen.pause", pauseDetectorPlugin, makeInput);

describe("pause detector plugin", () => {
  test("one-way enable reports the trading-toggle mode", () => {
    const findings = pauseDetectorPlugin.detect(makeInput());
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (finding === undefined) {
      throw new Error("expected exactly one finding");
    }
    expect(finding.id).toBe("dev.brandklipparen.pause:pause");
    expect(finding.payload).toEqual({ feature: "pause", slot: 4, mode: "trading-toggle" });
    const selectors = finding.evidence.map((entry) => entry.selector as string).sort();
    expect(selectors).toEqual([SET_PAUSE, TRANSFER].sort());
  });

  test("reversible flag reports the pause mode", () => {
    // The setter writes both one and zero: the flag flips both ways.
    const bytecode = tokenBytecode([
      {
        selector: SET_PAUSE,
        body: [
          ...ownerGuard(0, 200),
          ...sstoreConstSlot(4, [...push1(1)]),
          ...sstoreConstSlot(4, [...push1(0)]),
          STOP,
        ],
      },
      { selector: TRANSFER, body: gatedTransferBody() },
    ]);
    const input: DetectorInput = Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
    const findings = pauseDetectorPlugin.detect(input);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ feature: "pause", slot: 4, mode: "pause" });
  });

  test("ungated flag stays silent", () => {
    const bytecode = tokenBytecode([
      { selector: SET_PAUSE, body: oneWaySetterBody() },
      {
        selector: TRANSFER,
        body: [CALLDATALOAD, ...sstoreConstSlot(2, [CALLDATALOAD]), STOP],
      },
    ]);
    const input: DetectorInput = Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
    expect(pauseDetectorPlugin.detect(input)).toEqual([]);
  });

  test("bytecode without selectors yields no findings", () => {
    const parsed = Bytecode.parse("0x6001600055");
    if (!parsed.ok) {
      throw new Error("fixture bytecode must parse");
    }
    const input: DetectorInput = Object.freeze({
      bytecode: parsed.value,
      codeHash: mustOk(CodeHash.of(parsed.value)),
    });
    expect(pauseDetectorPlugin.detect(input)).toEqual([]);
  });
});

describe("pause extended analysis (P-11)", () => {
  function packedInput(): DetectorInput {
    const bytecode = packedPauseToken();
    return Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
  }

  test("packed owner|paused slot-0 pause/unpause reports an extended fact, never a feature", () => {
    // The packed stores carry no adjacent value PUSH, so the v1 proof
    // stays silent and only the v2 packed-bool read proves the writer.
    // The set/unset pair writes both bit values, so the mode is pause.
    const findings = pauseDetectorPlugin.detect(packedInput());
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (finding === undefined) {
      throw new Error("expected exactly one finding");
    }
    expect(finding.id).toBe("dev.brandklipparen.pause:pause-extended");
    expect(finding.payload).toEqual({ fact: "pause", slot: 0, mode: "pause", proof: "extended" });
    const selectors = finding.evidence.map((entry) => entry.selector as string).sort();
    expect(selectors).toEqual([PACKED_PAUSE_SET, TRANSFER].sort());
    for (const entry of finding.evidence) {
      expect(typeof entry.offset).toBe("number");
    }
  });

  test("extended fact payload validates against the manifest output schema", () => {
    const findings = pauseDetectorPlugin.detect(packedInput());
    const plain = JSON.parse(JSON.stringify(findings)) as unknown;
    expect(validatePluginOutput(plain, pauseDetectorPlugin.manifest.outputSchema)).toBe(true);
  });

  test("old-solc EXP-shift packed pause reports an extended fact, never a feature", () => {
    // The setters shift the bit with `PUSH k PUSH 0x02 EXP` (2**k,
    // exponent first as solc emits it) and
    // the transfer path reads the same slot and bit back through DIV by
    // the same shift, AND with 0xff and a reverting gate. The v1 proof
    // stays silent (no plain flag value sits beside the stores) while
    // the extended proof pairs the set/unset writers with the gate, so
    // the mode is pause.
    const bytecode = expPackedPauseToken();
    const input: DetectorInput = Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
    const findings = pauseDetectorPlugin.detect(input);
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (finding === undefined) {
      throw new Error("expected exactly one finding");
    }
    expect(finding.id).toBe("dev.brandklipparen.pause:pause-extended");
    expect(finding.payload).toEqual({ fact: "pause", slot: 0, mode: "pause", proof: "extended" });
    expect(finding.evidence[0]?.selector).toBe(EXP_PAUSE_SET);
    const selectors = finding.evidence.map((entry) => entry.selector as string).sort();
    expect(selectors).toEqual([EXP_PAUSE_SET, TRANSFER].sort());
    const plain = JSON.parse(JSON.stringify(findings)) as unknown;
    expect(validatePluginOutput(plain, pauseDetectorPlugin.manifest.outputSchema)).toBe(true);
  });
});

describe("pause masked packed write (P-11 follow-up)", () => {
  function maskedInput(): DetectorInput {
    const bytecode = maskedPackedPauseToken();
    return Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
  }

  test("masked old-solc pause with a computed write value reports an extended fact", () => {
    // Both stores write a computed word (`(SLOAD & ~mask) | (1 << k)`
    // and its clear), so no constant sits beside either store and the
    // value filter never sees slot 0. The extended masked proof resolves
    // the set to bit 1 and the clear to bit 0, pairs the set writer with
    // the gate reading the same slot and bit, and reports pause.
    const findings = pauseDetectorPlugin.detect(maskedInput());
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (finding === undefined) {
      throw new Error("expected exactly one finding");
    }
    expect(finding.id).toBe("dev.brandklipparen.pause:pause-extended");
    expect(finding.payload).toEqual({ fact: "pause", slot: 0, mode: "pause", proof: "extended" });
    const selectors = finding.evidence.map((entry) => entry.selector as string).sort();
    expect(selectors).toEqual([MASKED_PAUSE_SET, TRANSFER].sort());
    for (const entry of finding.evidence) {
      expect(typeof entry.offset).toBe("number");
    }
    const plain = JSON.parse(JSON.stringify(findings)) as unknown;
    expect(validatePluginOutput(plain, pauseDetectorPlugin.manifest.outputSchema)).toBe(true);
  });

  test("masked writer on another bit than the gate stays silent", () => {
    // The writers set and clear bit 9 while the transfer path gates on
    // bit 8: same slot, different bit, so no pair is proven.
    const bytecode = tokenBytecode([
      { selector: MASKED_PAUSE_SET, body: maskedPauseSetBody(9) },
      { selector: MASKED_PAUSE_CLEAR, body: maskedPauseClearBody(9) },
      { selector: TRANSFER, body: expGatedTransferBody(8) },
    ]);
    const input: DetectorInput = Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
    expect(pauseDetectorPlugin.detect(input)).toEqual([]);
  });
});

describe("pause owner-seat silence (F-10e)", () => {
  const DUP1 = 0x80;
  const SWAP1 = 0x90;
  const RENOUNCE = "0x44444444";
  const GUARDED_MOVE = "0x55555555";

  function renounceBody(): number[] {
    // onlyOwner guard, then a zero write to the owner slot.
    return [...ownerGuard(0, 200), PUSH0, ...push1(0), SSTORE, STOP];
  }

  function guardedMoveBody(): number[] {
    // onlyOwner guard, then a plain balance write: an owner-gated
    // transfer-shaped function with no flag of its own.
    return [...ownerGuard(0, 200), ...sstoreConstSlot(2, [CALLDATALOAD]), STOP];
  }

  test("plain Ownable with renounce reports no pause", () => {
    // The renounce writes zero to the owner seat, and the guarded
    // transfer carries the owner check itself. Neither proves a pause
    // flag, while the ownership proof still reports the slot and the
    // renounce path.
    const bytecode = tokenBytecode([
      { selector: RENOUNCE, body: renounceBody() },
      { selector: TRANSFER, body: guardedMoveBody() },
    ]);
    const input: DetectorInput = Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
    expect(pauseDetectorPlugin.detect(input)).toEqual([]);
    const owned = ownershipDetectorPlugin.detect(input);
    expect(owned.map((finding) => finding.id).sort()).toEqual([
      "dev.brandklipparen.ownership:owner-slot",
      "dev.brandklipparen.ownership:renounce",
    ]);
  });

  test("an owner check used as the gate reports no pause", () => {
    // The guarded slot proves as the caller-compared slot, so the
    // writer's constant store to it is not a flag write, while the
    // transfer path gates on its own caller compare. The caller compare
    // is access control, not a pause gate.
    const bytecode = tokenBytecode([
      {
        selector: GUARDED_MOVE,
        body: [
          CALLER,
          ...push1(7),
          DUP1,
          SWAP1,
          SLOAD,
          EQ,
          ...branchOk(),
          ...push1(0),
          DUP1,
          REVERT,
          0x5b,
          ...sstoreConstSlot(4, [...push1(1)]),
          STOP,
        ],
      },
      {
        selector: TRANSFER,
        body: [
          CALLER,
          ...push1(4),
          SLOAD,
          EQ,
          ...branchOk(),
          ...push1(0),
          DUP1,
          REVERT,
          0x5b,
          ...sstoreConstSlot(2, [CALLDATALOAD]),
          STOP,
        ],
      },
    ]);
    const input: DetectorInput = Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
    expect(pauseDetectorPlugin.detect(input)).toEqual([]);
  });
});
