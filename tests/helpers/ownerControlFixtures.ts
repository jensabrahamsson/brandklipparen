// Synthetic dispatcher fixtures for the S-115 owner-control detectors.
// Every builder here hand-assembles small synthetic dispatchers from opcode
// numbers: no real contract bytecode, no addresses, no external data. Each
// token holds one 11-byte dispatcher window per function (DUP1 PUSH4
// selector EQ PUSH2 destination JUMPI) followed by bodies that each open
// with JUMPDEST. Regions follow the reachability walk, so each body holds
// exactly the instructions its entry reaches.
import { Bytecode } from "../../src/domain/types.ts";
import type { Bytecode as BytecodeType } from "../../src/domain/types.ts";
import { disassemble } from "../../src/domain/selectors.ts";

function mustCode(bytes: readonly number[]): BytecodeType {
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const parsed = Bytecode.parse(`0x${hex}`);
  if (!parsed.ok) {
    throw new Error(`expected valid bytecode, got error: ${parsed.error.message}`);
  }
  return parsed.value;
}

function selectorBytes(selector: string): number[] {
  const body = selector.startsWith("0x") ? selector.slice(2) : selector;
  if (body.length !== 8) {
    throw new Error(`selector must carry four bytes: ${selector}`);
  }
  const out: number[] = [];
  for (let i = 0; i < 8; i += 2) {
    out.push(Number.parseInt(body.slice(i, i + 2), 16));
  }
  return out;
}

// One token from (selector, body) pairs. Bodies must stay short enough
// that every destination fits in a PUSH2.
export function tokenBytecode(parts: readonly { selector: string; body: readonly number[] }[]): BytecodeType {
  const headerLength = parts.length * 11;
  const bodies: number[][] = parts.map((part) => [0x5b, ...part.body]);
  const destinations: number[] = [];
  let pc = headerLength;
  for (const body of bodies) {
    destinations.push(pc);
    pc += body.length;
  }
  // Reachability needs honest jumps: a body that opens with the onlyOwner
  // guard shape jumps past its own revert to its own ok label, so the
  // placeholder destination resolves to the guard's JUMPDEST. A guard
  // anywhere else keeps its written destination.
  bodies.forEach((body, index) => {
    const start = destinations[index] ?? 0;
    if (
      body.length >= 15 &&
      body[1] === 0x33 &&
      body[2] === 0x60 &&
      body[4] === 0x54 &&
      body[5] === 0x14 &&
      body[6] === 0x61 &&
      body[9] === 0x57 &&
      body[14] === 0x5b
    ) {
      const dest = start + 14;
      body[7] = (dest >> 8) & 0xff;
      body[8] = dest & 0xff;
    }
  });
  // Internal branch placeholders (`branchOk()`) resolve to the first
  // JUMPDEST past the placeholder: the ok label past the revert run. The
  // sweep skips PUSH data, so a 0x5b data byte never resolves early. A
  // placeholder with no later JUMPDEST fails loudly instead of emitting
  // an unreachable body.
  bodies.forEach((body, index) => {
    const start = destinations[index] ?? 0;
    const swept = disassemble(mustCode(body));
    for (let at = 0; at < swept.length; at += 1) {
      const instruction = swept[at];
      const next = swept[at + 1];
      if (
        instruction === undefined ||
        next === undefined ||
        instruction.opcode !== 0x61 ||
        instruction.immediate.length !== 2 ||
        instruction.immediate[0] !== 0xff ||
        instruction.immediate[1] !== 0xff ||
        next.opcode !== 0x57
      ) {
        continue;
      }
      const ok = swept.slice(at + 2).find((candidate) => candidate.opcode === 0x5b);
      if (ok === undefined) {
        throw new Error("branchOk placeholder has no later JUMPDEST");
      }
      const dest = start + ok.pc;
      body[instruction.pc + 1] = (dest >> 8) & 0xff;
      body[instruction.pc + 2] = dest & 0xff;
    }
  });
  const out: number[] = [];
  parts.forEach((part, index) => {
    const destination = destinations[index] ?? 0;
    out.push(0x80, 0x63, ...selectorBytes(part.selector), 0x14);
    out.push(0x61, (destination >> 8) & 0xff, destination & 0xff, 0x57);
  });
  for (const body of bodies) {
    out.push(...body);
  }
  return mustCode(out);
}

// Standard onlyOwner guard over a constant slot: CALLER, PUSH1 slot,
// SLOAD, EQ, PUSH2 ok, JUMPI, then a revert fall-through and the ok label.
// Regions carrying this shape count as privileged. The destination is a
// placeholder unless the guard opens the body: `tokenBytecode` resolves a
// leading guard to its own ok label so the walk can enter the body.
export function ownerGuard(slot: number, okDestination: number): number[] {
  return [
    0x33, 0x60, slot & 0xff, 0x54, 0x14,
    0x61, (okDestination >> 8) & 0xff, okDestination & 0xff, 0x57,
    0x60, 0x00, 0x80, 0xfd, 0x5b,
  ];
}

// Internal conditional branch with a layout-resolved destination: emits
// PUSH2 0xFFFF plus JUMPI as a placeholder `tokenBytecode` resolves to
// the first JUMPDEST past it (the ok label past the revert run). Use it
// wherever a body branches past a revert fall-through; a raw out-of-range
// destination would leave the rest of the body unreachable to the walk.
export function branchOk(): number[] {
  return [0x61, 0xff, 0xff, 0x57];
}

// Opcode helpers for readable bodies.
export const PUSH0 = 0x5f;
export const CALLER = 0x33;
export const CALLDATALOAD = 0x35;
export const SLOAD = 0x54;
export const SSTORE = 0x55;
export const EQ = 0x14;
export const ISZERO = 0x15;
export const JUMPI = 0x57;
export const REVERT = 0xfd;
export const STOP = 0x00;
export const ADD = 0x01;
export const MUL = 0x02;
export const SUB = 0x03;
export const DIV = 0x04;
export const LT = 0x10;
export const GT = 0x11;
export const KECCAK = 0x20;
export const CALL = 0xf1;
export const STATICCALL = 0xfa;
export const DELEGATECALL = 0xf4;

export function push1(value: number): number[] {
  return [0x60, value & 0xff];
}

export function sstoreConstSlot(slot: number, valuePrefix: readonly number[]): number[] {
  return [...valuePrefix, ...push1(slot), SSTORE];
}
