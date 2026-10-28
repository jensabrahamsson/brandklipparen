// EVM lifter and CFG builder, stages 1-2 of the own decompiler
// (S-078, K-037, K-521, D-02, D-03, M-43). Pure deterministic functions
// over the landed linear sweep `disassemble`: PUSH data is already
// skipped, the CBOR footer is already cut, and a truncated trailing PUSH
// already ends the sweep without throwing. Stage 1 partitions the
// instruction stream into basic blocks; stage 2 links proven edges and
// records every other dynamic target as exactly one unresolved jump,
// never a guess. All outputs are frozen values: equal bytecode gives
// bit-identical output (K-102).
import { disassemble } from "./selectors.ts";
import type { Bytecode as BytecodeType } from "./types.ts";

// Byte range `[startPc, endPc)` counting bytes in the original runtime
// bytecode through the same footer rule as the sweep (D-06, M-45).
export type ByteRange = {
  readonly startPc: number;
  readonly endPc: number;
};

export type LiftedInstruction = {
  readonly pc: number;
  readonly opcode: number;
  readonly name: string;
  readonly immediate: readonly number[];
};

// Block terminal class from its last instruction: `jump` (JUMP),
// `jumpi` (JUMPI), `halt` (STOP, RETURN, REVERT, INVALID,
// SELFDESTRUCT), `fall` (falls through to the next block), or `end`
// (the final block without a halting opcode).
export type BlockTerminal = "jump" | "jumpi" | "halt" | "fall" | "end";

export type LiftedBlock = {
  readonly index: number;
  readonly range: ByteRange;
  readonly instructions: readonly LiftedInstruction[];
  readonly terminal: BlockTerminal;
};

export type LiftOutput = {
  readonly blocks: readonly LiftedBlock[];
  readonly instructionCount: number;
  readonly codeLength: number;
};

// CFG edge per ADR D-02: proven targets only. `conditional` carries the
// taken PC and the fall-through block index.
export type BlockEdge =
  | { kind: "fall-through"; to: number }
  | { kind: "jump"; to: number }
  | { kind: "conditional"; to: number; fallThrough: number };

// One unresolved dynamic jump (D-03, M-43): the jump at `atPc` reads its
// target from the stack with no proven constant, so the edge is recorded
// exactly once and carried into structuring as a labelled region.
export type UnresolvedJump = {
  readonly atPc: number;
  readonly range: ByteRange;
};

// Typed diagnoses, never throws (D-12): a proven-constant target off a
// `JUMPDEST` is `invalid-jumpdest`, a target past the code end is
// `block-overrun`, and a trailing block without a halting opcode is
// `unterminated-block`.
export type CfgDiagnosis =
  | { kind: "invalid-jumpdest"; atPc: number; target: number }
  | { kind: "block-overrun"; atPc: number; target: number }
  | { kind: "unterminated-block"; block: number };

export type CfgBlock = {
  readonly index: number;
  readonly range: ByteRange;
  readonly instructions: readonly LiftedInstruction[];
  readonly terminal: BlockTerminal;
  readonly successors: readonly BlockEdge[];
};

export type ControlFlowGraph = {
  readonly blocks: readonly CfgBlock[];
  readonly entryBlock: number;
  readonly unresolvedJumps: readonly UnresolvedJump[];
  readonly diagnoses: readonly CfgDiagnosis[];
};

const HALTING_OPCODES: ReadonlySet<number> = new Set([0x00, 0xf3, 0xfd, 0xfe, 0xff]);

function freezeInstruction(pc: number, opcode: number, name: string, immediate: Uint8Array): LiftedInstruction {
  return Object.freeze({
    pc,
    opcode,
    name,
    immediate: Object.freeze(Array.from(immediate)),
  });
}

// Stage 1: partition the swept stream into basic blocks. Leaders are the
// entry PC, every `JUMPDEST`, and every instruction following `JUMP`,
// `JUMPI` or a halting opcode; every swept instruction belongs to exactly
// one block. Byte values 0x5c-0x5e decode through the landed Cancun table
// as TLOAD, TSTORE and MCOPY (never as EOF jumps, which this codebase
// does not implement): they carry no control edge here.
export function lift(bytecode: BytecodeType): LiftOutput {
  const swept = disassemble(bytecode);
  const instructions = swept.map((entry) => freezeInstruction(entry.pc, entry.opcode, entry.name, entry.immediate));
  const leaders = new Set<number>();
  if (instructions.length > 0) {
    leaders.add(instructions[0]?.pc ?? 0);
  }
  for (let index = 0; index < instructions.length; index += 1) {
    const entry = instructions[index];
    if (entry === undefined) {
      continue;
    }
    if (entry.opcode === 0x5b) {
      leaders.add(entry.pc);
    }
    if (entry.opcode === 0x56 || entry.opcode === 0x57 || HALTING_OPCODES.has(entry.opcode)) {
      const next = instructions[index + 1];
      if (next !== undefined) {
        leaders.add(next.pc);
      }
    }
  }
  const blocks: LiftedBlock[] = [];
  let current: LiftedInstruction[] = [];
  let currentIndex = 0;
  const pushBlock = (): void => {
    if (current.length === 0) {
      return;
    }
    const first = current[0];
    const last = current[current.length - 1];
    if (first === undefined || last === undefined) {
      current = [];
      return;
    }
    const endPc = last.pc + 1 + last.immediate.length;
    let terminal: BlockTerminal = "fall";
    if (last.opcode === 0x56) {
      terminal = "jump";
    } else if (last.opcode === 0x57) {
      terminal = "jumpi";
    } else if (HALTING_OPCODES.has(last.opcode)) {
      terminal = "halt";
    }
    blocks.push(
      Object.freeze({
        index: currentIndex,
        range: Object.freeze({ startPc: first.pc, endPc }),
        instructions: Object.freeze(current),
        terminal,
      }),
    );
    currentIndex += 1;
    current = [];
  };
  for (const entry of instructions) {
    if (current.length > 0 && leaders.has(entry.pc)) {
      pushBlock();
    }
    current.push(entry);
  }
  pushBlock();
  const frozen = blocks.map((block, position) => {
    if (position === blocks.length - 1 && block.terminal === "fall") {
      return Object.freeze({ ...block, terminal: "end" as BlockTerminal });
    }
    return block;
  });
  return Object.freeze({
    blocks: Object.freeze(frozen),
    instructionCount: instructions.length,
    codeLength: bytecode.length,
  });
}

function blockIndexByPc(blocks: readonly LiftedBlock[], pc: number): number {
  for (const block of blocks) {
    if (block.range.startPc === pc) {
      return block.index;
    }
  }
  return -1;
}

function isJumpdest(blocks: readonly LiftedBlock[], pc: number): boolean {
  for (const block of blocks) {
    for (const entry of block.instructions) {
      if (entry.pc === pc) {
        return entry.opcode === 0x5b;
      }
    }
  }
  return false;
}

// Proven-constant target directly under the jump: the previous
// instruction in the block is `PUSHn`. The value returns uncapped (up
// to 32 bits, enough to compare against any code length); anything else
// (DUP/SWAP tops, arithmetic, memory loads) is unproven at this stage
// and records one unresolved jump (D-03).
function constantTargetBefore(block: LiftedBlock): number | null {
  const instructions = block.instructions;
  if (instructions.length < 2) {
    return null;
  }
  const push = instructions[instructions.length - 2];
  if (push === undefined || push.opcode < 0x60 || push.opcode > 0x7f) {
    return null;
  }
  let value = 0;
  for (const byte of push.immediate) {
    value = value * 256 + byte;
    if (value > 0xffffffff) {
      value = 0xffffffff;
      break;
    }
  }
  return value;
}

// Stage 2: link proven edges, validate every constant target, and record
// the rest exactly once. A constant target past the code end is
// `block-overrun`; a constant target off a `JUMPDEST` is
// `invalid-jumpdest` (an edge is never built for it); a non-constant
// target is one unresolved jump. A trailing block without a halting
// opcode is `unterminated-block`.
export function buildCfg(lifted: LiftOutput): ControlFlowGraph {
  const unresolved: UnresolvedJump[] = [];
  const diagnoses: CfgDiagnosis[] = [];
  const blocks: CfgBlock[] = lifted.blocks.map((block) => {
    const successors: BlockEdge[] = [];
    const last = block.instructions[block.instructions.length - 1];
    if (last === undefined) {
      return Object.freeze({ ...block, successors: Object.freeze(successors) });
    }
    if (last.opcode === 0x56 || last.opcode === 0x57) {
      const target = constantTargetBefore(block);
      const isLastBlock = block.index === lifted.blocks.length - 1;
      const nextBlock = isLastBlock ? -1 : block.index + 1;
      const recordUnresolved = (): void => {
        unresolved.push(
          Object.freeze({ atPc: last.pc, range: Object.freeze({ startPc: last.pc, endPc: last.pc + 1 }) }),
        );
      };
      const to = target === null ? -1 : blockIndexByPc(lifted.blocks, target);
      const proven = target !== null && target < lifted.codeLength && isJumpdest(lifted.blocks, target) && to !== -1;
      if (target !== null && target >= lifted.codeLength) {
        diagnoses.push(Object.freeze({ kind: "block-overrun", atPc: last.pc, target }));
        recordUnresolved();
      } else if (target !== null && !proven) {
        diagnoses.push(Object.freeze({ kind: "invalid-jumpdest", atPc: last.pc, target }));
        recordUnresolved();
      } else if (!proven) {
        recordUnresolved();
      }
      if (last.opcode === 0x56) {
        if (proven) {
          successors.push(Object.freeze({ kind: "jump", to }));
        }
      } else if (proven && nextBlock !== -1) {
        successors.push(Object.freeze({ kind: "conditional", to, fallThrough: nextBlock }));
      } else if (proven) {
        successors.push(Object.freeze({ kind: "jump", to }));
      } else if (nextBlock !== -1) {
        successors.push(Object.freeze({ kind: "fall-through", to: nextBlock }));
      }
    } else if (block.terminal === "fall") {
      const nextBlock = block.index + 1;
      if (nextBlock < lifted.blocks.length) {
        successors.push(Object.freeze({ kind: "fall-through", to: nextBlock }));
      }
    }
    if (block.terminal === "end") {
      diagnoses.push(Object.freeze({ kind: "unterminated-block", block: block.index }));
    }
    return Object.freeze({ ...block, successors: Object.freeze(successors) });
  });
  return Object.freeze({
    blocks: Object.freeze(blocks),
    entryBlock: 0,
    unresolvedJumps: Object.freeze(unresolved),
    diagnoses: Object.freeze(diagnoses),
  });
}
