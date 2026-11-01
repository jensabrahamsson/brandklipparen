// Tests for S-115 (K-009, K-010): the transfer-hooks detector plugin
// `dev.brandklipparen.transfer-hooks`. Written first (red) per A-21. The
// shared detector contract proves determinism, schema agreement, evidence
// presence and unchanged inputs; the tests below prove the behaviour:
// external CALLs to stored or caller-chosen targets in the transfer path
// report one finding with the best-effort target source, while static
// calls, delegatecalls, constant-target calls, unresolvable targets,
// payouts to msg.sender and a transfer path with no calls stay silent.
import { describe, expect, test } from "vitest";
import { Bytecode, CodeHash } from "../../../src/domain/types.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import type { Result } from "../../../src/domain/result.ts";
import { transferHooksDetectorPlugin } from "../../../src/plugins/detectors/transfer-hooks/index.ts";
import { analyzeOwnerControl } from "../../../src/domain/ownerControl.ts";
import { runDetectorPluginContract } from "../../contract/detector.contract.ts";
import {
  CALL,
  CALLDATALOAD,
  CALLER,
  DELEGATECALL,
  KECCAK,
  MSTORE,
  SLOAD,
  SSTORE,
  STATICCALL,
  STOP,
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

const TRANSFER = "0xa9059cbb";
const TRANSFER_FROM = "0x23b872dd";
const HOOKED = "0xd0e30db0";
const WITHDRAW = "0x2e1a7d4d";

const HOOK_ADDRESS = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11, 0x22, 0x33, 0x44];

function callTransferBody(): number[] {
  // Transfer path calls an address loaded from storage slot 8.
  return [
    CALLDATALOAD,
    ...push1(8),
    SLOAD,
    ...push1(0),
    ...push1(0),
    ...push1(0),
    ...push1(0),
    ...push1(0),
    ...push1(0),
    CALL,
    ...sstoreConstSlot(2, [CALLDATALOAD]),
    STOP,
  ];
}

function staticcallTransferBody(): number[] {
  // transferFrom path calls a constant address.
  return [
    CALLDATALOAD,
    0x73, ...HOOK_ADDRESS,
    ...push1(0),
    ...push1(0),
    ...push1(0),
    ...push1(0),
    ...push1(0),
    STATICCALL,
    ...sstoreConstSlot(3, [CALLDATALOAD]),
    STOP,
  ];
}

function delegatecallHookBody(): number[] {
  // Hook-shaped function with an early delegatecall to an unknown target,
  // then transfer-like storage traffic so it counts as a transfer path.
  return [
    ...push1(0),
    ...push1(0),
    DELEGATECALL,
    CALLDATALOAD,
    ...push1(2),
    SLOAD,
    ...sstoreConstSlot(2, [CALLDATALOAD]),
    STOP,
  ];
}

function makeInput(): DetectorInput {
  const bytecode = tokenBytecode([
    { selector: TRANSFER, body: callTransferBody() },
    { selector: TRANSFER_FROM, body: staticcallTransferBody() },
    { selector: HOOKED, body: delegatecallHookBody() },
  ]);
  return Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
}

runDetectorPluginContract(
  "dev.brandklipparen.transfer-hooks",
  transferHooksDetectorPlugin,
  makeInput,
);

describe("transfer-hooks detector plugin", () => {
  test("calls to stored targets report one finding; staticcall and delegatecall stay silent", () => {
    const findings = transferHooksDetectorPlugin.detect(makeInput());
    expect(findings).toHaveLength(1);
    const ids = findings.map((finding) => finding.id).sort();
    expect(ids).toEqual(["dev.brandklipparen.transfer-hooks:call"]);
    const byId = new Map(findings.map((finding) => [finding.id, finding.payload]));
    expect(byId.get("dev.brandklipparen.transfer-hooks:call")).toEqual({
      feature: "transfer-hooks",
      callKind: "call",
      target: "storage",
    });
    for (const finding of findings) {
      expect(finding.evidence).toHaveLength(1);
      expect(typeof finding.evidence[0]?.offset).toBe("number");
    }
  });

  test("transfer path with no calls stays silent", () => {
    const bytecode = tokenBytecode([
      { selector: TRANSFER, body: [CALLDATALOAD, ...sstoreConstSlot(2, [CALLDATALOAD]), STOP] },
    ]);
    const input: DetectorInput = Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
    expect(transferHooksDetectorPlugin.detect(input)).toEqual([]);
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
    expect(transferHooksDetectorPlugin.detect(input)).toEqual([]);
  });
});

describe("transfer-hooks false positives (C-7)", () => {
  function withdrawBody(): number[] {
    // Withdraw-shaped payout: a calldata-keyed mapping store, then a
    // payout to msg.sender pushed 17 instructions before the CALL, past
    // the old 12-instruction window but in the same block. The nearby
    // storage load must not turn the payout into a hook.
    return [
      CALLDATALOAD,
      CALLDATALOAD,
      ...push1(0),
      MSTORE,
      ...push1(2),
      ...push1(0x20),
      MSTORE,
      ...push1(0x40),
      ...push1(0x00),
      KECCAK,
      SSTORE,
      CALLDATALOAD,
      ...push1(9),
      SLOAD,
      CALLER,
      0x80,
      0x80,
      0x80,
      0x80,
      0x80,
      0x80,
      0x80,
      0x80,
      0x80,
      0x80,
      0x80,
      0x80,
      0x80,
      0x80,
      ...push1(8),
      SLOAD,
      CALL,
      STOP,
    ];
  }

  test("withdraw-style payout with a distant caller stays silent", () => {
    const bytecode = tokenBytecode([
      {
        selector: TRANSFER,
        body: [CALLDATALOAD, ...sstoreConstSlot(2, [CALLDATALOAD]), STOP],
      },
      { selector: WITHDRAW, body: withdrawBody() },
    ]);
    const input: DetectorInput = Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
    expect(transferHooksDetectorPlugin.detect(input)).toEqual([]);
  });

  test("call to a caller-chosen argument target still proves a hook", () => {
    const bytecode = tokenBytecode([
      {
        selector: TRANSFER,
        body: [
          CALLDATALOAD,
          0x80,
          0x80,
          0x80,
          CALL,
          ...sstoreConstSlot(2, [CALLDATALOAD]),
          STOP,
        ],
      },
    ]);
    const input: DetectorInput = Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
    const findings = transferHooksDetectorPlugin.detect(input);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ feature: "transfer-hooks", callKind: "call", target: "argument" });
  });

  test("transfer paths need a calldata-keyed mapping write", () => {
    const bytecode = tokenBytecode([
      {
        selector: TRANSFER,
        body: [CALLDATALOAD, ...sstoreConstSlot(2, [CALLDATALOAD]), STOP],
      },
      {
        selector: HOOKED,
        body: [
          CALLDATALOAD,
          CALLDATALOAD,
          ...push1(0),
          MSTORE,
          ...push1(2),
          ...push1(0x20),
          MSTORE,
          ...push1(0x40),
          ...push1(0x00),
          KECCAK,
          SSTORE,
          CALLDATALOAD,
          ...push1(9),
          SLOAD,
          STOP,
        ],
      },
      {
        selector: WITHDRAW,
        body: [
          CALLER,
          ...push1(0),
          MSTORE,
          ...push1(2),
          ...push1(0x20),
          MSTORE,
          ...push1(0x40),
          ...push1(0x00),
          KECCAK,
          SSTORE,
          CALLDATALOAD,
          ...push1(9),
          SLOAD,
          STOP,
        ],
      },
    ]);
    const view = analyzeOwnerControl(bytecode);
    const transfers = view.transfers.map((entry) => entry as string).sort();
    expect(transfers).toEqual([HOOKED, TRANSFER].sort());
  });
});
