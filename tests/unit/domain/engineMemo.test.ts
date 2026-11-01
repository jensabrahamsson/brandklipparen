// C-12 (F-11 memo part): the per-bytecode engine memo keeps one CFG, one
// selector scan, one attribution per mode and one interpreter result per
// selector for each bytecode, with O(1) block lookups. Results are
// bit-identical with and without the memo: every snapshot below compares
// a cold run (memo cleared first) against a warm rerun. Synthetic
// hand-assembled fixtures only; no network, no real addresses.
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { Bytecode, CodeHash } from "../../../src/domain/types.ts";
import type { Bytecode as BytecodeType } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import { disassemble, extractSelectors } from "../../../src/domain/selectors.ts";
import { attributeFunctions } from "../../../src/domain/evmFlow.ts";
import {
  analyzeOwnerControl,
  interpretRegionExprs,
  interpretRegionSlots,
} from "../../../src/domain/ownerControl.ts";
import { decompilePreferV2 } from "../../../src/domain/decompileV2.ts";
import {
  blockIndexAtPc,
  cfgOf,
  clearEngineMemo,
  engineMemoStats,
} from "../../../src/domain/engineMemo.ts";
import {
  expPackedPauseToken,
  oz4BlacklistTokenHex,
  packedPauseToken,
  sharedBlacklistTokenHex,
} from "../../helpers/ownerControlFixtures.ts";
import { Asm } from "../../helpers/evmAsm.ts";
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function mustCode(hex: string): BytecodeType {
  return mustOk(Bytecode.parse(hex));
}

// Canonical JSON: sorted object keys, Maps as sorted entry arrays, bigints
// (expression constants) as tagged strings, byte arrays as number arrays.
function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") {
    return `bigint:${value.toString()}`;
  }
  if (value instanceof Map) {
    const entries = [...value.entries()].map(
      ([key, entryValue]) => [canonicalize(key), canonicalize(entryValue)] as const,
    );
    entries.sort((left, right) => (String(left[0]) < String(right[0]) ? -1 : 1));
    return { __map: entries };
  }
  if (value instanceof Uint8Array) {
    return [...value];
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function snapshotOf(code: BytecodeType): string {
  const parts: Record<string, unknown> = {};
  parts.ocV1 = canonicalize(analyzeOwnerControl(code));
  parts.ocV2 = canonicalize(analyzeOwnerControl(code, { reach: "v2" }));
  const paired = extractSelectors(code).filter((entry) => entry.kind === "paired");
  const perSelector: unknown[] = [];
  for (const entry of paired) {
    perSelector.push([
      entry.selector,
      canonicalize(interpretRegionExprs(code, entry.selector)),
      canonicalize(interpretRegionSlots(code, entry.selector)),
    ]);
  }
  parts.exprs = perSelector;
  const v1 = attributeFunctions(code);
  const v2 = attributeFunctions(code, { mode: "v2" });
  parts.holders = disassemble(code).map((instruction) => [
    instruction.pc,
    v1.holdersOf(instruction.pc),
    v2.holdersOf(instruction.pc),
  ]);
  parts.decompile = decompilePreferV2(code).text;
  return JSON.stringify(parts);
}

// The shared-return shape from reachV2.test.ts, rebuilt here: `transfer`
// and `transferFrom` push a return address, jump into a shared helper that
// ends in a dynamic JUMP, and continue past the return with one gate each.
function sharedReturnHex(): string {
  const asm = new Asm();
  asm.op(0x80).push4("a9059cbb").op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4("23b872dd").op(0x14);
  asm.pushLabel2("transferFromEntry").op(0x57);
  asm.label("fallback");
  asm.op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("transferEntry").op(0x5b);
  asm.pushLabel2("ret1");
  asm.pushLabel2("shared");
  asm.op(0x56);
  asm.label("transferFromEntry").op(0x5b);
  asm.pushLabel2("ret2");
  asm.pushLabel2("shared");
  asm.op(0x56);
  asm.label("shared");
  asm.op(0x5b);
  asm.push1(0x01).push1(0x02).op(0x01);
  asm.op(0x56);
  asm.op(0xfe);
  asm.label("ret1").op(0x5b);
  asm.push1(0x01).push1(0x00);
  asm.op(0x55, 0x00);
  asm.label("ret2").op(0x5b);
  asm.push1(0x02).push1(0x00);
  asm.op(0x55, 0x00);
  return asm.build();
}

// USDC-implementation-sized synthetic: 55 dispatcher selectors, each body
// an owner guard plus two internal calls into shared helpers plus an
// SSTORE, padded to about 20 KB.
function usdcSizedHex(): string {
  const COUNT = 55;
  const asm = new Asm();
  for (let index = 0; index < COUNT; index += 1) {
    asm.op(0x80).push4((0x10000000 + index).toString(16)).op(0x14);
    asm.pushLabel2(`entry${index}`).op(0x57);
  }
  asm.label("fallback").op(0x5b, 0x00);
  for (let index = 0; index < COUNT; index += 1) {
    asm.label(`entry${index}`).op(0x5b);
    asm.op(0x33).push1(0x00).op(0x54, 0x14);
    asm.pushLabel2(`ok${index}`).op(0x57);
    asm.push1(0x00).op(0x80, 0xfd);
    asm.label(`ok${index}`).op(0x5b);
    asm.pushLabel2(`ret${index}a`).pushLabel2("helperA").op(0x56);
    asm.label(`ret${index}a`).op(0x5b);
    asm.pushLabel2(`ret${index}b`).pushLabel2("helperB").op(0x56);
    asm.label(`ret${index}b`).op(0x5b);
    asm.push1(index & 0xff).push1(0x07).op(0x55);
    for (let fill = 0; fill < 48; fill += 1) {
      asm.push1(0x01).push1(0x02).op(0x01, 0x50);
    }
    asm.op(0x00);
  }
  asm.label("helperA").op(0x5b).push1(0x01).push1(0x02).op(0x01, 0x56);
  asm.op(0xfe);
  asm.label("helperB").op(0x5b).push1(0x03).push1(0x04).op(0x01, 0x56);
  asm.op(0xfe);
  asm.label("helperC").op(0x5b).push1(0x05).push1(0x06).op(0x01, 0x56);
  asm.op(0xfe);
  return asm.build();
}

describe("per-bytecode engine memo", () => {
  test("c12_memoized_equals_fresh_for_fixtures", () => {
    const fixtures: BytecodeType[] = [
      packedPauseToken(),
      mustCode(sharedBlacklistTokenHex()),
      mustCode(oz4BlacklistTokenHex()),
      expPackedPauseToken(),
      mustCode(sharedReturnHex()),
    ];
    for (const code of fixtures) {
      clearEngineMemo();
      const cold = snapshotOf(code);
      const warm = snapshotOf(code);
      expect(warm).toBe(cold);
      expect(engineMemoStats().hits).toBeGreaterThan(0);
    }
  });

  test("c12_equal_content_shares_entry", () => {
    clearEngineMemo();
    const before = engineMemoStats();
    const first = mustCode(sharedBlacklistTokenHex());
    const second = mustCode(sharedBlacklistTokenHex());
    expect(first).not.toBe(second);
    const cfgFirst = cfgOf(first);
    const middle = engineMemoStats();
    const cfgSecond = cfgOf(second);
    const after = engineMemoStats();
    expect(cfgSecond).toBe(cfgFirst);
    expect(middle.misses - before.misses).toBe(1);
    expect(after.hits - middle.hits).toBe(1);
  });

  test("c12_lru_evicts_after_four", () => {
    clearEngineMemo();
    const codes = [0, 1, 2, 3, 4].map((index) =>
      mustCode(`0x5b60${index.toString(16).padStart(2, "0")}00`),
    );
    for (const code of codes) {
      cfgOf(code);
    }
    const settled = engineMemoStats();
    // Five distinct codes through a 4-entry memo: the eldest is gone.
    cfgOf(codes[0] ?? mustCode("0x5b600000"));
    const afterEvicted = engineMemoStats();
    expect(afterEvicted.misses - settled.misses).toBe(1);
    cfgOf(codes[4] ?? mustCode("0x5b600400"));
    const afterKept = engineMemoStats();
    expect(afterKept.hits - afterEvicted.hits).toBe(1);
  });

  test("c12_blockIndexAtPc_matches_linear_scan", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 400 }), (bytes) => {
        const code = mustCode(`0x${Buffer.from(bytes).toString("hex")}`);
        const cfg = cfgOf(code);
        const linear = (pc: number): number => {
          for (const block of cfg.blocks) {
            if (pc >= block.range.startPc && pc < block.range.endPc) {
              return block.index;
            }
          }
          return -1;
        };
        for (let pc = 0; pc <= code.length; pc += 1) {
          expect(blockIndexAtPc(code, pc)).toBe(linear(pc));
        }
        expect(blockIndexAtPc(code, -1)).toBe(-1);
        expect(blockIndexAtPc(code, code.length + 100)).toBe(-1);
      }),
      { numRuns: 50 },
    );
  });

  test("c12_usdc_sized_synthetic_under_1s", () => {
    const hex = usdcSizedHex();
    const code = mustCode(hex);
    expect(code.length).toBeGreaterThan(15_000);
    expect(extractSelectors(code).filter((entry) => entry.kind === "paired")).toHaveLength(55);
    const set = mustDefaultDetectorSet();
    const input: DetectorInput = Object.freeze({
      bytecode: code,
      codeHash: mustOk(CodeHash.of(code)),
      cloneMatch: null,
      decompilerCause: null,
      proxyFact: null,
    });
    const runAll = (): number => {
      let total = 0;
      for (const entry of set.registry.entries) {
        total += entry.detect(input).length;
      }
      total += decompilePreferV2(code).functions.length;
      return total;
    };
    clearEngineMemo();
    const heapBefore = process.memoryUsage().heapUsed;
    const coldStart = Date.now();
    const coldTotal = runAll();
    const coldMs = Date.now() - coldStart;
    const heapAfter = process.memoryUsage().heapUsed;
    const warmStart = Date.now();
    const warmTotal = runAll();
    const warmMs = Date.now() - warmStart;
    // Identical findings cold and warm: the memo only removes work.
    expect(warmTotal).toBe(coldTotal);
    const coldBudget = process.env["CI"] === undefined ? 1000 : 1500;
    expect(coldMs).toBeLessThan(coldBudget);
    expect(warmMs).toBeLessThan(50);
    expect(heapAfter - heapBefore).toBeLessThan(150 * 1024 * 1024);
  });
});
