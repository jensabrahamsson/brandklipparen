// Symbolic dataflow over the lifted CFG: function entries and
// dispatcher topology (S-079, K-037, K-521, D-03). Pure deterministic
// functions over `ControlFlowGraph` and the landed `extractSelectors`:
// entries pair dispatcher selectors with their proven entry blocks,
// and the topology maps every taken branch back to its selector. A CFG
// with no conditional edge is not a dispatcher shape and reports the
// `unexpected-dispatcher-shape` cause instead of an empty topology.
// Per-opcode stack effects live in the shared Cancun table in
// `./opcodes.ts`.
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
