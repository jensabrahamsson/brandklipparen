// Symbolic dataflow tests (S-079, K-037, K-521, D-03).
// Written first per A-21 (red): src/domain/evmFlow.ts does not exist
// yet. The sixteen entry cases cover both landed dispatcher paths
// across destination widths and layouts; fixtures are hand-assembled
// with the test-only assembler. No network happens here.
import { describe, expect, test } from "vitest";
import { Bytecode } from "../../../src/domain/types.ts";
import { buildCfg, lift } from "../../../src/domain/evmLift.ts";
import {
  dispatcherTopology,
  findFunctionEntries,
} from "../../../src/domain/evmFlow.ts";
import type { Result } from "../../../src/domain/result.ts";
import { Asm } from "../../helpers/evmAsm.ts";

function mustOk<T>(result: Result<T, { message: string }>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function bytecodeOf(hex: string) {
  return mustOk(Bytecode.parse(hex));
}

const SELECTOR = "a9059cbb";

// One minimal dispatcher fragment: the entry under test plus a halting
// body at the labelled target. Path A reads DUP1/PUSH4/EQ; path B reads
// PUSH4/DUP2/EQ (the LIB idiom). The destination width varies 1-4.
function entryCase(path: "a" | "b", destWidth: 1 | 2 | 3 | 4): string {
  const asm = new Asm();
  if (path === "a") {
    asm.op(0x80).push4(SELECTOR).op(0x14);
  } else {
    asm.push4(SELECTOR).op(0x81, 0x14);
  }
  asm.pushLabel(destWidth, "body").op(0x57);
  asm.label("body").op(0x5b, 0x00);
  return asm.build();
}

function entriesOf(hex: string) {
  const code = bytecodeOf(hex);
  return findFunctionEntries(code, buildCfg(lift(code)));
}

describe("evm symbolic dataflow", () => {
  test("k522_function_entries_cover_sixteen_valid_cases", () => {
    // Cases 1-8: both dispatcher paths across all destination widths.
    let covered = 0;
    for (const path of ["a", "b"] as const) {
      for (const width of [1, 2, 3, 4] as const) {
        const entries = entriesOf(entryCase(path, width));
        expect(entries.length).toBe(1);
        expect(entries[0]?.selector).toBe(`0x${SELECTOR}`);
        expect(entries[0]?.entryBlock).toBeGreaterThanOrEqual(0);
        expect(entries[0]?.hasHalt).toBe(true);
        covered += 1;
      }
    }

    // Case 9: two chained selectors, both paired.
    const two = new Asm();
    two.op(0x80).push4("a9059cbb").op(0x14);
    two.pushLabel2("t1").op(0x57);
    two.op(0x80).push4("70a08231").op(0x14);
    two.pushLabel2("t2").op(0x57);
    two.label("t1").op(0x5b, 0x00);
    two.label("t2").op(0x5b, 0x00);
    expect(entriesOf(two.build()).map((entry) => entry.selector).sort()).toEqual([
      "0x70a08231",
      "0xa9059cbb",
    ]);
    covered += 1;

    // Case 10: a duplicated selector keeps its first occurrence.
    const dup = new Asm();
    dup.op(0x80).push4(SELECTOR).op(0x14);
    dup.pushLabel2("first").op(0x57);
    dup.op(0x80).push4(SELECTOR).op(0x14);
    dup.pushLabel2("second").op(0x57);
    dup.label("first").op(0x5b, 0x00);
    dup.label("second").op(0x5b, 0x00);
    const dupEntries = entriesOf(dup.build());
    expect(dupEntries.length).toBe(1);
    covered += 1;

    // Case 11: EQ without a following PUSH plus JUMPI stays unknown.
    const bare = new Asm().op(0x80).push4(SELECTOR).op(0x14, 0x5b, 0x00).build();
    expect(entriesOf(bare)).toEqual([]);
    covered += 1;

    // Case 12: an out-of-range destination stays unknown.
    const far = new Asm().op(0x80).push4(SELECTOR).op(0x14).push2(0xffff).op(0x57, 0x00).build();
    expect(entriesOf(far)).toEqual([]);
    covered += 1;

    // Case 13: an in-range destination off a JUMPDEST pairs in the
    // extractor but resolves to no entry block.
    const off = new Asm().op(0x80).push4(SELECTOR).op(0x14).push2(0x0001).op(0x57, 0x00).build();
    expect(entriesOf(off)).toEqual([]);
    covered += 1;

    // Case 14: three chained selectors.
    const three = new Asm();
    for (const selector of ["a9059cbb", "70a08231", "095ea7b3"]) {
      three.op(0x80).push4(selector).op(0x14);
      three.pushLabel2(`t-${selector}`).op(0x57);
    }
    for (const selector of ["a9059cbb", "70a08231", "095ea7b3"]) {
      three.label(`t-${selector}`).op(0x5b, 0x00);
    }
    expect(entriesOf(three.build()).length).toBe(3);
    covered += 1;

    // Case 15: path B with a PUSH1 destination (narrow LIB layout).
    const narrow = new Asm();
    narrow.push4("23b872dd").op(0x81, 0x14);
    narrow.pushLabel(1, "body").op(0x57);
    narrow.label("body").op(0x5b, 0x00);
    const narrowEntries = entriesOf(narrow.build());
    expect(narrowEntries.length).toBe(1);
    expect(narrowEntries[0]?.selector).toBe("0x23b872dd");
    covered += 1;

    // Case 16: no selector pattern means no entries, not an error.
    const plain = new Asm().push1(0x01).op(0x00).build();
    expect(entriesOf(plain)).toEqual([]);
    covered += 1;

    expect(covered).toBe(16);
  });

  test("k522_selector_extraction_covers_dup2_lib_path", () => {
    // Path B: PUSH4 <selector> DUP2 EQ PUSH2 <dest> JUMPI.
    const asm = new Asm();
    asm.push4(SELECTOR).op(0x81, 0x14);
    asm.pushLabel2("body").op(0x57);
    asm.label("body").op(0x5b, 0x00);
    const code = bytecodeOf(asm.build());
    const entries = findFunctionEntries(code, buildCfg(lift(code)));
    expect(entries.map((entry) => entry.selector)).toContain(`0x${SELECTOR}`);
    expect(entries[0]?.hasHalt).toBe(true);
  });

  test("k522_dispatcher_topology_maps_branches_to_selectors", () => {
    const asm = new Asm();
    asm.op(0x80).push4("a9059cbb").op(0x14);
    asm.pushLabel2("t1").op(0x57);
    asm.op(0x80).push4("70a08231").op(0x14);
    asm.pushLabel2("t2").op(0x57);
    asm.label("fallback").op(0x5b, 0x00);
    asm.label("t1").op(0x5b, 0x00);
    asm.label("t2").op(0x5b, 0x00);
    const code = bytecodeOf(asm.build());
    const cfg = buildCfg(lift(code));
    const entries = findFunctionEntries(code, cfg);
    expect(entries.length).toBe(2);
    const topology = dispatcherTopology(cfg, entries);
    expect(topology.ok).toBe(true);
    if (!topology.ok) {
      return;
    }
    const bySelector = new Map(topology.value.branches.map((branch) => [branch.selector, branch]));
    expect(bySelector.get("0xa9059cbb")?.targetBlock).toBe(entries.find((entry) => entry.selector === "0xa9059cbb")?.entryBlock);
    expect(bySelector.get("0x70a08231")?.targetBlock).toBe(entries.find((entry) => entry.selector === "0x70a08231")?.entryBlock);
    expect(topology.value.fallbackBlock).not.toBe(null);
  });

  test("k522_unexpected_dispatcher_shape_reports_cause", () => {
    const flat = new Asm().push1(0x01).op(0x00).build();
    const flatCfg = buildCfg(lift(bytecodeOf(flat)));
    const topology = dispatcherTopology(flatCfg, []);
    expect(topology.ok).toBe(false);
    if (topology.ok) {
      return;
    }
    expect(topology.error.kind).toBe("unexpected-dispatcher-shape");
  });
});
