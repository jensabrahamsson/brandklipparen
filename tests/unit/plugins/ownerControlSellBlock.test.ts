// Tests for S-115 (K-009, K-010): the sell-block detector plugin
// `dev.brandklipparen.sell-block`. Written first (red) per A-21. The
// shared detector contract proves determinism, schema agreement, evidence
// presence and unchanged inputs; the tests below prove the behaviour: a
// transfer path that branches on the recipient against a stored
// pair address with a revert on one branch reports one finding, while an
// equality check with no stored address, or stored reads with no compare,
// stays silent.
import { describe, expect, test } from "vitest";
import { Bytecode, CodeHash } from "../../../src/domain/types.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import type { Result } from "../../../src/domain/result.ts";
import { sellBlockDetectorPlugin } from "../../../src/plugins/detectors/sell-block/index.ts";
import { runDetectorPluginContract } from "../../contract/detector.contract.ts";
import {
  CALLDATALOAD,
  EQ,
  ISZERO,
  JUMPI,
  KECCAK,
  REVERT,
  SLOAD,
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

const TRANSFER = "0xa9059cbb";
const SET_PAIR = "0x0a9c6c1e";

function pairGatedTransferBody(): number[] {
  // Transfer path compares the recipient against stored pair slot 9 and
  // reverts on the sell branch, beside a balance mapping read.
  return [
    CALLDATALOAD,
    ...push1(9),
    SLOAD,
    EQ,
    ISZERO,
    ...push1(90),
    JUMPI,
    ...push1(0),
    0x80,
    REVERT,
    0x5b,
    CALLDATALOAD,
    ...push1(2),
    KECCAK,
    SLOAD,
    ...sstoreConstSlot(2, [CALLDATALOAD]),
    STOP,
  ];
}

function makeInput(): DetectorInput {
  const bytecode = tokenBytecode([
    {
      selector: SET_PAIR,
      body: [...ownerGuard(0, 200), ...sstoreConstSlot(9, [CALLDATALOAD]), STOP],
    },
    { selector: TRANSFER, body: pairGatedTransferBody() },
  ]);
  return Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
}

runDetectorPluginContract("dev.brandklipparen.sell-block", sellBlockDetectorPlugin, makeInput);

describe("sell-block detector plugin", () => {
  test("pair-gated sell branch reports one finding", () => {
    const findings = sellBlockDetectorPlugin.detect(makeInput());
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (finding === undefined) {
      throw new Error("expected exactly one finding");
    }
    expect(finding.id).toBe("dev.brandklipparen.sell-block:sell-block");
    expect(finding.payload).toEqual({ feature: "sell-block", condition: "pair-mapping" });
    expect(finding.evidence.length).toBeGreaterThan(0);
    for (const entry of finding.evidence) {
      expect(entry.selector as string).toBe(TRANSFER);
      expect(typeof entry.offset).toBe("number");
    }
  });

  test("stored compare with no mapping read reports the stored kind", () => {
    // Same gate with no balance mapping traffic: a stored address compare
    // behind a privileged writer.
    const bytecode = tokenBytecode([
      {
        selector: SET_PAIR,
        body: [...ownerGuard(0, 200), ...sstoreConstSlot(9, [CALLDATALOAD]), STOP],
      },
      {
        selector: TRANSFER,
        body: [
          CALLDATALOAD,
          ...push1(9),
          SLOAD,
          EQ,
          ISZERO,
          ...push1(60),
          JUMPI,
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
    const findings = sellBlockDetectorPlugin.detect(input);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ feature: "sell-block", condition: "recipient-equals-stored" });
  });

  test("equality check with no stored address stays silent", () => {
    const bytecode = tokenBytecode([
      {
        selector: TRANSFER,
        body: [
          CALLDATALOAD,
          CALLDATALOAD,
          EQ,
          ISZERO,
          ...push1(40),
          JUMPI,
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
    expect(sellBlockDetectorPlugin.detect(input)).toEqual([]);
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
    expect(sellBlockDetectorPlugin.detect(input)).toEqual([]);
  });
});
