// C-18 constant folding and printer orientation (F-18). Synthetic
// dispatcher-plus-entry fixtures only; no network, no real addresses.
// Each body computes a constant and stores it, so the folded store value
// proves EVM operand order through `interpretRegionExprs`.
import { describe, expect, test } from "vitest";
import { Bytecode, Selector } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import {
  exprConstValue,
  interpretRegionExprs,
} from "../../../src/domain/ownerControl.ts";
import type { Expr } from "../../../src/domain/ownerControl.ts";
import { printRegionCondition } from "../../../src/domain/decompileV2.ts";
import { Asm } from "../../helpers/evmAsm.ts";

const MASK256 = (1n << 256n) - 1n;
const MASK160 = (1n << 160n) - 1n;

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

const FOLD_SELECTOR = mustOk(Selector.parse("0x12345678"));

// One straight-line entry: the body leaves its result on the stack, then
// `PUSH1 05 SSTORE STOP` stores it at slot 5. Returns the folded value.
function foldStoreValue(buildBody: (asm: Asm) => void): bigint | null {
  const asm = new Asm();
  asm.op(0x80).push4("12345678").op(0x14);
  asm.pushLabel2("entry").op(0x57);
  asm.label("fallback");
  asm.op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("entry").op(0x5b);
  buildBody(asm);
  asm.push1(0x05);
  const storePc = asm.pc;
  asm.op(0x55, 0x00);
  const code = mustOk(Bytecode.parse(asm.build()));
  const exprs = interpretRegionExprs(code, FOLD_SELECTOR);
  const record = exprs.stores.get(storePc);
  if (record === undefined) {
    throw new Error("expected a store");
  }
  return exprConstValue(record.value);
}

describe("c18 evm-order constant folding", () => {
  test("sub folds top minus second", () => {
    // PUSH1 1 PUSH1 0 SUB: top 0 minus second 1.
    expect(foldStoreValue((asm) => asm.push1(0x01).push1(0x00).op(0x03))).toBe(MASK256);
  });

  test("exp folds top base to second exponent", () => {
    // PUSH1 18 PUSH1 10 EXP: base 10 (top) to the 18 (second).
    expect(foldStoreValue((asm) => asm.push1(18).push1(10).op(0x0a))).toBe(10n ** 18n);
  });

  test("div folds top dividend over second divisor", () => {
    // PUSH1 2 PUSH1 10 DIV: 10 (top) over 2 (second).
    expect(foldStoreValue((asm) => asm.push1(0x02).push1(10).op(0x04))).toBe(5n);
  });

  test("lt compares top against second", () => {
    // PUSH1 3 PUSH1 2 LT: top 2 below second 3.
    expect(foldStoreValue((asm) => asm.push1(0x03).push1(0x02).op(0x10))).toBe(1n);
  });

  test("gt compares top against second", () => {
    // PUSH1 3 PUSH1 2 GT: top 2 is not above second 3.
    expect(foldStoreValue((asm) => asm.push1(0x03).push1(0x02).op(0x11))).toBe(0n);
  });

  test("exp folds old-solc 256 to the 20", () => {
    // PUSH1 0x14 PUSH2 0x0100 EXP: 256**20 with no either-order leniency.
    expect(foldStoreValue((asm) => asm.push1(0x14).push2(0x0100).op(0x0a))).toBe(256n ** 20n);
  });

  test("address mask folds through shl then sub", () => {
    // (1 << 160) - 1 in EVM order is the 160-bit mask.
    expect(
      foldStoreValue((asm) => asm.push1(0x01).push1(0x01).push1(0xa0).op(0x1b).op(0x03)),
    ).toBe(MASK160);
  });

  test("reversed mask construction is not the mask", () => {
    // (160 << 1) - 1: the leniency must not fire in reverse.
    const value = foldStoreValue((asm) => asm.push1(0xa0).push1(0x01).op(0x1b).push1(0x01).op(0x03));
    expect(value).not.toBe(MASK160);
    expect(value).toBe((1n - 320n) & MASK256);
  });
});

describe("c18 printer orientation", () => {
  test("c18_printer_orients_lt", () => {
    // Region exprs store [second, top]; printing must read top < second.
    const cond: Expr = Object.freeze({
      kind: "op",
      name: "LT",
      args: Object.freeze([
        Object.freeze({ kind: "const", value: 5n }),
        Object.freeze({
          kind: "calldata",
          offset: Object.freeze({ kind: "const", value: 4n }),
        }),
      ]),
    }) as Expr;
    expect(printRegionCondition(cond)).toBe("arg0 < 0x05");
  });
});
