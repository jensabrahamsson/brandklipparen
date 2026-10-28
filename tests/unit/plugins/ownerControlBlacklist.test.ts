// Tests for S-115 (K-009, K-010): the blacklist detector plugin
// `dev.brandklipparen.blacklist`. Written first (red) per A-21. The
// shared detector contract proves determinism, schema agreement, evidence
// presence and unchanged inputs; the tests below prove the behaviour: a
// mapping read that gates the transfer path with a revert, paired with a
// privileged mapping write, reports one finding, while an ungated mapping
// read or a privileged write with no transfer gate stays silent.
import { describe, expect, test } from "vitest";
import { Bytecode, CodeHash } from "../../../src/domain/types.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import type { Result } from "../../../src/domain/result.ts";
import { blacklistDetectorPlugin } from "../../../src/plugins/detectors/blacklist/index.ts";
import { runDetectorPluginContract } from "../../contract/detector.contract.ts";
import {
  CALLDATALOAD,
  ISZERO,
  JUMPI,
  KECCAK,
  REVERT,
  SLOAD,
  SSTORE,
  STOP,
  ownerGuard,
  push1,
  tokenBytecode,
} from "../../helpers/ownerControlFixtures.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

const SET_STATUS = "0x0a9c6c1e";
const TRANSFER = "0xa9059cbb";

function gatedTransferBody(): number[] {
  // Transfer path reads a mapping entry and reverts when it is set.
  return [
    CALLDATALOAD,
    ...push1(3),
    KECCAK,
    SLOAD,
    ISZERO,
    ...push1(90),
    JUMPI,
    ...push1(0),
    0x80,
    REVERT,
    0x5b,
    ...push1(2),
    SSTORE,
    STOP,
  ];
}

function setterBody(): number[] {
  // Privileged mapping write to the same hashed slot family.
  return [
    ...ownerGuard(0, 200),
    CALLDATALOAD,
    ...push1(1),
    ...push1(3),
    KECCAK,
    SSTORE,
    STOP,
  ];
}

function makeInput(): DetectorInput {
  const bytecode = tokenBytecode([
    { selector: SET_STATUS, body: setterBody() },
    { selector: TRANSFER, body: gatedTransferBody() },
  ]);
  return Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
}

runDetectorPluginContract("dev.brandklipparen.blacklist", blacklistDetectorPlugin, makeInput);

describe("blacklist detector plugin", () => {
  test("gated mapping read with a privileged writer reports one finding", () => {
    const findings = blacklistDetectorPlugin.detect(makeInput());
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (finding === undefined) {
      throw new Error("expected exactly one finding");
    }
    expect(finding.id).toBe("dev.brandklipparen.blacklist:blacklist");
    expect(finding.payload).toEqual({ feature: "blacklist" });
    const selectors = finding.evidence.map((entry) => entry.selector as string).sort();
    expect(selectors).toEqual([SET_STATUS, TRANSFER].sort());
    for (const entry of finding.evidence) {
      expect(typeof entry.offset).toBe("number");
    }
  });

  test("ungated mapping read stays silent", () => {
    // Mapping read with no revert gate: no block is proven.
    const bytecode = tokenBytecode([
      { selector: SET_STATUS, body: setterBody() },
      {
        selector: TRANSFER,
        body: [CALLDATALOAD, ...push1(3), KECCAK, SLOAD, ...push1(2), SSTORE, STOP],
      },
    ]);
    const input: DetectorInput = Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
    expect(blacklistDetectorPlugin.detect(input)).toEqual([]);
  });

  test("gated read with no privileged writer stays silent", () => {
    const bytecode = tokenBytecode([
      {
        selector: SET_STATUS,
        body: [CALLDATALOAD, ...push1(1), ...push1(3), KECCAK, SSTORE, STOP],
      },
      { selector: TRANSFER, body: gatedTransferBody() },
    ]);
    const input: DetectorInput = Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
    expect(blacklistDetectorPlugin.detect(input)).toEqual([]);
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
    expect(blacklistDetectorPlugin.detect(input)).toEqual([]);
  });
});
