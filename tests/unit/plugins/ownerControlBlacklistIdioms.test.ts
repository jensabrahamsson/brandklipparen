// Per-idiom tests for SCORE-2 blacklist semantics: a per-address flag a
// privileged caller can set counts only when its value reaches a revert
// or a silent no-op in the transfer path for that address. Exempt-style
// mappings that only skip a fee or a limit never count. Synthetic
// bytecode fixtures only.
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

describe("blacklist transfer-path idioms (SCORE-2)", () => {
  test("silent no-op transfer (early halt, no revert) on a listed entry reports a finding", () => {
    // Listed side falls through to STOP with no store; the clear side
    // jumps past it and stores. No REVERT sits in the transfer at all.
    const input = inputFor([
      { selector: SET_STATUS, body: setterBody() },
      {
        selector: TRANSFER,
        body: [...mappingLoad(), ISZERO, ...branchOk(), STOP, 0x5b, ...push1(2), SSTORE, STOP],
      },
    ]);
    const findings = blacklistDetectorPlugin.detect(input);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual(
      expect.objectContaining({ fact: "blacklist", proof: "extended" }),
    );
  });

  test("jump-side silent halt on a listed entry reports a finding", () => {
    // No ISZERO: the raw entry jumps straight to the halt block while
    // set; the clear side falls through and stores.
    const input = inputFor([
      { selector: SET_STATUS, body: setterBody() },
      {
        selector: TRANSFER,
        body: [...mappingLoad(), ...branchOk(), ...push1(2), SSTORE, STOP, 0x5b, STOP],
      },
    ]);
    const findings = blacklistDetectorPlugin.detect(input);
    expect(findings).toHaveLength(1);
  });

  test("allowlist entry that reverts while clear stays silent", () => {
    // require(allowed[from]): a set entry jumps to the store side and
    // the clear side falls through to the revert — the opposite
    // polarity of a list, so no finding stands.
    const input = inputFor([
      { selector: SET_STATUS, body: setterBody() },
      {
        selector: TRANSFER,
        body: [...mappingLoad(), ...branchOk(), ...push1(0), 0x80, REVERT, 0x5b, ...push1(2), SSTORE, STOP],
      },
    ]);
    expect(blacklistDetectorPlugin.detect(input)).toEqual([]);
  });

  test("entry negated with XOR 1 instead of ISZERO still gates a revert", () => {
    // require(blocked[x] ^ 1): the compiler flips the entry with a
    // constant XOR rather than ISZERO; the set side still reverts.
    const input = inputFor([
      { selector: SET_STATUS, body: setterBody() },
      {
        selector: TRANSFER,
        body: [
          ...mappingLoad(),
          ...push1(1),
          0x18,
          ...branchOk(),
          ...push1(0),
          0x80,
          REVERT,
          0x5b,
          ...push1(2),
          SSTORE,
          STOP,
        ],
      },
    ]);
    const findings = blacklistDetectorPlugin.detect(input);
    expect(findings).toHaveLength(1);
  });

  test("entry compared against zero with EQ still gates a revert", () => {
    // require(blocked[x] == 0): the equality against the constant 0 is
    // the negation, so the set side falls through to the revert.
    const input = inputFor([
      { selector: SET_STATUS, body: setterBody() },
      {
        selector: TRANSFER,
        body: [
          ...mappingLoad(),
          ...push1(0),
          0x14,
          ...branchOk(),
          ...push1(0),
          0x80,
          REVERT,
          0x5b,
          ...push1(2),
          SSTORE,
          STOP,
        ],
      },
    ]);
    expect(blacklistDetectorPlugin.detect(input)).toHaveLength(1);
  });

  test("pair entry combined with a priced amount compare stays silent", () => {
    // automatedMarketMakerPairs shape: the transfer reverts only when
    // the pair entry is set AND the amount passes a priced compare.
    // The entry alone never blocks a holder, so no list is proven.
    const input = inputFor([
      { selector: SET_STATUS, body: setterBody() },
      {
        selector: TRANSFER,
        body: [
          ...mappingLoad(),
          CALLDATALOAD,
          ...push1(9),
          0x11,
          0x16,
          ISZERO,
          ...branchOk(),
          ...push1(0),
          0x80,
          REVERT,
          0x5b,
          ...push1(2),
          SSTORE,
          STOP,
        ],
      },
    ]);
    expect(blacklistDetectorPlugin.detect(input)).toEqual([]);
  });

  test("fee-exempt entry that only skips a priced limit check stays silent", () => {
    // A set entry is exempt: it falls through to the store. The clear
    // side jumps to a priced limit compare that can revert. The entry
    // itself never blocks the transfer.
    const input = inputFor([
      { selector: SET_STATUS, body: setterBody() },
      {
        selector: TRANSFER,
        body: [
          ...mappingLoad(),
          ISZERO,
          ...branchOk(),
          ...push1(2),
          SSTORE,
          STOP,
          0x5b,
          CALLDATALOAD,
          ...push1(9),
          0x10,
          ISZERO,
          ...branchOk(),
          ...push1(0),
          0x80,
          REVERT,
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
