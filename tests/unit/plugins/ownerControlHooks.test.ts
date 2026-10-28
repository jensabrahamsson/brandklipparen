// Tests for S-115 (K-009, K-010): the transfer-hooks detector plugin
// `dev.brandklipparen.transfer-hooks`. Written first (red) per A-21. The
// shared detector contract proves determinism, schema agreement, evidence
// presence and unchanged inputs; the tests below prove the behaviour:
// external calls reachable in the transfer path report one finding per
// call site with the call kind and the best-effort target source, while a
// transfer path with no calls stays silent.
import { describe, expect, test } from "vitest";
import { Bytecode, CodeHash } from "../../../src/domain/types.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import type { Result } from "../../../src/domain/result.ts";
import { transferHooksDetectorPlugin } from "../../../src/plugins/detectors/transfer-hooks/index.ts";
import { runDetectorPluginContract } from "../../contract/detector.contract.ts";
import {
  CALL,
  CALLDATALOAD,
  DELEGATECALL,
  SLOAD,
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
  test("calls in the transfer path report one finding per site", () => {
    const findings = transferHooksDetectorPlugin.detect(makeInput());
    expect(findings).toHaveLength(3);
    const ids = findings.map((finding) => finding.id).sort();
    expect(ids).toEqual([
      "dev.brandklipparen.transfer-hooks:call",
      "dev.brandklipparen.transfer-hooks:delegatecall",
      "dev.brandklipparen.transfer-hooks:staticcall",
    ]);
    const byId = new Map(findings.map((finding) => [finding.id, finding.payload]));
    expect(byId.get("dev.brandklipparen.transfer-hooks:call")).toEqual({
      feature: "transfer-hooks",
      callKind: "call",
      target: "storage",
    });
    expect(byId.get("dev.brandklipparen.transfer-hooks:staticcall")).toEqual({
      feature: "transfer-hooks",
      callKind: "staticcall",
      target: "constant",
    });
    expect(byId.get("dev.brandklipparen.transfer-hooks:delegatecall")).toEqual({
      feature: "transfer-hooks",
      callKind: "delegatecall",
      target: "unknown",
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
