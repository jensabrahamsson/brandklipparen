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
  EXP_PAUSE_SET,
  ISZERO,
  PACKED_PAUSE_SET,
  REVERT,
  SLOAD,
  STOP,
  ownerGuard,
  expPackedPauseToken,
  packedPauseToken,
  push1,
  sstoreConstSlot,
  tokenBytecode,
  branchOk,
} from "../../helpers/ownerControlFixtures.ts";

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
    // The setters shift the bit with `PUSH 0x02 PUSH k EXP` (2**k) and
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
