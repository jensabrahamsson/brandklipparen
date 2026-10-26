// Tests for S-012 (K-009): selector and pattern extraction in the fast path.
// Written first (red) per A-21; the implementation lives in
// src/domain/selectors.ts. All snippets below are small hand-assembled
// synthetic byte sequences built in this file: no real contract bytecode
// and no external data. No thresholds, weights or signature tables are
// used here; each entry is either paired with a jump-target PC offset or
// explicitly marked unknown.
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { Bytecode } from "../../../src/domain/types.ts";
import type { Bytecode as BytecodeType } from "../../../src/domain/types.ts";
import { disassemble, extractSelectors } from "../../../src/domain/selectors.ts";
import type { SelectorEntry } from "../../../src/domain/selectors.ts";

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

function rawToHex(raw: Uint8Array): string {
  return `0x${Array.from(raw, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

// Standard Solidity CBOR metadata footer (53 bytes), mirroring the rule in
// src/domain/types.ts. The 34 content bytes carry a fake dispatcher window
// so the test proves the footer region is excluded from extraction.
function cborFooter(): number[] {
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

describe("k009 selector extraction from hand-assembled snippets", () => {
  test("k009_empty_bytecode_yields_no_selectors", () => {
    expect(extractSelectors(mustCode("0x"))).toEqual([]);
  });

  test("k009_dispatcher_entry_pairs_selector_with_jump_target", () => {
    // DUP1 PUSH4 0xa9059cbb EQ PUSH1 0x0a JUMPI JUMPDEST STOP.
    const entries = extractSelectors(
      codeFromBytes([0x80, 0x63, 0xa9, 0x05, 0x9c, 0xbb, 0x14, 0x60, 0x0a, 0x57, 0x5b, 0x00]),
    );
    expect(entries).toEqual([{ kind: "paired", selector: "0xa9059cbb", target: 10 }]);
  });

  test("k009_out_of_range_target_marked_unknown", () => {
    // Same window but the PUSH1 destination sits past the end of the code.
    const entries = extractSelectors(
      codeFromBytes([0x80, 0x63, 0xa9, 0x05, 0x9c, 0xbb, 0x14, 0x60, 0xff, 0x57, 0x5b, 0x00]),
    );
    expect(entries).toEqual([{ kind: "unknown", selector: "0xa9059cbb" }]);
  });

  test("k009_missing_jump_target_marked_unknown", () => {
    // DUP1 PUSH4 0x70a08231 EQ STOP: the comparison half matches but no
    // PUSH plus JUMPI follows, so the target stays explicitly unknown.
    const entries: readonly SelectorEntry[] = extractSelectors(
      codeFromBytes([0x80, 0x63, 0x70, 0xa0, 0x82, 0x31, 0x14, 0x00]),
    );
    expect(entries).toEqual([{ kind: "unknown", selector: "0x70a08231" }]);
    const only = entries[0];
    if (only === undefined) {
      throw new Error("expected exactly one entry");
    }
    expect("target" in only).toBe(false);
  });

  test("k009_multiple_entries_sorted_canonically", () => {
    // Two windows in reverse selector order; output sorts by selector and
    // each entry keeps its own destination.
    const first = [0x80, 0x63, 0x70, 0xa0, 0x82, 0x31, 0x14, 0x60, 0x16, 0x57];
    const second = [0x80, 0x63, 0x40, 0xc1, 0x0f, 0x19, 0x14, 0x60, 0x14, 0x57];
    const padding = [0x5b, 0x5b, 0x5b, 0x5b];
    const entries = extractSelectors(codeFromBytes([...first, ...second, ...padding]));
    expect(entries).toEqual([
      { kind: "paired", selector: "0x40c10f19", target: 20 },
      { kind: "paired", selector: "0x70a08231", target: 22 },
    ]);
  });

  test("k009_push_dup_variant_pairs_selector", () => {
    // PUSH4 0x40c10f19 DUP2 EQ PUSH1 0x0a JUMPI JUMPDEST STOP.
    const entries = extractSelectors(
      codeFromBytes([0x63, 0x40, 0xc1, 0x0f, 0x19, 0x81, 0x14, 0x60, 0x0a, 0x57, 0x5b, 0x00]),
    );
    expect(entries).toEqual([{ kind: "paired", selector: "0x40c10f19", target: 10 }]);
  });

  test("k009_truncated_trailing_push_handled_safely", () => {
    // DUP1 followed by a PUSH4 with a single byte left: no selector, no throw.
    expect(extractSelectors(codeFromBytes([0x80, 0x63, 0xa9]))).toEqual([]);
    expect(extractSelectors(codeFromBytes([0x60]))).toEqual([]);
    const instructions = disassemble(codeFromBytes([0x80, 0x63, 0xa9]));
    expect(instructions.length).toBe(2);
    expect(instructions[1]?.opcode).toBe(0x63);
    expect(instructions[1]?.immediate.length).toBe(1);
  });

  test("k009_metadata_footer_excluded_from_extraction", () => {
    const dispatcher = [0x80, 0x63, 0xa9, 0x05, 0x9c, 0xbb, 0x14, 0x60, 0x0a, 0x57, 0x5b, 0x00];
    const withoutFooter = extractSelectors(codeFromBytes(dispatcher));
    const withFooter = extractSelectors(codeFromBytes([...dispatcher, ...cborFooter()]));
    expect(withFooter).toEqual(withoutFooter);
  });

  test("k009_push4_without_dispatcher_context_ignored", () => {
    // A bare PUSH4 constant and an AND bitmask carry no EQ comparison.
    expect(extractSelectors(codeFromBytes([0x63, 0xde, 0xad, 0xbe, 0xef, 0x00]))).toEqual([]);
    expect(
      extractSelectors(codeFromBytes([0x80, 0x63, 0xff, 0xff, 0xff, 0xff, 0x16])),
    ).toEqual([]);
  });

  test("k009_disassembler_covers_opcode_table", () => {
    const names = new Map<number, string>();
    for (const instruction of disassemble(codeFromBytes([0x00]))) {
      names.set(instruction.opcode, instruction.name);
    }
    expect(names.get(0x00)).toBe("STOP");
    const probe = (opcode: number): string =>
      disassemble(codeFromBytes([opcode]))[0]?.name ?? "";
    expect(probe(0x01)).toBe("ADD");
    expect(probe(0x14)).toBe("EQ");
    expect(probe(0x20)).toBe("KECCAK256");
    expect(probe(0x33)).toBe("CALLER");
    expect(probe(0x54)).toBe("SLOAD");
    expect(probe(0x55)).toBe("SSTORE");
    expect(probe(0x56)).toBe("JUMP");
    expect(probe(0x57)).toBe("JUMPI");
    expect(probe(0x5b)).toBe("JUMPDEST");
    expect(probe(0x5e)).toBe("MCOPY");
    expect(probe(0x5f)).toBe("PUSH0");
    expect(probe(0x60)).toBe("PUSH1");
    expect(probe(0x7f)).toBe("PUSH32");
    expect(probe(0x80)).toBe("DUP1");
    expect(probe(0x8f)).toBe("DUP16");
    expect(probe(0x90)).toBe("SWAP1");
    expect(probe(0x9f)).toBe("SWAP16");
    expect(probe(0xa0)).toBe("LOG0");
    expect(probe(0xa4)).toBe("LOG4");
    expect(probe(0xf1)).toBe("CALL");
    expect(probe(0xf3)).toBe("RETURN");
    expect(probe(0xfd)).toBe("REVERT");
    expect(probe(0xfe)).toBe("INVALID");
    expect(probe(0xff)).toBe("SELFDESTRUCT");
    expect(probe(0x0c)).toBe("UNDEFINED");
    expect(probe(0x21)).toBe("UNDEFINED");
    expect(probe(0xfb)).toBe("UNDEFINED");
  });

  test("k009_disassembler_advances_pc_past_push_data", () => {
    // PUSH2 0x0001 ADD: the two data bytes are not decoded as opcodes.
    const instructions = disassemble(codeFromBytes([0x61, 0x00, 0x01, 0x01]));
    expect(instructions.map((instruction) => instruction.pc)).toEqual([0, 3]);
    expect(instructions.map((instruction) => instruction.name)).toEqual(["PUSH2", "ADD"]);
    expect(Array.from(instructions[0]?.immediate ?? [])).toEqual([0x00, 0x01]);
  });
});

describe("k009 property", () => {
  test("k009_every_selector_paired_or_marked_unknown", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 400 }), (raw) => {
        const parsed = Bytecode.parse(rawToHex(raw));
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) {
          return;
        }
        const bytecode = parsed.value;
        const first = extractSelectors(bytecode);
        // Deterministic: a second run over the same bytes agrees exactly.
        expect(extractSelectors(bytecode)).toEqual(first);
        // Canonically sorted by selector with one entry per selector.
        const selectors = first.map((entry) => entry.selector);
        expect([...selectors].sort()).toEqual(selectors);
        expect(new Set(selectors).size).toBe(selectors.length);
        for (const entry of first) {
          expect(entry.selector).toMatch(/^0x[0-9a-f]{8}$/);
          if (entry.kind === "paired") {
            expect(Number.isInteger(entry.target)).toBe(true);
            expect(entry.target).toBeGreaterThanOrEqual(0);
            expect(entry.target).toBeLessThan(bytecode.length);
          } else {
            expect(entry.kind).toBe("unknown");
            expect("target" in entry).toBe(false);
          }
        }
      }),
      { seed: 90012, numRuns: 250 },
    );
  });
});
