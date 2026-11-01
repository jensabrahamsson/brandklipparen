// C-17 conformance: one Cancun stack-effect table shared by every engine
// (F-15 TIMESTAMP, F-16 decompiler arity, F-33 leftovers). The expected
// table below is written literally from the Cancun spec, independent of
// `src/domain/opcodes.ts`; the behavior tests pin the user-visible fixes.
import { describe, expect, test } from "vitest";
import { stackEffectOf } from "../../../src/domain/opcodes.ts";
import { Selector } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import {
  exprConstValue,
  interpretRegionExprs,
} from "../../../src/domain/ownerControl.ts";
import { decompileContractV2 } from "../../../src/domain/decompileV2.ts";
import { decompileContract } from "../../../src/domain/evmSsa.ts";
import {
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

describe("c17 cancun stack-effect conformance", () => {
  test("c17_every_defined_opcode_matches_cancun", () => {
    // [opcode, pops, pushes, halts], literal per the Cancun spec.
    const expected: ReadonlyArray<readonly [number, number, number, boolean]> = [
      [0x00, 0, 0, true],
      [0x01, 2, 1, false], [0x02, 2, 1, false], [0x03, 2, 1, false],
      [0x04, 2, 1, false], [0x05, 2, 1, false], [0x06, 2, 1, false],
      [0x07, 2, 1, false],
      [0x08, 3, 1, false], [0x09, 3, 1, false],
      [0x0a, 2, 1, false], [0x0b, 2, 1, false],
      [0x10, 2, 1, false], [0x11, 2, 1, false], [0x12, 2, 1, false],
      [0x13, 2, 1, false], [0x14, 2, 1, false],
      [0x15, 1, 1, false],
      [0x16, 2, 1, false], [0x17, 2, 1, false], [0x18, 2, 1, false],
      [0x19, 1, 1, false],
      [0x1a, 2, 1, false], [0x1b, 2, 1, false], [0x1c, 2, 1, false],
      [0x1d, 2, 1, false],
      [0x20, 2, 1, false],
      [0x30, 0, 1, false],
      [0x31, 1, 1, false],
      [0x32, 0, 1, false], [0x33, 0, 1, false], [0x34, 0, 1, false],
      [0x35, 1, 1, false],
      [0x36, 0, 1, false],
      [0x37, 3, 0, false],
      [0x38, 0, 1, false],
      [0x39, 3, 0, false],
      [0x3a, 0, 1, false],
      [0x3b, 1, 1, false],
      [0x3c, 4, 0, false],
      [0x3d, 0, 1, false],
      [0x3e, 3, 0, false],
      [0x3f, 1, 1, false],
      [0x40, 1, 1, false],
      [0x41, 0, 1, false], [0x42, 0, 1, false], [0x43, 0, 1, false],
      [0x44, 0, 1, false], [0x45, 0, 1, false], [0x46, 0, 1, false],
      [0x47, 0, 1, false], [0x48, 0, 1, false],
      [0x49, 1, 1, false],
      [0x4a, 0, 1, false],
      [0x50, 1, 0, false],
      [0x51, 1, 1, false],
      [0x52, 2, 0, false], [0x53, 2, 0, false],
      [0x54, 1, 1, false],
      [0x55, 2, 0, false],
      [0x56, 1, 0, false],
      [0x57, 2, 0, false],
      [0x58, 0, 1, false], [0x59, 0, 1, false], [0x5a, 0, 1, false],
      [0x5b, 0, 0, false],
      [0x5c, 1, 1, false],
      [0x5d, 2, 0, false],
      [0x5e, 3, 0, false],
      [0x5f, 0, 1, false],
      [0x60, 0, 1, false], [0x61, 0, 1, false], [0x62, 0, 1, false],
      [0x63, 0, 1, false], [0x64, 0, 1, false], [0x65, 0, 1, false],
      [0x66, 0, 1, false], [0x67, 0, 1, false], [0x68, 0, 1, false],
      [0x69, 0, 1, false], [0x6a, 0, 1, false], [0x6b, 0, 1, false],
      [0x6c, 0, 1, false], [0x6d, 0, 1, false], [0x6e, 0, 1, false],
      [0x6f, 0, 1, false], [0x70, 0, 1, false], [0x71, 0, 1, false],
      [0x72, 0, 1, false], [0x73, 0, 1, false], [0x74, 0, 1, false],
      [0x75, 0, 1, false], [0x76, 0, 1, false], [0x77, 0, 1, false],
      [0x78, 0, 1, false], [0x79, 0, 1, false], [0x7a, 0, 1, false],
      [0x7b, 0, 1, false], [0x7c, 0, 1, false], [0x7d, 0, 1, false],
      [0x7e, 0, 1, false], [0x7f, 0, 1, false],
      [0x80, 1, 2, false], [0x81, 2, 3, false], [0x82, 3, 4, false],
      [0x83, 4, 5, false], [0x84, 5, 6, false], [0x85, 6, 7, false],
      [0x86, 7, 8, false], [0x87, 8, 9, false], [0x88, 9, 10, false],
      [0x89, 10, 11, false], [0x8a, 11, 12, false], [0x8b, 12, 13, false],
      [0x8c, 13, 14, false], [0x8d, 14, 15, false], [0x8e, 15, 16, false],
      [0x8f, 16, 17, false],
      [0x90, 2, 2, false], [0x91, 3, 3, false], [0x92, 4, 4, false],
      [0x93, 5, 5, false], [0x94, 6, 6, false], [0x95, 7, 7, false],
      [0x96, 8, 8, false], [0x97, 9, 9, false], [0x98, 10, 10, false],
      [0x99, 11, 11, false], [0x9a, 12, 12, false], [0x9b, 13, 13, false],
      [0x9c, 14, 14, false], [0x9d, 15, 15, false], [0x9e, 16, 16, false],
      [0x9f, 17, 17, false],
      [0xa0, 2, 0, false], [0xa1, 3, 0, false], [0xa2, 4, 0, false],
      [0xa3, 5, 0, false], [0xa4, 6, 0, false],
      [0xf0, 3, 1, false],
      [0xf1, 7, 1, false], [0xf2, 7, 1, false],
      [0xf3, 2, 0, true],
      [0xf4, 6, 1, false],
      [0xf5, 4, 1, false],
      [0xfa, 6, 1, false],
      [0xfd, 2, 0, true],
      [0xfe, 0, 0, true],
      [0xff, 1, 0, true],
    ];
    const seen = new Set<number>();
    for (const [opcode, pops, pushes, halts] of expected) {
      seen.add(opcode);
      expect(stackEffectOf(opcode)).toEqual({ pops, pushes, halts });
    }
    // Every byte is either defined above or undefined (null).
    for (let opcode = 0x00; opcode <= 0xff; opcode += 1) {
      if (!seen.has(opcode)) {
        expect(stackEffectOf(opcode)).toBe(null);
      }
    }
    expect(seen.size).toBe(149);
  });

  test("c17_undefined_opcodes_are_null", () => {
    const undefinedOpcodes: number[] = [
      0x0c, 0x0d, 0x0e, 0x0f,
      0x1e, 0x1f,
      0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b,
      0x2c, 0x2d, 0x2e, 0x2f,
      0x4b, 0x4c, 0x4d, 0x4e, 0x4f,
    ];
    for (let opcode = 0xa5; opcode <= 0xef; opcode += 1) {
      undefinedOpcodes.push(opcode);
    }
    for (const opcode of [0xf6, 0xf7, 0xf8, 0xf9, 0xfb, 0xfc]) {
      undefinedOpcodes.push(opcode);
    }
    expect(undefinedOpcodes.length).toBe(107);
    for (const opcode of undefinedOpcodes) {
      expect(stackEffectOf(opcode)).toBe(null);
    }
  });

  test("c17_timestamp_dup2_sstore_resolves_slot", () => {
    const selector = mustOk(Selector.parse("0x12345678"));
    const body = [
      ...ownerGuard(0, 200),
      ...push1(7),
      0x42, // TIMESTAMP pushes without popping
      0x81, // DUP2 copies the pushed slot constant
      0x55, // SSTORE
      0x00, // STOP
    ];
    const code = tokenBytecode([{ selector: "0x12345678", body }]);
    const exprs = interpretRegionExprs(code, selector);
    const slots = [...exprs.stores.values()].map((store) => exprConstValue(store.slot));
    expect(slots).toContain(7n);
  });

  test("c17_decompiler_prints_tx_origin_guard", () => {
    const body = [
      0x32, // ORIGIN
      ...push1(0),
      0x54, // SLOAD
      0x14, // EQ
      ...branchOk(),
      ...push1(0),
      0x80, // DUP1
      0xfd, // REVERT
      0x5b, // ok
      0x00, // STOP
    ];
    const code = tokenBytecode([{ selector: "0x12345678", body }]);
    const out = decompileContractV2(code);
    expect(out.text).toContain("tx.origin");
  });

  test("c17_selfbalance_prints", () => {
    const body = [0x47, ...push1(0), 0x55, 0x00];
    const code = tokenBytecode([{ selector: "0x12345678", body }]);
    const out = decompileContractV2(code);
    expect(out.text).toContain("address(this).balance");
  });

  test("c17_ssa_call_pops_inputs", () => {
    const body = [
      ...push1(1), ...push1(1), ...push1(1), ...push1(1),
      ...push1(1), ...push1(1), ...push1(1),
      0xf1, // CALL pops 7, pushes its result
      ...push1(0),
      0x55, // SSTORE stores the CALL result at slot 0
      0x00, // STOP
    ];
    const code = tokenBytecode([{ selector: "0x12345678", body }]);
    const out = decompileContract(code);
    const match = /v\d+ = op_f1\(\);/.exec(out.text);
    expect(match).not.toBe(null);
    const target = (match?.[0] ?? "").split(" ")[0] ?? "";
    expect(target.startsWith("v")).toBe(true);
    expect(out.text).toContain(`storage[0x00] = ${target};`);
  });
});
