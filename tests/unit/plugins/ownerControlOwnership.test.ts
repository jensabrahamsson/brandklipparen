// Tests for S-115 (K-009, K-010): the ownership detector plugin
// `dev.brandklipparen.ownership`. Written first (red) per A-21. The
// shared detector contract proves determinism, schema agreement, evidence
// presence and unchanged inputs; the tests below prove the behaviour: an
// owner slot compared against the caller with a zero-writing renounce
// path reports both findings, a guarded slot with no renounce path
// reports only the owner slot, and bytecode with no caller compare stays
// silent.
import { describe, expect, test } from "vitest";
import { Bytecode, CodeHash } from "../../../src/domain/types.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import type { Result } from "../../../src/domain/result.ts";
import { ownershipDetectorPlugin } from "../../../src/plugins/detectors/ownership/index.ts";
import { runDetectorPluginContract } from "../../contract/detector.contract.ts";
import {
  CALLDATALOAD,
  CALLER,
  EQ,
  PUSH0,
  REVERT,
  SLOAD,
  SSTORE,
  STOP,
  branchOk,
  ownerGuard,
  push1,
  sstoreConstSlot,
  tokenBytecode,
} from "../../helpers/ownerControlFixtures.ts";
import { analyzeOwnerControl } from "../../../src/domain/ownerControl.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

const SET_ADMIN = "0x40c10f19";
const RENOUNCE = "0x715018a6";
const TRANSFER = "0xa9059cbb";

function guardedAdminBody(): number[] {
  return [...ownerGuard(0, 200), ...sstoreConstSlot(9, [CALLDATALOAD]), STOP];
}

function renounceBody(): number[] {
  // onlyOwner guard, then a zero write to the owner slot.
  return [...ownerGuard(0, 200), PUSH0, ...push1(0), SSTORE, STOP];
}

function makeInput(): DetectorInput {
  const bytecode = tokenBytecode([
    { selector: SET_ADMIN, body: guardedAdminBody() },
    { selector: RENOUNCE, body: renounceBody() },
    { selector: TRANSFER, body: [CALLDATALOAD, ...sstoreConstSlot(2, [CALLDATALOAD]), STOP] },
  ]);
  return Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
}

runDetectorPluginContract("dev.brandklipparen.ownership", ownershipDetectorPlugin, makeInput);

describe("ownership detector plugin", () => {
  test("owner slot with a renounce path reports both findings", () => {
    const findings = ownershipDetectorPlugin.detect(makeInput());
    expect(findings).toHaveLength(2);
    const ids = findings.map((finding) => finding.id).sort();
    expect(ids).toEqual([
      "dev.brandklipparen.ownership:owner-slot",
      "dev.brandklipparen.ownership:renounce",
    ]);
    const ownerFinding = findings.find((finding) => finding.id.endsWith(":owner-slot"));
    expect(ownerFinding?.payload).toEqual({ feature: "owner-slot", slot: 0, privilegedFunctions: 2 });
    for (const entry of ownerFinding?.evidence ?? []) {
      expect(entry.selector as string).toMatch(/^0x[0-9a-f]{8}$/);
      expect(typeof entry.offset).toBe("number");
    }
    const renounceFinding = findings.find((finding) => finding.id.endsWith(":renounce"));
    expect(renounceFinding?.payload).toEqual({ feature: "renounce", slot: 0, privilegedFunctions: null });
  });

  test("guarded slot with no renounce path reports only the owner slot", () => {
    const bytecode = tokenBytecode([
      { selector: SET_ADMIN, body: guardedAdminBody() },
      { selector: TRANSFER, body: [CALLDATALOAD, ...sstoreConstSlot(2, [CALLDATALOAD]), STOP] },
    ]);
    const input: DetectorInput = Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
    const findings = ownershipDetectorPlugin.detect(input);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("dev.brandklipparen.ownership:owner-slot");
  });

  test("bytecode with no caller compare stays silent", () => {
    const bytecode = tokenBytecode([
      {
        selector: SET_ADMIN,
        body: [CALLDATALOAD, ...sstoreConstSlot(9, [CALLDATALOAD]), STOP],
      },
      { selector: TRANSFER, body: [CALLDATALOAD, ...sstoreConstSlot(2, [CALLDATALOAD]), STOP] },
    ]);
    const input: DetectorInput = Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
    expect(ownershipDetectorPlugin.detect(input)).toEqual([]);
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
    expect(ownershipDetectorPlugin.detect(input)).toEqual([]);
  });
});

describe("ownership caller-compare loads (F-10c)", () => {
  const DUP1 = 0x80;
  const SWAP1 = 0x90;

  // A packed-owner guard where the slot push is shuffled behind DUP and
  // SWAP, so the legacy window proof never resolves the slot: CALLER,
  // PUSH slot, DUP, SWAP, SLOAD, EQ with a reverting branch, then a
  // later plain read of another slot in the same guarded region.
  function shuffledGuardBody(): number[] {
    return [
      CALLER,
      ...push1(0),
      DUP1,
      SWAP1,
      SLOAD,
      EQ,
      ...branchOk(),
      ...push1(0),
      DUP1,
      REVERT,
      0x5b,
      ...push1(1),
      SLOAD,
      STOP,
    ];
  }

  test("a supply read after the guard never becomes the owner slot", () => {
    // The only constant load (slot 1) sits past the guard compare, so
    // it cannot feed it. The packed owner load never resolves in v1, so
    // no slot is proven and the detector stays silent instead of
    // reporting the supply slot.
    const bytecode = tokenBytecode([{ selector: "0x11111111", body: shuffledGuardBody() }]);
    expect(analyzeOwnerControl(bytecode).ownerSlot).toBe(null);
    const input: DetectorInput = Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
    expect(ownershipDetectorPlugin.detect(input)).toEqual([]);
  });

  test("evidence names only the loads feeding the caller compare", () => {
    // A guarded writer plus a plain owner read elsewhere: the slot is
    // proven by the guard, but the unguarded read is not an owner check
    // and must not appear as evidence.
    const bytecode = tokenBytecode([
      { selector: "0x22222222", body: [...ownerGuard(0, 200), STOP] },
      { selector: "0x33333333", body: [...push1(0), SLOAD, STOP] },
    ]);
    const input: DetectorInput = Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
    const findings = ownershipDetectorPlugin.detect(input);
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (finding === undefined) {
      throw new Error("expected exactly one finding");
    }
    expect(finding.payload).toEqual({ feature: "owner-slot", slot: 0, privilegedFunctions: 1 });
    expect(finding.evidence).toHaveLength(1);
    expect(finding.evidence[0]?.selector).toBe("0x22222222");
  });
});
