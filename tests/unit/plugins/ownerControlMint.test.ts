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
  KECCAK,
  SLOAD,
  SSTORE,
  STOP,
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
