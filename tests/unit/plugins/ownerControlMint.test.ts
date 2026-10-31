// Tests for S-115 (K-009, K-010): the mint detector plugin
// `dev.brandklipparen.mint`. Written first (red) per A-21: the plugin
// module does not exist yet, so the import fails until the implementation
// lands. The shared detector contract proves determinism, schema
// agreement, evidence presence and unchanged inputs; the tests below prove
// the behaviour: a privileged SSTORE that grows a supply-like slot read
// in the transfer path reports one finding, while an unguarded write or
// a write to a slot the transfer path never reads stays silent.
import { describe, expect, test } from "vitest";
import { Bytecode, CodeHash } from "../../../src/domain/types.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import type { Result } from "../../../src/domain/result.ts";
import { mintDetectorPlugin } from "../../../src/plugins/detectors/mint/index.ts";
import { runDetectorPluginContract } from "../../contract/detector.contract.ts";
import {
  ADD,
  CALLDATALOAD,
  CALLER,
  EQ,
  KECCAK,
  MSTORE,
  REVERT,
  SLOAD,
  SSTORE,
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

const MINT = "0x40c10f19";
const TRANSFER = "0xa9059cbb";

function mintBody(): number[] {
  // onlyOwner guard over slot 0, then supply slot 1 grows by the amount
  // with a balance credit to a caller-chosen address.
  return [
    ...ownerGuard(0, 200),
    CALLDATALOAD,
    ...push1(1),
    SLOAD,
    ADD,
    ...sstoreConstSlot(1, []),
    CALLDATALOAD,
    ...push1(2),
    KECCAK,
    SSTORE,
    STOP,
  ];
}

function transferBody(): number[] {
  // Transfer path reads supply slot 1 and updates a balance slot.
  return [
    CALLDATALOAD,
    ...push1(1),
    SLOAD,
    ADD,
    ...sstoreConstSlot(2, [CALLDATALOAD]),
    STOP,
  ];
}

function makeInput(): DetectorInput {
  const bytecode = tokenBytecode([
    { selector: MINT, body: mintBody() },
    { selector: TRANSFER, body: transferBody() },
  ]);
  return Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
}

runDetectorPluginContract("dev.brandklipparen.mint", mintDetectorPlugin, makeInput);

describe("mint detector plugin", () => {
  test("privileged supply increase reports one finding with slot and pcs", () => {
    const findings = mintDetectorPlugin.detect(makeInput());
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (finding === undefined) {
      throw new Error("expected exactly one finding");
    }
    expect(finding.id).toBe("dev.brandklipparen.mint:mint");
    expect(finding.payload).toEqual({ feature: "mint", slot: 1 });
    const selectors = finding.evidence.map((entry) => entry.selector as string).sort();
    expect(selectors).toEqual([MINT, TRANSFER].sort());
    for (const entry of finding.evidence) {
      expect(typeof entry.offset).toBe("number");
    }
  });

  test("unguarded write to the supply slot stays silent", () => {
    // Same SSTORE shape with no caller guard anywhere: no privileged
    // caller, so no positive finding.
    const bytecode = tokenBytecode([
      {
        selector: MINT,
        body: [CALLDATALOAD, ...push1(1), SLOAD, ADD, ...sstoreConstSlot(1, []), STOP],
      },
      { selector: TRANSFER, body: transferBody() },
    ]);
    const input: DetectorInput = Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
    expect(mintDetectorPlugin.detect(input)).toEqual([]);
  });

  test("privileged write to a slot the transfer path never reads stays silent", () => {
    const bytecode = tokenBytecode([
      {
        selector: MINT,
        body: [...ownerGuard(0, 200), CALLDATALOAD, ...sstoreConstSlot(9, []), STOP],
      },
      { selector: TRANSFER, body: transferBody() },
    ]);
    const input: DetectorInput = Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
    expect(mintDetectorPlugin.detect(input)).toEqual([]);
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
    expect(mintDetectorPlugin.detect(input)).toEqual([]);
  });
});

const ISSUE = "0x55a85fc0";
const WARDS_MINT = "0x40c10f19";
const BURN = "0x42966c68";
const TOTAL_SUPPLY = "0x18160ddd";

// Stack-neutral filler wider than the scored beside window: the scored
// window proof stays blind while the extended expression proof still sees
// the addition over the loaded supply.
const DUP1 = 0x80;
const POP = 0x50;

// Honest-stack bodies throughout: every CALLDATALOAD consumes a pushed
// offset, so the symbolic interpreter tracks real values instead of
// underflowing. The filler between the supply load and the addition is
// wider than the scored beside window: the scored window proof stays
// blind while the extended expression proof still sees the addition
// over the loaded supply.
function fillers(): number[] {
  return Array.from({ length: 9 }, () => [DUP1, POP]).flat();
}

function farAdd(slot: number): number[] {
  return [...push1(slot), SLOAD, ...fillers(), ...push1(0x04), CALLDATALOAD, ADD];
}

function totalSupplyBody(slot: number): number[] {
  return [...push1(slot), SLOAD, STOP];
}

function plainTransferBody(): number[] {
  return [...push1(0x04), CALLDATALOAD, ...push1(2), KECCAK, SSTORE, STOP];
}

// Balance credit through the explicit keccak(key . baseSlot) memory
// pattern, with the key source choosing the recipient: a stored owner
// address or a caller-chosen argument.
function creditBody(keyPrefix: readonly number[], base: number): number[] {
  return [
    ...keyPrefix,
    ...push1(0x00),
    MSTORE,
    ...push1(base),
    ...push1(0x20),
    MSTORE,
    ...push1(0x24),
    CALLDATALOAD,
    ...push1(0x40),
    ...push1(0x00),
    KECCAK,
    SSTORE,
  ];
}

function extendedInput(
  parts: readonly { selector: string; body: readonly number[] }[],
): DetectorInput {
  const bytecode = tokenBytecode(parts);
  return Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
}

describe("mint extended fact (P-12)", () => {
  test("(a) issue crediting the stored owner balance reports recipient stored", () => {
    const input = extendedInput([
      {
        selector: ISSUE,
        body: [
          ...ownerGuard(0, 200),
          ...farAdd(1),
          ...fillers(),
          ...sstoreConstSlot(1, []),
          ...creditBody([...push1(0), SLOAD], 2),
          STOP,
        ],
      },
      { selector: TRANSFER, body: plainTransferBody() },
      { selector: TOTAL_SUPPLY, body: totalSupplyBody(1) },
    ]);
    const findings = mintDetectorPlugin.detect(input);
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (finding === undefined) {
      throw new Error("expected exactly one finding");
    }
    expect(finding.id).toBe("dev.brandklipparen.mint:mint-extended");
    expect(finding.payload).toEqual({
      fact: "mint",
      slot: 1,
      auth: "owner",
      recipient: "stored",
      capped: false,
      proof: "extended",
    });
  });

  test("(b) mint under a wards-mapping guard reports role-mapping with an argument recipient", () => {
    const input = extendedInput([
      {
        selector: WARDS_MINT,
        body: [
          CALLER,
          ...push1(7),
          KECCAK,
          SLOAD,
          ...push1(1),
          EQ,
          ...branchOk(),
          ...push1(0),
          0x80,
          REVERT,
          0x5b,
          ...farAdd(4),
          ...fillers(),
          ...sstoreConstSlot(4, []),
          ...creditBody([...push1(0x04), CALLDATALOAD], 2),
          STOP,
        ],
      },
      { selector: TRANSFER, body: plainTransferBody() },
      { selector: TOTAL_SUPPLY, body: totalSupplyBody(4) },
    ]);
    const findings = mintDetectorPlugin.detect(input);
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (finding === undefined) {
      throw new Error("expected exactly one finding");
    }
    expect(finding.id).toBe("dev.brandklipparen.mint:mint-extended");
    expect(finding.payload).toEqual({
      fact: "mint",
      slot: 4,
      auth: "role-mapping",
      recipient: "argument",
      capped: false,
      proof: "extended",
    });
  });

  test("(c) a holder burn with a supply decrease stays silent", () => {
    const input = extendedInput([
      {
        selector: BURN,
        body: [
          ...ownerGuard(0, 200),
          ...push1(0x04),
          CALLDATALOAD,
          ...push1(1),
          SLOAD,
          SUB,
          ...sstoreConstSlot(1, []),
          ...creditBody([...push1(0x04), CALLDATALOAD], 2),
          STOP,
        ],
      },
      { selector: TRANSFER, body: plainTransferBody() },
      { selector: TOTAL_SUPPLY, body: totalSupplyBody(1) },
    ]);
    expect(mintDetectorPlugin.detect(input)).toEqual([]);
  });

  test("(d) a constructor-only supply write unreachable at runtime stays silent", () => {
    const input = extendedInput([
      {
        selector: TRANSFER,
        body: [
          ...plainTransferBody().slice(0, -1),
          STOP,
          CALLDATALOAD,
          ...push1(1),
          SLOAD,
          ADD,
          ...sstoreConstSlot(1, []),
        ],
      },
      {
        selector: ISSUE,
        body: [...ownerGuard(0, 200), ...sstoreConstSlot(9, [CALLDATALOAD]), STOP],
      },
      { selector: TOTAL_SUPPLY, body: totalSupplyBody(1) },
    ]);
    expect(mintDetectorPlugin.detect(input)).toEqual([]);
  });
});
