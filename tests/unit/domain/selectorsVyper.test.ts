// Tests for S-115 (K-009, K-010): Vyper-style dispatcher coverage in
// selector extraction. Written first (red) per A-21: the implementation in
// src/domain/selectors.ts recognises Solidity DUP1/DUP2 windows only, so
// the chained and XOR windows below yield nothing until the story lands.
// Every snippet is hand-assembled synthetic bytecode in this file: no real
// contract bytecode and no external data. Each reported selector is either
// paired with its jump-target PC offset or explicitly marked unknown.
import { describe, expect, test } from "vitest";
import { Bytecode } from "../../../src/domain/types.ts";
import type { Bytecode as BytecodeType } from "../../../src/domain/types.ts";
import { extractSelectors } from "../../../src/domain/selectors.ts";

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

// A minimal Vyper-style dispatcher head: calldata word loaded, shifted
// right by 224 to isolate the selector, then chained comparisons that
// reuse the selector on the stack instead of re-duplicating it.
function vyperHead(): number[] {
  return [0x35, 0x60, 0xe0, 0x1c];
}

describe("s115 vyper dispatcher extraction", () => {
  test("s115_vyper_dispatcher_extracts_selectors", () => {
    // CALLDATALOAD, PUSH1 0xe0, SHR, then three comparison windows:
    // A: DUP1 PUSH4 0x06fdde03 EQ PUSH2 dest JUMPI (classic, already works),
    // V1: PUSH4 0xa9059cbb EQ PUSH2 dest JUMPI (chained reuse, no DUP),
    // V2: DUP1 PUSH4 0x23b872dd XOR ISZERO PUSH2 dest JUMPI.
    const base = vyperHead();
    const first = [0x80, 0x63, 0x06, 0xfd, 0xde, 0x03, 0x14, 0x61, 0x00, 0x2c, 0x57];
    const second = [0x63, 0xa9, 0x05, 0x9c, 0xbb, 0x14, 0x61, 0x00, 0x32, 0x57];
    const third = [0x80, 0x63, 0x23, 0xb8, 0x72, 0xdd, 0x18, 0x15, 0x61, 0x00, 0x38, 0x57];
    // Padding with entry-point marks at the three destinations (44, 50,
    // 56) so every PUSH2 target lands inside the code.
    const tail = [
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x5b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x5b, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x5b, 0x00, 0x00, 0x00, 0x00,
    ];
    const code = codeFromBytes([...base, ...first, ...second, ...third, ...tail]);
    const entries = extractSelectors(code);
    expect(entries).toEqual([
      { kind: "paired", selector: "0x06fdde03", target: 44 },
      { kind: "paired", selector: "0x23b872dd", target: 56 },
      { kind: "paired", selector: "0xa9059cbb", target: 50 },
    ]);
  });

  test("s115_vyper_chained_compare_without_target_marked_unknown", () => {
    // PUSH4 0xa9059cbb EQ STOP: chained comparison with no PUSH plus
    // JUMPI destination, so the target stays explicitly unknown.
    const entries = extractSelectors(codeFromBytes([0x63, 0xa9, 0x05, 0x9c, 0xbb, 0x14, 0x00]));
    expect(entries).toEqual([{ kind: "unknown", selector: "0xa9059cbb" }]);
  });

  test("s115_vyper_xor_compare_without_iszero_marked_unknown", () => {
    // DUP1 PUSH4 0x23b872dd XOR PUSH2 dest JUMPI: without ISZERO the jump
    // enters on mismatch, so it never proves a function entry.
    const entries = extractSelectors(
      codeFromBytes([0x80, 0x63, 0x23, 0xb8, 0x72, 0xdd, 0x18, 0x61, 0x00, 0x20, 0x57, 0x5b, 0x00]),
    );
    expect(entries).toEqual([{ kind: "unknown", selector: "0x23b872dd" }]);
  });

  test("s115_vyper_dup2_xor_variant_pairs_selector", () => {
    // PUSH4 0x70a08231 DUP2 XOR ISZERO PUSH1 dest JUMPI JUMPDEST STOP.
    const entries = extractSelectors(
      codeFromBytes([
        0x63, 0x70, 0xa0, 0x82, 0x31, 0x81, 0x18, 0x15, 0x60, 0x0c, 0x57, 0x5b, 0x00,
      ]),
    );
    expect(entries).toEqual([{ kind: "paired", selector: "0x70a08231", target: 12 }]);
  });

  test("s115_short_push_vyper_chained_compare_pairs_selector", () => {
    // PUSH3 0xfdd58e EQ PUSH1 0x08 JUMPI JUMPDEST STOP: the V1 chained
    // window accepts a minimal-width push, padded here to 0x00fdd58e.
    const entries = extractSelectors(
      codeFromBytes([0x62, 0xfd, 0xd5, 0x8e, 0x14, 0x60, 0x08, 0x57, 0x5b, 0x00]),
    );
    expect(entries).toEqual([{ kind: "paired", selector: "0x00fdd58e", target: 8 }]);
  });

  test("s115_short_push_vyper_xor_compare_pairs_selector", () => {
    // DUP1 PUSH2 0x1234 XOR ISZERO PUSH1 0x08 JUMPI JUMPDEST STOP: the V2
    // XOR window accepts a minimal-width push, padded here to 0x00001234.
    const entries = extractSelectors(
      codeFromBytes([
        0x80, 0x61, 0x12, 0x34, 0x18, 0x15, 0x60, 0x08, 0x57, 0x5b, 0x00,
      ]),
    );
    expect(entries).toEqual([{ kind: "paired", selector: "0x00001234", target: 8 }]);
  });

  test("s115_short_push_vyper_dup2_xor_variant_pairs_selector", () => {
    // PUSH1 0x07 DUP2 XOR ISZERO PUSH1 0x08 JUMPI JUMPDEST STOP: the V2
    // DUP2 mirror accepts a minimal-width push, padded to 0x00000007.
    const entries = extractSelectors(
      codeFromBytes([0x60, 0x07, 0x81, 0x18, 0x15, 0x60, 0x08, 0x57, 0x5b, 0x00]),
    );
    expect(entries).toEqual([{ kind: "paired", selector: "0x00000007", target: 8 }]);
  });

  test("s115_solidity_windows_still_pair_after_vyper_change", () => {
    // Regression guard: the two landed Solidity windows keep pairing.
    const first = extractSelectors(
      codeFromBytes([0x80, 0x63, 0xa9, 0x05, 0x9c, 0xbb, 0x14, 0x60, 0x0a, 0x57, 0x5b, 0x00]),
    );
    expect(first).toEqual([{ kind: "paired", selector: "0xa9059cbb", target: 10 }]);
    const second = extractSelectors(
      codeFromBytes([0x63, 0x40, 0xc1, 0x0f, 0x19, 0x81, 0x14, 0x60, 0x0a, 0x57, 0x5b, 0x00]),
    );
    expect(second).toEqual([{ kind: "paired", selector: "0x40c10f19", target: 10 }]);
  });
});
