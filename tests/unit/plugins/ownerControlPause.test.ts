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
import type { Result } from "../../../src/domain/result.ts";
import { pauseDetectorPlugin } from "../../../src/plugins/detectors/pause/index.ts";
import { runDetectorPluginContract } from "../../contract/detector.contract.ts";
import {
  CALLDATALOAD,
  ISZERO,
  REVERT,
  SLOAD,
  STOP,
  ownerGuard,
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
