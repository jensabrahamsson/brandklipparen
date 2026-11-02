// Tests for S-115 (K-009, K-010): the transfer-limits detector plugin
// `dev.brandklipparen.transfer-limits`. Written first (red) per A-21. The
// shared detector contract proves determinism, schema agreement, evidence
// presence and unchanged inputs; the tests below prove the behaviour: a
// privileged limit-slot write compared in the transfer path reports one
// finding naming the limit kind, while a compare with no privileged
// writer, or a privileged write the transfer path never compares against,
// stays silent.
import { describe, expect, test } from "vitest";
import { Bytecode, CodeHash } from "../../../src/domain/types.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import type { Result } from "../../../src/domain/result.ts";
import { transferLimitsDetectorPlugin } from "../../../src/plugins/detectors/transfer-limits/index.ts";
import { runDetectorPluginContract } from "../../contract/detector.contract.ts";
import {
  CALLDATALOAD,
  GT,
  ISZERO,
  KECCAK,
  LT,
  MUL,
  REVERT,
  SLOAD,
  STOP,
  SUB,
  ownerGuard,
  push1,
  sharedLimitGateTokenHex,
  sstoreConstSlot,
  tokenBytecode,
  branchOk,
  compoundGuardLimitTokenHex,
} from "../../helpers/ownerControlFixtures.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

const SET_LIMIT = "0x0a9c6c1e";
const TRANSFER = "0xa9059cbb";

function maxTxTransferBody(): number[] {
  // Transfer path reverts when the calldata amount exceeds limit slot 6.
  return [
    CALLDATALOAD,
    ...push1(6),
    SLOAD,
    LT,
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

function maxTxSetterBody(): number[] {
  return [...ownerGuard(0, 200), ...sstoreConstSlot(6, [CALLDATALOAD]), STOP];
}

function makeInput(): DetectorInput {
  const bytecode = tokenBytecode([
    { selector: SET_LIMIT, body: maxTxSetterBody() },
    { selector: TRANSFER, body: maxTxTransferBody() },
  ]);
  return Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
}

runDetectorPluginContract(
  "dev.brandklipparen.transfer-limits",
  transferLimitsDetectorPlugin,
  makeInput,
);

describe("transfer-limits detector plugin", () => {
  test("max-tx compare with a privileged writer reports the max-tx kind", () => {
    const findings = transferLimitsDetectorPlugin.detect(makeInput());
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (finding === undefined) {
      throw new Error("expected exactly one finding");
    }
    expect(finding.id).toBe("dev.brandklipparen.transfer-limits:transfer-limits");
    expect(finding.payload).toEqual({ feature: "transfer-limits", slot: 6, limitKind: "max-tx" });
    const selectors = finding.evidence.map((entry) => entry.selector as string).sort();
    expect(selectors).toEqual([SET_LIMIT, TRANSFER].sort());
  });

  test("balance compare with a privileged writer reports the max-wallet kind", () => {
    // Transfer path reads a balance mapping entry and compares it against
    // limit slot 7.
    const bytecode = tokenBytecode([
      {
        selector: SET_LIMIT,
        body: [...ownerGuard(0, 200), ...sstoreConstSlot(7, [CALLDATALOAD]), STOP],
      },
      {
        selector: TRANSFER,
        body: [
          CALLDATALOAD,
          ...push1(2),
          KECCAK,
          SLOAD,
          ...push1(7),
          SLOAD,
          GT,
          ...branchOk(),
          ...push1(0),
          0x80,
          REVERT,
          0x5b,
          ...sstoreConstSlot(2, [CALLDATALOAD]),
          STOP,
        ],
      },
    ]);
    const input: DetectorInput = Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
    const findings = transferLimitsDetectorPlugin.detect(input);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ feature: "transfer-limits", slot: 7, limitKind: "max-wallet" });
  });

  test("compare with no privileged writer stays silent", () => {
    const bytecode = tokenBytecode([
      {
        selector: SET_LIMIT,
        body: [CALLDATALOAD, ...sstoreConstSlot(6, [CALLDATALOAD]), STOP],
      },
      { selector: TRANSFER, body: maxTxTransferBody() },
    ]);
    const input: DetectorInput = Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
    expect(transferLimitsDetectorPlugin.detect(input)).toEqual([]);
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
    expect(transferLimitsDetectorPlugin.detect(input)).toEqual([]);
  });
});

const DUP1 = 0x80;
const POP = 0x50;

// Honest-stack bodies: every CALLDATALOAD consumes a pushed offset. The
// slot push sits apart from its load behind a stack-neutral dup, so the
// scored adjacent-push window stays blind while the extended interpreter
// still resolves the constant slot.
function shuffledLoad(slot: number): number[] {
  return [...push1(0x04), CALLDATALOAD, ...push1(slot), DUP1, POP, SLOAD];
}

describe("transfer-limits extended precision (P-11)", () => {
  function extendedInput(
    parts: readonly { selector: string; body: readonly number[] }[],
  ): DetectorInput {
    const bytecode = tokenBytecode(parts);
    return Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
  }

  test("shuffled max-tx compare with a reverting gate reports an extended fact", () => {
    const input = extendedInput([
      {
        selector: SET_LIMIT,
        body: [...ownerGuard(0, 200), ...sstoreConstSlot(6, [...push1(0x04), CALLDATALOAD]), STOP],
      },
      {
        selector: TRANSFER,
        body: [
          ...shuffledLoad(6),
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
    const findings = transferLimitsDetectorPlugin.detect(input);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("dev.brandklipparen.transfer-limits:transfer-limits-extended");
    expect(findings[0]?.payload).toEqual({
      fact: "transfer-limits",
      slot: 6,
      limitKind: "max-tx",
      proof: "extended",
    });
  });

  test("a fee clamp beside an underflow revert is arithmetic, not a limit", () => {
    // The guarded setter owns a rate and a cap; the transfer multiplies by
    // the rate, clamps the computed fee without reverting, then checks the
    // books for underflow with a revert. The cap compare gates a computed
    // fee, never the transferred amount, so the fee fact fires while no
    // limits fact fires, even though a reverting jump sits nearby.
    const input = extendedInput([
      {
        selector: SET_LIMIT,
        body: [
          ...ownerGuard(0, 200),
          ...sstoreConstSlot(5, [...push1(0x04), CALLDATALOAD]),
          ...sstoreConstSlot(4, [...push1(0x24), CALLDATALOAD]),
          STOP,
        ],
      },
      {
        selector: TRANSFER,
        body: [
          ...shuffledLoad(5),
          MUL,
          ...push1(4),
          DUP1,
          POP,
          SLOAD,
          GT,
          ...branchOk(),
          ...sstoreConstSlot(8, [...push1(0x04), CALLDATALOAD]),
          0x5b,
          ...push1(0x04),
          CALLDATALOAD,
          DUP1,
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
    const findings = transferLimitsDetectorPlugin.detect(input);
    expect(findings.filter((finding) => finding.pluginId === "dev.brandklipparen.transfer-limits")).toEqual(
      [],
    );
  });
});

describe("transfer-limits shared wallet gate (SCAN-1)", () => {
  test("balance-plus-amount limit in a shared helper reports an extended fact", () => {
    const parsed = Bytecode.parse(sharedLimitGateTokenHex());
    if (!parsed.ok) {
      throw new Error("fixture bytecode must parse");
    }
    const input: DetectorInput = Object.freeze({
      bytecode: parsed.value,
      codeHash: mustOk(CodeHash.of(parsed.value)),
    });
    const findings = transferLimitsDetectorPlugin.detect(input);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("dev.brandklipparen.transfer-limits:transfer-limits-extended");
    expect(findings[0]?.payload).toEqual({
      fact: "transfer-limits",
      slot: 6,
      limitKind: "max-wallet",
      proof: "extended",
    });
  });
});

describe("transfer-limits compound guard (SCAN-2)", () => {
  test("compound owner-or-role guard proves the limit writer", () => {
    const parsed = Bytecode.parse(compoundGuardLimitTokenHex());
    if (!parsed.ok) {
      throw new Error("fixture bytecode must parse");
    }
    const input: DetectorInput = Object.freeze({
      bytecode: parsed.value,
      codeHash: mustOk(CodeHash.of(parsed.value)),
    });
    const findings = transferLimitsDetectorPlugin.detect(input);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("dev.brandklipparen.transfer-limits:transfer-limits-extended");
    expect(findings[0]?.payload).toEqual({
      fact: "transfer-limits",
      slot: 6,
      limitKind: "max-tx",
      proof: "extended",
    });
  });
});
