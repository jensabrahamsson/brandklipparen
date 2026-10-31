// Symbolic dataflow over the lifted CFG: function entries, stack depth
// and dispatcher topology (S-079, K-037, K-521, D-03). Pure deterministic
// functions over `ControlFlowGraph` and the landed `extractSelectors`:
// entries pair dispatcher selectors with their proven entry blocks,
// stack depth propagates per-opcode effects with conflicts recorded as
// unknown, and the topology maps every taken branch back to its
// selector. A CFG with no conditional edge is not a dispatcher shape
// and reports the `unexpected-dispatcher-shape` cause instead of an
// empty topology.
import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";
import { extractSelectors } from "./selectors.ts";
import type { Bytecode as BytecodeType, Selector as SelectorType } from "./types.ts";
import type { ControlFlowGraph } from "./evmLift.ts";
import { buildCfg, lift, resolveEntryReachV2 } from "./evmLift.ts";

// One resolved function entry: the dispatcher selector, its proven entry
// PC, the entry block index, and whether the bounded forward walk from
// the entry reaches a halting opcode.
export type FunctionEntry = {
  readonly selector: string;
  readonly entryPc: number;
  readonly entryBlock: number;
  readonly hasHalt: boolean;
};

// Selector extraction covers both landed dispatcher paths: path A
// (`DUP1 PUSH4 <selector> EQ PUSHn <destination> JUMPI`) and the DUP2/LIB
// path B (`PUSH4 <selector> DUP2 EQ PUSHn <destination> JUMPI`).
// `extractSelectors` in selectors.ts recognises both; entries resolve the
// paired targets against the CFG block leaders.
export function findFunctionEntries(bytecode: BytecodeType, cfg: ControlFlowGraph): readonly FunctionEntry[] {
  const found: FunctionEntry[] = [];
  for (const candidate of extractSelectors(bytecode)) {
    if (candidate.kind !== "paired") {
      continue;
    }
    const selector = candidate.selector as string;
    const entryPc = candidate.target as number;
    const entryBlock = blockIndexAt(cfg, entryPc);
    if (entryBlock === -1) {
      continue;
    }
    found.push(
      Object.freeze({
        selector,
        entryPc,
        entryBlock,
        hasHalt: reachesHalt(cfg, entryBlock),
      }),
    );
  }
  return Object.freeze(found);
}

function blockIndexAt(cfg: ControlFlowGraph, pc: number): number {
  for (const block of cfg.blocks) {
    if (block.range.startPc === pc) {
      return block.index;
    }
  }
  return -1;
}

// Bounded forward walk (at most every block once) asking whether the
// entry region halts. Unresolved jumps end the walk for that path: an
// unproven edge is never followed.
function reachesHalt(cfg: ControlFlowGraph, from: number): boolean {
  const seen = new Set<number>();
  const queue: number[] = [from];
  while (queue.length > 0) {
    const index = queue.pop() ?? -1;
    if (seen.has(index)) {
      continue;
    }
    seen.add(index);
    const block = cfg.blocks[index];
    if (block === undefined) {
      continue;
    }
    if (block.terminal === "halt") {
      return true;
    }
    for (const edge of block.successors) {
      if (edge.kind === "fall-through" || edge.kind === "jump") {
        queue.push(edge.to);
      } else {
        queue.push(edge.to);
        queue.push(edge.fallThrough);
      }
    }
  }
  return false;
}

// Stack effect per opcode as (pops, pushes); null halts the block or is
// unknown to this table. The table covers the legacy opcode space the
// landed sweep emits; anything outside it stays null and records the
// path unknown rather than guessed.
function stackEffect(opcode: number): { pops: number; pushes: number } | null {
  if (opcode >= 0x60 && opcode <= 0x7f) {
    return { pops: 0, pushes: 1 };
  }
  if (opcode >= 0x80 && opcode <= 0x8f) {
    return { pops: 0, pushes: 1 };
  }
  if (opcode >= 0x90 && opcode <= 0x9f) {
    return { pops: 0, pushes: 0 };
  }
  switch (opcode) {
    case 0x00:
    case 0xfe:
      return null;
    case 0x01:
    case 0x02:
    case 0x03:
    case 0x04:
    case 0x05:
    case 0x06:
    case 0x07:
    case 0x0b:
    case 0x0c:
    case 0x0d:
    case 0x10:
    case 0x11:
    case 0x12:
    case 0x13:
    case 0x14:
    case 0x1b:
    case 0x1c:
    case 0x1d:
      return { pops: 2, pushes: 1 };
    case 0x08:
    case 0x09:
      return { pops: 3, pushes: 1 };
    case 0x0a:
      return { pops: 2, pushes: 1 };
    case 0x15:
    case 0x19:
      return { pops: 1, pushes: 1 };
    case 0x16:
    case 0x17:
    case 0x18:
    case 0x1a:
      return { pops: 2, pushes: 1 };
    case 0x20:
      return { pops: 2, pushes: 1 };
    case 0x30:
    case 0x32:
    case 0x33:
    case 0x34:
    case 0x36:
    case 0x38:
    case 0x3a:
    case 0x43:
    case 0x44:
    case 0x45:
    case 0x46:
    case 0x47:
    case 0x48:
    case 0x4a:
    case 0x58:
    case 0x59:
    case 0x5a:
      return { pops: 0, pushes: 1 };
    case 0x31:
    case 0x35:
    case 0x3b:
    case 0x3f:
    case 0x40:
    case 0x42:
    case 0x49:
    case 0x51:
    case 0x54:
    case 0x5c:
      return { pops: 1, pushes: 1 };
    case 0x37:
    case 0x39:
    case 0x3e:
      return { pops: 3, pushes: 0 };
    case 0x3c:
      return { pops: 4, pushes: 0 };
    case 0x3d:
    case 0x41:
      return { pops: 0, pushes: 1 };
    case 0x50:
      return { pops: 1, pushes: 0 };
    case 0x52:
    case 0x53:
      return { pops: 2, pushes: 0 };
    case 0x55:
    case 0x5d:
      return { pops: 2, pushes: 0 };
    case 0x56:
      return { pops: 1, pushes: 0 };
    case 0x57:
      return { pops: 2, pushes: 0 };
    case 0x5b:
      return { pops: 0, pushes: 0 };
    case 0x5e:
      return { pops: 3, pushes: 0 };
    case 0xa0:
    case 0xa1:
    case 0xa2:
    case 0xa3:
    case 0xa4:
      return { pops: 2 + (opcode - 0xa0), pushes: 0 };
    case 0xf0:
      return { pops: 3, pushes: 1 };
    case 0xf1:
    case 0xf2:
      return { pops: 7, pushes: 1 };
    case 0xf3:
    case 0xfd:
      return { pops: 2, pushes: 0 };
    case 0xf4:
    case 0xfa:
      return { pops: 6, pushes: 1 };
    case 0xf5:
      return { pops: 4, pushes: 1 };
    case 0xff:
      return { pops: 1, pushes: 0 };
    default:
      return { pops: 0, pushes: 0 };
  }
}

export type StackDepthAnalysis = {
  // Entry depth per block index; null when paths disagree or an opcode
  // is unknown to the table. The entry block starts at depth 0.
  readonly entryDepths: readonly (number | null)[];
  readonly maxDepth: number;
  readonly underflowBlocks: readonly number[];
};

// Forward dataflow over block entries: simulate each block from its entry
// depth, propagate to successors, and iterate to a fixed point (bounded
// by block count plus one). A join with a disagreeing depth records null
// rather than picking a side; a pop below zero records the underflow.
export function analyzeStackDepth(cfg: ControlFlowGraph): StackDepthAnalysis {
  const depths: (number | null | undefined)[] = new Array(cfg.blocks.length).fill(undefined);
  const underflows = new Set<number>();
  let maxDepth = 0;
  if (cfg.blocks.length > 0) {
    depths[cfg.entryBlock] = 0;
  }
  for (let round = 0; round < cfg.blocks.length + 1; round += 1) {
    let changed = false;
    for (const block of cfg.blocks) {
      const entry = depths[block.index];
      if (entry === undefined || entry === null) {
        continue;
      }
      let depth = entry;
      let known = true;
      for (const instruction of block.instructions) {
        const effect = stackEffect(instruction.opcode);
        if (effect === null) {
          // Halting opcodes (STOP, INVALID) always end their block by the
          // leader rules, so ending simulation here propagates nothing.
          break;
        }
        if (depth < effect.pops) {
          underflows.add(block.index);
          known = false;
          break;
        }
        depth += effect.pushes - effect.pops;
        if (depth > maxDepth) {
          maxDepth = depth;
        }
      }
      if (!known) {
        if (depths[block.index] !== null) {
          depths[block.index] = null;
          changed = true;
        }
        continue;
      }
      const propagate = (to: number): void => {
        if (to < 0 || to >= depths.length) {
          return;
        }
        const current = depths[to];
        if (current === undefined) {
          depths[to] = depth;
          changed = true;
        } else if (current !== null && current !== depth) {
          depths[to] = null;
          changed = true;
        }
      };
      for (const edge of block.successors) {
        if (edge.kind === "fall-through" || edge.kind === "jump") {
          propagate(edge.to);
        } else {
          propagate(edge.to);
          propagate(edge.fallThrough);
        }
      }
    }
    if (!changed) {
      break;
    }
  }
  return Object.freeze({
    entryDepths: Object.freeze(
      depths.map((depth) => (depth === undefined ? null : depth)),
    ),
    maxDepth,
    underflowBlocks: Object.freeze(Array.from(underflows).sort((left, right) => left - right)),
  });
}

// Reachability-based function attribution. For every paired dispatcher
// entry, the bounded CFG walk from its entry block collects the blocks the
// function body actually reaches: fall-through, proven jumps and both
// sides of proven conditional jumps are followed, while unresolved jumps
// end that path (an unproven edge is never followed). An opcode PC belongs
// to the entry whose walk reaches its block; a PC reached by zero entries
// (dispatcher preamble, fallback, dead code) or by more than one (shared
// tails jumped into from several bodies) belongs to no function and reads
// as unattributable, never guessed to an unrelated one. The old positional
// rule ("greatest entry target at or below the PC") misattributed shared
// tails and everything past the last entry target to the last dispatcher
// entry, so it is retired: every consumer below reads this walk instead.
//
// Attribution mode (P-10 session 1): `v1` is the scored default and stays
// byte-identical; `v2` reruns reachability per entry through the
// return-jump resolver in `./evmLift.ts`, so a shared helper reached through
// a dynamic return belongs to every entry that reaches it. Session 2 wires
// v2 into `ownerControl` behind its own flag; detectors keep `v1` until then.
export type AttributionMode = "v1" | "v2";

export type AttributionOptions = {
  readonly mode?: AttributionMode;
};

const EMPTY_HOLDERS: readonly SelectorType[] = Object.freeze([]);

export type FunctionAttribution = {
  readonly holderOf: (pc: number) => SelectorType | null;
  // Every entry whose walk reaches the PC (empty when none reaches it). In
  // v1 this mirrors `holderOf` (shared blocks read as empty); in v2 shared
  // blocks list every entry that reaches them, and region membership reads
  // this list instead of the single holder.
  readonly holdersOf: (pc: number) => readonly SelectorType[];
};

function blockAtPc(cfg: ControlFlowGraph, pc: number): number {
  for (const block of cfg.blocks) {
    if (pc >= block.range.startPc && pc < block.range.endPc) {
      return block.index;
    }
  }
  return -1;
}

function reachableFrom(cfg: ControlFlowGraph, from: number): ReadonlySet<number> {
  const seen = new Set<number>();
  const queue: number[] = [from];
  while (queue.length > 0) {
    const index = queue.pop() ?? -1;
    if (seen.has(index)) {
      continue;
    }
    seen.add(index);
    const block = cfg.blocks[index];
    if (block === undefined) {
      continue;
    }
    for (const edge of block.successors) {
      if (edge.kind === "fall-through" || edge.kind === "jump") {
        queue.push(edge.to);
      } else {
        queue.push(edge.to);
        queue.push(edge.fallThrough);
      }
    }
  }
  return seen;
}

export function attributeFunctions(bytecode: BytecodeType, options?: AttributionOptions): FunctionAttribution {
  const mode = options?.mode ?? "v1";
  const cfg = buildCfg(lift(bytecode));
  const reachers = new Map<number, SelectorType[]>();
  const entries: { readonly selector: SelectorType; readonly entryBlock: number }[] = [];
  for (const candidate of extractSelectors(bytecode)) {
    if (candidate.kind !== "paired") {
      continue;
    }
    const selector = candidate.selector;
    const entryPc = candidate.target as number;
    let entryBlock = -1;
    for (const block of cfg.blocks) {
      if (block.range.startPc === entryPc) {
        entryBlock = block.index;
        break;
      }
    }
    if (entryBlock === -1) {
      continue;
    }
    entries.push({ selector, entryBlock });
  }
  const claim = (block: number, selector: SelectorType): void => {
    const known = reachers.get(block);
    if (known === undefined) {
      reachers.set(block, [selector]);
    } else if (!known.includes(selector)) {
      known.push(selector);
    }
  };
  if (mode === "v2") {
    for (const entry of entries) {
      for (const reached of resolveEntryReachV2(cfg, entry.entryBlock).reachedBlocks) {
        claim(reached, entry.selector);
      }
    }
  } else {
    for (const entry of entries) {
      for (const reached of reachableFrom(cfg, entry.entryBlock)) {
        claim(reached, entry.selector);
      }
    }
  }
  for (const holders of reachers.values()) {
    Object.freeze(holders);
  }
  const holderOf = (pc: number): SelectorType | null => {
    const block = blockAtPc(cfg, pc);
    if (block === -1) {
      return null;
    }
    const holders = reachers.get(block);
    if (holders === undefined || holders.length !== 1) {
      return null;
    }
    return holders[0] ?? null;
  };
  const holdersOf = (pc: number): readonly SelectorType[] => {
    const block = blockAtPc(cfg, pc);
    if (block === -1) {
      return EMPTY_HOLDERS;
    }
    const holders = reachers.get(block);
    if (mode !== "v2") {
      return holders !== undefined && holders.length === 1 ? holders : EMPTY_HOLDERS;
    }
    return holders ?? EMPTY_HOLDERS;
  };
  return Object.freeze({ holderOf, holdersOf });
}

// One dispatcher branch: the selector, the block holding its conditional
// edge, the taken block and the fall-through block.
export type DispatcherBranch = {
  readonly selector: string;
  readonly viaBlock: number;
  readonly targetBlock: number;
  readonly fallThrough: number;
};

export type DispatcherTopology = {
  readonly branches: readonly DispatcherBranch[];
  readonly fallbackBlock: number | null;
};

export type DispatcherTopologyError = {
  kind: "unexpected-dispatcher-shape";
  message: string;
};

// Dispatcher topology: every taken branch maps back to its selector by
// matching the conditional edge target against the resolved entries. A
// CFG with no conditional edge carries no dispatcher shape and reports
// the cause instead of an empty topology.
export function dispatcherTopology(
  cfg: ControlFlowGraph,
  entries: readonly FunctionEntry[],
): Result<DispatcherTopology, DispatcherTopologyError> {
  const byTarget = new Map<number, FunctionEntry>();
  for (const entry of entries) {
    byTarget.set(entry.entryBlock, entry);
  }
  const branches: DispatcherBranch[] = [];
  for (const block of cfg.blocks) {
    for (const edge of block.successors) {
      if (edge.kind !== "conditional") {
        continue;
      }
      const entry = byTarget.get(edge.to);
      if (entry === undefined) {
        continue;
      }
      branches.push(
        Object.freeze({
          selector: entry.selector,
          viaBlock: block.index,
          targetBlock: edge.to,
          fallThrough: edge.fallThrough,
        }),
      );
    }
  }
  if (branches.length === 0) {
    return err({
      kind: "unexpected-dispatcher-shape",
      message: "the CFG carries no selector branch: not a dispatcher shape",
    });
  }
  branches.sort((left, right) => left.viaBlock - right.viaBlock);
  const last = branches[branches.length - 1];
  let fallbackBlock: number | null = null;
  if (last !== undefined) {
    const tail = cfg.blocks[last.fallThrough];
    const tailHasBranch =
      tail !== undefined && tail.successors.some((edge) => edge.kind === "conditional");
    // The tail is the fallback only when it holds no branch itself and is
    // not a paired entry target: a single-branch dispatcher falls straight
    // through into its only body.
    const tailIsEntry = byTarget.has(last.fallThrough);
    if (!tailHasBranch && !tailIsEntry) {
      fallbackBlock = last.fallThrough;
    }
  }
  return ok(
    Object.freeze({
      branches: Object.freeze(branches),
      fallbackBlock,
    }),
  );
}
