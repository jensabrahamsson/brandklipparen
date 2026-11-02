// General blacklist semantics beyond the first devset idioms: a
// per-address flag counts only when its set value reaches a revert or
// a silent halt in the transfer path for that address. A per-address
// number that only prices a later amount check never counts.
// Synthetic bytecode only; every fixture selector uses the synthetic
// 0x5ab1e prefix or a standard transfer selector.
import { describe, expect, test } from "vitest";
import { CodeHash } from "../../../src/domain/types.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import { blacklistDetectorPlugin } from "../../../src/plugins/detectors/blacklist/index.ts";
import type { Result } from "../../../src/domain/result.ts";
import {
  CALLDATALOAD,
  ISZERO,
  KECCAK,
  MSTORE,
  REVERT,
  SLOAD,
  SSTORE,
  STOP,
  branchOk,
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

const SET_STATUS = "0x5ab1e001";
const TRANSFER = "0xa9059cbb";
const TRANSFER_FROM = "0x23b872dd";
const RETURN = 0xf3;

function setterBody(base = 3): number[] {
  return [
    ...ownerGuard(0, 200),
    CALLDATALOAD,
    CALLDATALOAD,
    ...push1(0),
    MSTORE,
    ...push1(base),
    ...push1(0x20),
    MSTORE,
    ...push1(0x40),
    ...push1(0x00),
    KECCAK,
    SSTORE,
    STOP,
  ];
}

function mappingLoad(base = 3): number[] {
  return [
    CALLDATALOAD,
    ...push1(0),
    MSTORE,
    ...push1(base),
    ...push1(0x20),
    MSTORE,
    ...push1(0x40),
    ...push1(0x00),
    KECCAK,
    SLOAD,
  ];
}

function inputFor(parts: readonly { selector: string; body: readonly number[] }[]): DetectorInput {
  const bytecode = tokenBytecode(parts);
  return Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
}

const revertRun: readonly number[] = [...push1(0), 0x80, REVERT];

describe("blacklist general transfer-path semantics", () => {
  test("enum status entry equal to a nonzero code gates a revert", () => {
    // status[addr] == 1 (blocked code) jumps to the revert block; any
    // other value falls through to the transfer store.
    const input = inputFor([
      { selector: SET_STATUS, body: setterBody() },
      {
        selector: TRANSFER,
        body: [...mappingLoad(), ...push1(1), 0x14, ...branchOk(), ...push1(2), SSTORE, STOP, 0x5b, ...revertRun],
      },
    ]);
    expect(blacklistDetectorPlugin.detect(input)).toHaveLength(1);
  });

  test("silent return on a listed entry reports a finding", () => {
    // Listed side falls through to RETURN with no store and no revert;
    // the clear side jumps past it and stores.
    const input = inputFor([
      { selector: SET_STATUS, body: setterBody() },
      {
        selector: TRANSFER,
        body: [...mappingLoad(), ISZERO, ...branchOk(), ...push1(0), ...push1(0), RETURN, 0x5b, ...push1(2), SSTORE, STOP],
      },
    ]);
    expect(blacklistDetectorPlugin.detect(input)).toHaveLength(1);
  });

  test("gate that sits only in transferFrom reports a finding", () => {
    const input = inputFor([
      { selector: SET_STATUS, body: setterBody() },
      { selector: TRANSFER, body: [...push1(2), SSTORE, STOP] },
      {
        selector: TRANSFER_FROM,
        body: [...mappingLoad(), ISZERO, ...branchOk(), ...revertRun, 0x5b, ...push1(2), SSTORE, STOP],
      },
    ]);
    expect(blacklistDetectorPlugin.detect(input)).toHaveLength(1);
  });

  test("two-entry gate checks both parties and reports a finding", () => {
    // blocked[from] reverts at the first check; a clear sender still
    // reaches the blocked[to] check before the store.
    const input = inputFor([
      { selector: SET_STATUS, body: setterBody() },
      {
        selector: TRANSFER,
        body: [
          ...mappingLoad(),
          ISZERO,
          ...branchOk(),
          ...revertRun,
          0x5b,
          ...mappingLoad(),
          ISZERO,
          ...branchOk(),
          ...revertRun,
          0x5b,
          ...push1(2),
          SSTORE,
          STOP,
        ],
      },
    ]);
    expect(blacklistDetectorPlugin.detect(input)).toHaveLength(1);
  });

  test("per-address limit that only arms a later amount check stays silent", () => {
    // limit[addr] == 0 jumps straight to the store (unlimited). A
    // nonzero limit only reaches an amount compare; the entry value
    // itself never halts or reverts the transfer.
    const input = inputFor([
      { selector: SET_STATUS, body: setterBody() },
      {
        selector: TRANSFER,
        body: [
          ...mappingLoad(),
          ISZERO,
          ...branchOk(),
          CALLDATALOAD,
          ...push1(9),
          0x11,
          ...branchOk(),
          ...revertRun,
          0x5b,
          ...push1(2),
          SSTORE,
          STOP,
        ],
      },
    ]);
    expect(blacklistDetectorPlugin.detect(input)).toEqual([]);
  });
});
