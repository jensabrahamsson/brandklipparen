// C-13 (F-12): the reverting-side proof is linear. A diamond ladder with
// 2^L reverting paths must prove in under 50 ms, and the memoised height
// must agree with the old exponential DFS on random small CFGs.
// Synthetic hand-assembled fixtures only; no network, no real addresses.
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { Bytecode } from "../../src/domain/types.ts";
import type { Bytecode as BytecodeType } from "../../src/domain/types.ts";
import type { Result } from "../../src/domain/result.ts";
import {
  DYNAMIC_RETURN_MAX_TARGETS,
  REVERTING_SIDE_MAX_BLOCKS,
  hasRevertingSide,
} from "../../src/domain/ownerControl.ts";
import { buildCfg, lift } from "../../src/domain/evmLift.ts";
import type { ControlFlowGraph } from "../../src/domain/evmLift.ts";
import { disassemble } from "../../src/domain/selectors.ts";
import { Asm } from "../helpers/evmAsm.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function mustBytecode(hex: string): BytecodeType {
  return mustOk(Bytecode.parse(hex));
}

// Frozen reference: the pre-C-13 exponential DFS, pasted here so the
// property test can prove the memoised height equal. Includes the copy
// of the dynamic-return resolution it called.
const REFERENCE_STATE_OPS: ReadonlySet<number> = new Set([0x55, 0xf1, 0xf2, 0xf4, 0xfa]);
const REFERENCE_HALT_OPS: ReadonlySet<number> = new Set([0xfd, 0xfe]);

function referenceDynamicReturnTargets(
  cfg: ControlFlowGraph,
  dynamicBlock: number,
): readonly number[] {
  const blocks = cfg.blocks;
  const jumpDestByPc = new Map<number, number>();
  for (const block of blocks) {
    if (block.instructions[0]?.opcode === 0x5b) {
      jumpDestByPc.set(block.range.startPc, block.index);
    }
  }
  const predecessors = new Map<number, number[]>();
  for (const block of blocks) {
    for (const edge of block.successors) {
      const targets = edge.kind === "conditional" ? [edge.to, edge.fallThrough] : [edge.to];
      for (const to of targets) {
        const list = predecessors.get(to) ?? [];
        list.push(block.index);
        predecessors.set(to, list);
      }
    }
  }
  const isEntry = (index: number): boolean => {
    const block = blocks[index];
    if (block === undefined || block.instructions[0]?.opcode !== 0x5b) {
      return false;
    }
    return blocks.some((caller) =>
      caller.successors.some((edge) => edge.kind === "jump" && edge.to === index),
    );
  };
  const entries: number[] = [];
  const seen = new Set<number>([dynamicBlock]);
  const queue = [dynamicBlock];
  while (queue.length > 0) {
    const current = queue.shift() ?? -1;
    if (isEntry(current)) {
      entries.push(current);
      continue;
    }
    for (const pred of predecessors.get(current) ?? []) {
      if (!seen.has(pred)) {
        seen.add(pred);
        queue.push(pred);
      }
    }
  }
  const targetsOf = (entry: number): Set<number> => {
    const targets = new Set<number>();
    for (const caller of blocks) {
      const jumpsHere = caller.successors.some(
        (edge) => edge.kind === "jump" && edge.to === entry,
      );
      if (!jumpsHere) {
        continue;
      }
      for (const instruction of caller.instructions) {
        if (instruction.opcode < 0x60 || instruction.opcode > 0x7f) {
          continue;
        }
        let value = 0;
        for (const byte of instruction.immediate) {
          value = value * 256 + byte;
        }
        const target = jumpDestByPc.get(value);
        if (target !== undefined && target !== entry) {
          targets.add(target);
        }
      }
    }
    return targets;
  };
  for (const entry of entries) {
    const targets = targetsOf(entry);
    if (targets.size > 0 && targets.size <= DYNAMIC_RETURN_MAX_TARGETS) {
      return Object.freeze([...targets].sort((left, right) => left - right));
    }
  }
  return Object.freeze([]);
}

function referenceHasRevertingSide(
  bytecode: BytecodeType,
  jumpiPc: number,
  side: "jump" | "fall",
): boolean {
  const cfg = buildCfg(lift(bytecode));
  let jumpBlock = -1;
  for (const block of cfg.blocks) {
    if (block.instructions.some((instruction) => instruction.pc === jumpiPc && instruction.opcode === 0x57)) {
      jumpBlock = block.index;
      break;
    }
  }
  if (jumpBlock < 0 || jumpBlock >= cfg.blocks.length) {
    return false;
  }
  const jump = cfg.blocks[jumpBlock];
  const edge = jump?.successors.find((candidate) => candidate.kind === "conditional");
  if (edge === undefined || edge.kind !== "conditional") {
    return false;
  }
  const start = side === "jump" ? edge.to : edge.fallThrough;
  const visit = (index: number, depth: number, path: ReadonlySet<number>): boolean => {
    if (depth > REVERTING_SIDE_MAX_BLOCKS || path.has(index)) {
      return false;
    }
    const current = cfg.blocks[index];
    if (current === undefined) {
      return false;
    }
    for (const instruction of current.instructions) {
      if (REFERENCE_STATE_OPS.has(instruction.opcode)) {
        return false;
      }
      if (REFERENCE_HALT_OPS.has(instruction.opcode)) {
        return true;
      }
    }
    const next = new Set(path);
    next.add(index);
    if (current.terminal === "jump") {
      const target = current.successors.find((candidate) => candidate.kind === "jump");
      if (target !== undefined) {
        return visit(target.to, depth + 1, next);
      }
      const returns = referenceDynamicReturnTargets(cfg, index);
      if (returns.length === 0) {
        return false;
      }
      return returns.every((to) => visit(to, depth + 1, next));
    }
    if (current.terminal === "jumpi") {
      const conditional = current.successors.find((candidate) => candidate.kind === "conditional");
      if (conditional === undefined || conditional.kind !== "conditional") {
        return false;
      }
      return visit(conditional.to, depth + 1, next) && visit(conditional.fallThrough, depth + 1, next);
    }
    if (current.terminal === "fall") {
      const through = current.successors.find((candidate) => candidate.kind === "fall-through");
      if (through === undefined) {
        return false;
      }
      return visit(through.to, depth + 1, next);
    }
    return false;
  };
  try {
    return visit(start, 1, new Set<number>());
  } catch {
    return false;
  }
}

// A diamond ladder with L levels: P(d) jumps to Q(d+1) and falls through
// to P(d+1); Q(d) jumps to P(d+1) and falls through to Q(d+1); PL and QL
// revert. Every path from P0 has L+1 blocks and there are 2^L paths.
function buildDiamondLadder(levels: number): { bytecode: BytecodeType; entryJumpiPc: number } {
  const asm = new Asm();
  const pName = (level: number): string => `P${level}`;
  const qName = (level: number): string => `Q${level}`;
  asm.push1(0).op(0x35).pushLabel2(pName(0));
  const entryJumpiPc = asm.pc;
  asm.op(0x57, 0x00);
  for (let level = 0; level < levels; level += 1) {
    asm.label(pName(level)).op(0x5b).push1(0).op(0x35).pushLabel2(qName(level + 1)).op(0x57);
  }
  asm.label(pName(levels)).op(0x5b).push1(0).op(0x80, 0xfd);
  for (let level = 0; level < levels; level += 1) {
    asm.label(qName(level)).op(0x5b).push1(0).op(0x35).pushLabel2(pName(level + 1)).op(0x57);
  }
  asm.label(qName(levels)).op(0x5b).push1(0).op(0x80, 0xfd);
  return { bytecode: mustBytecode(asm.build()), entryJumpiPc };
}

function proveJumpSide(bytecode: BytecodeType, entryJumpiPc: number): boolean {
  return hasRevertingSide(bytecode, disassemble(bytecode), () => true, entryJumpiPc, "jump");
}

describe("c13 linear reverting-side proof", () => {
  test("c13_diamond_ladder_under_50ms", () => {
    const ladder = buildDiamondLadder(22);
    const started = performance.now();
    const proven = proveJumpSide(ladder.bytecode, ladder.entryJumpiPc);
    const elapsed = performance.now() - started;
    expect(proven).toBe(true);
    expect(elapsed).toBeLessThan(50);

    // L=30 needs 31 blocks on the longest path, past the cap of 24.
    const capped = buildDiamondLadder(30);
    const cappedStart = performance.now();
    const cappedProven = proveJumpSide(capped.bytecode, capped.entryJumpiPc);
    const cappedElapsed = performance.now() - cappedStart;
    expect(cappedProven).toBe(false);
    expect(cappedElapsed).toBeLessThan(50);

    // The old exponential DFS agrees on a small ladder (2^10 paths). It
    // takes seconds at L=22, so only the small case runs it here.
    const small = buildDiamondLadder(10);
    expect(referenceHasRevertingSide(small.bytecode, small.entryJumpiPc, "jump")).toBe(true);
    expect(proveJumpSide(small.bytecode, small.entryJumpiPc)).toBe(true);
  });

  test("c13_matches_reference_on_random_cfgs", () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 2, max: 12 })
          .chain((count) =>
            fc.record({
              count: fc.constant(count),
              jumps: fc.array(fc.integer({ min: 0, max: count - 1 }), {
                minLength: count - 1,
                maxLength: count - 1,
              }),
              leaf: fc.integer({ min: 0, max: 3 }),
              back: fc.integer({ min: 0, max: count - 1 }),
            }),
          ),
        (program) => {
          const asm = new Asm();
          const name = (index: number): string => `B${index}`;
          for (let index = 0; index < program.count - 1; index += 1) {
            const target = program.jumps[index] ?? 0;
            asm.label(name(index)).op(0x5b).push1(0).op(0x35).pushLabel2(name(target)).op(0x57);
          }
          const last = program.count - 1;
          if (program.leaf === 0) {
            asm.label(name(last)).op(0x5b).push1(0).op(0x80, 0xfd);
          } else if (program.leaf === 1) {
            asm.label(name(last)).op(0x5b, 0x00);
          } else if (program.leaf === 2) {
            asm.label(name(last)).op(0x5b).push1(0).push1(0).op(0x55).push1(0).op(0x80, 0xfd);
          } else {
            asm.label(name(last)).op(0x5b).pushLabel2(name(program.back)).op(0x56);
          }
          const bytecode = mustBytecode(asm.build());
          const insns = disassemble(bytecode);
          // The JUMPI of block 0 ends its fixed 8-byte shape.
          const jumpiPc = 7;
          for (const side of ["jump", "fall"] as const) {
            const actual = hasRevertingSide(bytecode, insns, () => true, jumpiPc, side);
            expect(referenceHasRevertingSide(bytecode, jumpiPc, side)).toBe(actual);
          }
        },
      ),
    );
  });
});
