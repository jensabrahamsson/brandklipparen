// Per-bytecode engine memo (C-12, F-11 memo part).
// Pure domain module: a small bounded LRU over exact bytecode content so
// one analysis builds a single CFG, a single selector scan, one attribution
// per mode and one interpreter result per selector, no matter how many
// detectors, proof routes and snippet requests read the same code. The
// cache only removes work: every slot holds exactly the value the uncached
// computation returns, so scored outputs are bit-identical with and without
// it. Exceptions are never cached: a throwing compute rethrows and stores
// nothing, so a later call retries the work.
// Keying is by exact content (lowercase hex of the bytes), never by object
// identity: equal content in different Uint8Array instances shares one
// entry. At most CAP distinct codes stay live; the eldest entry evicts
// whole (all its slots at once), so the proxy, implementation and owner
// codes of one request rotate cleanly instead of interleaving stale parts.
import { buildCfg } from "./evmLift.ts";
import type { ControlFlowGraph } from "./evmLift.ts";
import { lift } from "./evmLift.ts";
import { extractSelectors } from "./selectors.ts";
import type { SelectorEntry } from "./selectors.ts";
import type { Bytecode as BytecodeType } from "./types.ts";

export type EngineMemoStats = {
  readonly hits: number;
  readonly misses: number;
};

type Memo = { readonly key: string; readonly slots: Map<string, unknown> };

// Four live codes cover the proxy, implementation, admin and one spare
// analysis in a single request without churning.
const CAP = 4;

const memos = new Map<string, Memo>();
let hits = 0;
let misses = 0;

// Hex keys are expensive to rebuild, so each bytecode object remembers its
// own key. Content-equal instances compute it once each and then share the
// single LRU entry for that content.
const keyByObject = new WeakMap<BytecodeType, string>();

function keyOf(bytecode: BytecodeType): string {
  const cached = keyByObject.get(bytecode);
  if (cached !== undefined) {
    return cached;
  }
  const parts = new Array<string>(bytecode.length);
  for (let index = 0; index < bytecode.length; index += 1) {
    parts[index] = (bytecode[index] ?? 0).toString(16).padStart(2, "0");
  }
  const key = parts.join("");
  keyByObject.set(bytecode, key);
  return key;
}

function memoFor(bytecode: BytecodeType): Memo {
  const key = keyOf(bytecode);
  const hit = memos.get(key);
  if (hit !== undefined) {
    // LRU refresh: reinsertion moves the entry to the newest end.
    memos.delete(key);
    memos.set(key, hit);
    return hit;
  }
  const memo: Memo = { key, slots: new Map<string, unknown>() };
  if (memos.size >= CAP) {
    const oldest = memos.keys().next().value;
    if (oldest !== undefined) {
      memos.delete(oldest);
    }
  }
  memos.set(key, memo);
  return memo;
}

// One memoised slot of a bytecode's entry. A present slot reads as a hit;
// a missing slot computes, stores and reads as a miss. A throwing compute
// stores nothing, so the miss is retried on the next call.
export function memoized<T>(bytecode: BytecodeType, slot: string, compute: () => T): T {
  const memo = memoFor(bytecode);
  if (memo.slots.has(slot)) {
    hits += 1;
    return memo.slots.get(slot) as T;
  }
  misses += 1;
  const value = compute();
  memo.slots.set(slot, value);
  return value;
}

// The lifted CFG, built once per content.
export function cfgOf(bytecode: BytecodeType): ControlFlowGraph {
  return memoized(bytecode, "cfg", () => buildCfg(lift(bytecode)));
}

// The landed selector scan, shared by attribution and the interpreters.
// Callers only read the entries; the array is never mutated.
export function selectorsOf(bytecode: BytecodeType): readonly SelectorEntry[] {
  return memoized(bytecode, "selectors", () => extractSelectors(bytecode));
}

function pcToBlockTable(bytecode: BytecodeType): Int32Array {
  return memoized(bytecode, "pcToBlock", () => {
    const cfg = cfgOf(bytecode);
    const table = new Int32Array(bytecode.length).fill(-1);
    for (const block of cfg.blocks) {
      const end = Math.min(block.range.endPc, table.length);
      for (let pc = block.range.startPc; pc < end; pc += 1) {
        if (pc >= 0) {
          table[pc] = block.index;
        }
      }
    }
    return table;
  });
}

function startPcToBlockTable(bytecode: BytecodeType): ReadonlyMap<number, number> {
  return memoized(bytecode, "startPcToBlock", () => {
    const cfg = cfgOf(bytecode);
    const table = new Map<number, number>();
    for (const block of cfg.blocks) {
      if (!table.has(block.range.startPc)) {
        table.set(block.range.startPc, block.index);
      }
    }
    return table;
  });
}

// O(1) block lookup by instruction PC: -1 outside every block range.
export function blockIndexAtPc(bytecode: BytecodeType, pc: number): number {
  if (!Number.isInteger(pc)) {
    return -1;
  }
  const table = pcToBlockTable(bytecode);
  if (pc < 0 || pc >= table.length) {
    return -1;
  }
  return table[pc] ?? -1;
}

// O(1) block lookup by block start PC: -1 when no block starts there.
export function blockStartingAt(bytecode: BytecodeType, pc: number): number {
  if (!Number.isInteger(pc)) {
    return -1;
  }
  return startPcToBlockTable(bytecode).get(pc) ?? -1;
}

// Precomputed per-CFG shape for the dynamic-return walk: JUMPDEST PCs to
// their blocks, reverse edges, static callers per helper entry, and the
// helper-entry set (a JUMPDEST block some other block statically jumps
// to). Built once per content; every dynamic-return query reads it.
export type DynIndex = {
  readonly jumpDestByPc: ReadonlyMap<number, number>;
  readonly predecessors: ReadonlyMap<number, readonly number[]>;
  readonly staticCallersOf: ReadonlyMap<number, readonly number[]>;
  readonly entryBlocks: ReadonlySet<number>;
};

export function dynIndexOf(bytecode: BytecodeType): DynIndex {
  return memoized(bytecode, "dynIndex", () => {
    const cfg = cfgOf(bytecode);
    const jumpDestByPc = new Map<number, number>();
    for (const block of cfg.blocks) {
      if (block.instructions[0]?.opcode === 0x5b && !jumpDestByPc.has(block.range.startPc)) {
        jumpDestByPc.set(block.range.startPc, block.index);
      }
    }
    const predecessors = new Map<number, number[]>();
    const staticCallersOf = new Map<number, number[]>();
    for (const block of cfg.blocks) {
      for (const edge of block.successors) {
        const targets = edge.kind === "conditional" ? [edge.to, edge.fallThrough] : [edge.to];
        for (const to of targets) {
          const known = predecessors.get(to);
          if (known === undefined) {
            predecessors.set(to, [block.index]);
          } else {
            known.push(block.index);
          }
          if (edge.kind === "jump") {
            const callers = staticCallersOf.get(to);
            if (callers === undefined) {
              staticCallersOf.set(to, [block.index]);
            } else {
              callers.push(block.index);
            }
          }
        }
      }
    }
    const entryBlocks = new Set<number>();
    for (const entry of staticCallersOf.keys()) {
      const block = cfg.blocks[entry];
      if (block !== undefined && block.instructions[0]?.opcode === 0x5b) {
        entryBlocks.add(entry);
      }
    }
    for (const holders of predecessors.values()) {
      Object.freeze(holders);
    }
    for (const holders of staticCallersOf.values()) {
      Object.freeze(holders);
    }
    return Object.freeze({
      jumpDestByPc,
      predecessors,
      staticCallersOf,
      entryBlocks,
    });
  });
}

export function clearEngineMemo(): void {
  memos.clear();
  hits = 0;
  misses = 0;
}

export function engineMemoStats(): EngineMemoStats {
  return Object.freeze({ hits, misses });
}
