// Tests for the shared Solidity CBOR metadata footer helper (K-009, K-017).
// Written first (red) per A-21; the implementation lives in
// src/domain/metadata.ts. All byte sequences below are small hand-assembled
// synthetic values built in this file: no real contract bytecode, no
// thresholds, weights or external data.
import { describe, expect, test } from "vitest";
import { stripCborFooter } from "../../../src/domain/metadata.ts";
import { extractSelectors } from "../../../src/domain/selectors.ts";
import { Bytecode, CodeHash, SkeletonHash } from "../../../src/domain/types.ts";
import type { Bytecode as BytecodeType } from "../../../src/domain/types.ts";
import type { CodeHash as CodeHashType } from "../../../src/domain/types.ts";
import type { SkeletonHash as SkeletonHashType } from "../../../src/domain/types.ts";

function mustCode(hex: string): BytecodeType {
  const parsed = Bytecode.parse(hex);
  if (!parsed.ok) {
    throw new Error(`expected valid bytecode, got error: ${parsed.error.message}`);
  }
  return parsed.value;
}

function codeFromBytes(bytes: readonly number[]): BytecodeType {
  const body = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return mustCode(`0x${body}`);
}

function mustCodeHash(code: BytecodeType): CodeHashType {
  const parsed = CodeHash.of(code);
  if (!parsed.ok) {
    throw new Error(`expected code hash, got error: ${parsed.error.message}`);
  }
  return parsed.value;
}

function mustSkeletonHash(code: BytecodeType): SkeletonHashType {
  const parsed = SkeletonHash.of(code);
  if (!parsed.ok) {
    throw new Error(`expected skeleton hash, got error: ${parsed.error.message}`);
  }
  return parsed.value;
}

// Executable prefix shared by the footer tests: DUP1 PUSH4 0xa9059cbb EQ
// PUSH1 0x0a JUMPI JUMPDEST STOP.
const DISPATCHER: readonly number[] = [
  0x80, 0x63, 0xa9, 0x05, 0x9c, 0xbb, 0x14, 0x60, 0x0a, 0x57, 0x5b, 0x00,
];

// Standard Solidity CBOR metadata footer (53 bytes), mirroring the layout
// the old fixed-size rule recognised. The 34 content bytes carry a fake
// dispatcher window so the tests prove the footer region stays excluded.
function standardFooter(): number[] {
  const content: number[] = [
    0x80, 0x63, 0xde, 0xad, 0xbe, 0xef, 0x14, 0x60, 0x01, 0x57,
    ...new Array<number>(24).fill(0x00),
  ];
  return [
    0xa2, 0x64, 0x69, 0x70, 0x66, 0x73, 0x58, 0x22,
    ...content,
    0x64, 0x73, 0x6f, 0x6c, 0x63, 0x43, 0x00, 0x08, 0x09, 0x00, 0x33,
  ];
}

describe("k017 shared CBOR metadata footer", () => {
  test("k017_strips_standard_53_byte_footer", () => {
    const full = codeFromBytes([...DISPATCHER, ...standardFooter()]);
    const prefix = codeFromBytes([...DISPATCHER]);
    expect(Array.from(stripCborFooter(full))).toEqual([...DISPATCHER]);
    // All three users agree with the footer-free prefix.
    expect(mustCodeHash(full)).toBe(mustCodeHash(prefix));
    expect(mustSkeletonHash(full)).toBe(mustSkeletonHash(prefix));
    expect(extractSelectors(full)).toEqual(extractSelectors(prefix));
  });

  test("k017_strips_shorter_variable_length_footer", () => {
    // Six-byte blob starting with a CBOR map header plus its length suffix.
    const blob = [0xa1, 0x01, 0x02, 0x03, 0x04, 0x05];
    const full = codeFromBytes([...DISPATCHER, ...blob, 0x00, 0x06]);
    const prefix = codeFromBytes([...DISPATCHER]);
    expect(Array.from(stripCborFooter(full))).toEqual([...DISPATCHER]);
    expect(mustCodeHash(full)).toBe(mustCodeHash(prefix));
    expect(mustSkeletonHash(full)).toBe(mustSkeletonHash(prefix));
  });

  test("k017_strips_longer_variable_length_footer", () => {
    // Seventy-byte blob: the layout varies by compiler version and settings.
    const blob = [0xa3, ...new Array<number>(69).fill(0x00)];
    const full = codeFromBytes([...DISPATCHER, ...blob, 0x00, 0x46]);
    const prefix = codeFromBytes([...DISPATCHER]);
    expect(Array.from(stripCborFooter(full))).toEqual([...DISPATCHER]);
    expect(mustCodeHash(full)).toBe(mustCodeHash(prefix));
    expect(mustSkeletonHash(full)).toBe(mustSkeletonHash(prefix));
  });

  test("k017_strips_indefinite_length_map_blob", () => {
    const blob = [0xbf, 0x01, 0x02, 0xff];
    const full = codeFromBytes([...DISPATCHER, ...blob, 0x00, 0x04]);
    expect(Array.from(stripCborFooter(full))).toEqual([...DISPATCHER]);
  });

  test("k017_length_suffix_larger_than_code_leaves_code_unchanged", () => {
    // Suffix 0x0010 claims 16 blob bytes in 4 bytes of code.
    const bytes = [0x60, 0x01, 0x00, 0x10];
    expect(Array.from(stripCborFooter(codeFromBytes(bytes)))).toEqual(bytes);
    // A two-byte code whose suffix alone exceeds the code stays unchanged.
    const tiny = [0x60, 0x01];
    expect(Array.from(stripCborFooter(codeFromBytes(tiny)))).toEqual(tiny);
  });

  test("k017_blob_without_map_header_leaves_code_unchanged", () => {
    // Suffix 0x0003 is consistent in length, but the blob starts with 0x01,
    // which is not a CBOR map header, so the code stays unchanged.
    const bytes = [0x60, 0x01, 0x02, 0x03, 0x00, 0x03];
    expect(Array.from(stripCborFooter(codeFromBytes(bytes)))).toEqual(bytes);
    // A zero length suffix claims no blob at all.
    const zero = [0x60, 0x01, 0x00, 0x00];
    expect(Array.from(stripCborFooter(codeFromBytes(zero)))).toEqual(zero);
  });

  test("k017_empty_code_leaves_code_unchanged", () => {
    expect(Array.from(stripCborFooter(mustCode("0x")))).toEqual([]);
  });

  test("k009_variable_length_footer_excluded_from_extraction", () => {
    // The footer blob carries a full dispatcher window for 0x70a08231.
    // The window must not leak into extraction at a non-53 footer length.
    const blob = [0xa1, 0x80, 0x63, 0x70, 0xa0, 0x82, 0x31, 0x14, 0x60, 0x05, 0x57];
    const full = codeFromBytes([...DISPATCHER, ...blob, 0x00, 0x0b]);
    expect(extractSelectors(full)).toEqual([
      { kind: "paired", selector: "0xa9059cbb", target: 10 },
    ]);
  });
});
