// Tests for S-115 (K-009, K-010): the transfer-fee detector plugin
// `dev.brandklipparen.transfer-fee`. Written first (red) per A-21. The
// shared detector contract proves determinism, schema agreement, evidence
// presence and unchanged inputs; the tests below prove the behaviour: a
// privileged fee-slot write used arithmetically in the transfer path
// reports one finding with the max-fee bound when the setter compares
// against a constant, and a null bound when it does not. A fee slot the
// transfer path never computes with, or arithmetic with no privileged
// writer, stays silent.
import { describe, expect, test } from "vitest";
import { Bytecode, CodeHash } from "../../../src/domain/types.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import type { Result } from "../../../src/domain/result.ts";
import { transferFeeDetectorPlugin } from "../../../src/plugins/detectors/transfer-fee/index.ts";
import { runDetectorPluginContract } from "../../contract/detector.contract.ts";
import {
  CALLDATALOAD,
  GT,
  ISZERO,
  LT,
  MUL,
  REVERT,
  SLOAD,
  STOP,
  SUB,
  branchOk,
  ownerGuard,
  push1,
  sstoreConstSlot,
  tokenBytecode,
} from "../../helpers/ownerControlFixtures.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

const SET_FEE = "0x0a9c6c1e";
const TRANSFER = "0xa9059cbb";

function setterBody(): number[] {
  // onlyOwner guard over slot 0, a cap compare against 250, then the fee
  // slot 5 write.
  return [
    ...ownerGuard(0, 200),
    CALLDATALOAD,
    ...push1(250),
    LT,
    ISZERO,
    ...branchOk(),
    ...push1(0),
    0x80,
    REVERT,
    0x5b,
    ...sstoreConstSlot(5, [CALLDATALOAD]),
    STOP,
  ];
}

function feeTransferBody(): number[] {
  // Transfer path multiplies by fee slot 5 and subtracts the fee.
  return [
    CALLDATALOAD,
    ...push1(5),
    SLOAD,
    MUL,
    SUB,
    ...sstoreConstSlot(2, [CALLDATALOAD]),
    STOP,
  ];
}

function makeInput(): DetectorInput {
  const bytecode = tokenBytecode([
    { selector: SET_FEE, body: setterBody() },
    { selector: TRANSFER, body: feeTransferBody() },
  ]);
  return Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
}

runDetectorPluginContract("dev.brandklipparen.transfer-fee", transferFeeDetectorPlugin, makeInput);

describe("transfer-fee detector plugin", () => {
  test("fee write used arithmetically reports one finding with the bound", () => {
    const findings = transferFeeDetectorPlugin.detect(makeInput());
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (finding === undefined) {
      throw new Error("expected exactly one finding");
    }
    expect(finding.id).toBe("dev.brandklipparen.transfer-fee:transfer-fee");
    expect(finding.payload).toEqual({ feature: "transfer-fee", slot: 5, maxFeeBasisPoints: 250 });
    const selectors = finding.evidence.map((entry) => entry.selector as string).sort();
    expect(selectors).toEqual([SET_FEE, TRANSFER].sort());
  });

  test("setter without a constant compare reports a null bound", () => {
    // Same fee write with no LT/GT cap compare: the bound is unknown.
    const bytecode = tokenBytecode([
      {
        selector: SET_FEE,
        body: [...ownerGuard(0, 200), ...sstoreConstSlot(5, [CALLDATALOAD]), STOP],
      },
      { selector: TRANSFER, body: feeTransferBody() },
    ]);
    const input: DetectorInput = Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
    const findings = transferFeeDetectorPlugin.detect(input);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ feature: "transfer-fee", slot: 5, maxFeeBasisPoints: null });
  });

  test("fee slot never computed with stays silent", () => {
    const bytecode = tokenBytecode([
      { selector: SET_FEE, body: setterBody() },
      {
        selector: TRANSFER,
        body: [CALLDATALOAD, ...sstoreConstSlot(2, [CALLDATALOAD]), STOP],
      },
    ]);
    const input: DetectorInput = Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
    expect(transferFeeDetectorPlugin.detect(input)).toEqual([]);
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
    expect(transferFeeDetectorPlugin.detect(input)).toEqual([]);
  });
});

const DUP1 = 0x80;
const DUP2 = 0x81;
const POP = 0x50;

// Honest-stack bodies: every CALLDATALOAD consumes a pushed offset. The
// slot push sits apart from its load behind a stack-neutral dup, so the
// scored adjacent-push window stays blind while the extended interpreter
// still resolves the constant slot.
function shuffledLoad(slot: number): number[] {
  return [...push1(0x04), CALLDATALOAD, ...push1(slot), DUP1, POP, SLOAD];
}

describe("transfer-fee extended fact (P-11)", () => {
  const RATE_SET = "0x0a9c6c1e";

  function setterBody(): number[] {
    return [
      ...ownerGuard(0, 200),
      ...push1(0x04),
      CALLDATALOAD,
      ...push1(250),
      LT,
      ISZERO,
      ...branchOk(),
      ...push1(0),
      0x80,
      REVERT,
      0x5b,
      ...sstoreConstSlot(5, [...push1(0x04), CALLDATALOAD]),
      ...sstoreConstSlot(6, [...push1(0x24), CALLDATALOAD]),
      STOP,
    ];
  }

  function transferBody(): number[] {
    return [
      ...shuffledLoad(5),
      DUP2,
      MUL,
      SUB,
      ...sstoreConstSlot(2, [...push1(0x04), CALLDATALOAD]),
      ...shuffledLoad(6),
      GT,
      ...branchOk(),
      ...sstoreConstSlot(8, [...push1(0x04), CALLDATALOAD]),
      0x5b,
      STOP,
    ];
  }

  function extendedInput(
    parts: readonly { selector: string; body: readonly number[] }[],
  ): DetectorInput {
    const bytecode = tokenBytecode(parts);
    return Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
  }

  test("shuffled rate slot with a cap reports the rate and cap slots", () => {
    const input = extendedInput([
      { selector: RATE_SET, body: setterBody() },
      { selector: TRANSFER, body: transferBody() },
    ]);
    const findings = transferFeeDetectorPlugin.detect(input);
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (finding === undefined) {
      throw new Error("expected exactly one finding");
    }
    expect(finding.id).toBe("dev.brandklipparen.transfer-fee:transfer-fee-extended");
    expect(finding.payload).toEqual({
      fact: "transfer-fee",
      slot: 5,
      capSlot: 6,
      proof: "extended",
    });
  });

  test("fee arithmetic with no privileged writer stays silent", () => {
    const input = extendedInput([
      {
        selector: RATE_SET,
        body: [...sstoreConstSlot(5, [...push1(0x04), CALLDATALOAD]), STOP],
      },
      { selector: TRANSFER, body: transferBody() },
    ]);
    expect(transferFeeDetectorPlugin.detect(input)).toEqual([]);
  });
});
