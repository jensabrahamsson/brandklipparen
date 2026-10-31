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
import { Asm } from "./evmAsm.ts";

// Synthetic ERC-20-shaped selectors shared by the fixtures below. The
// transfer entries mirror the domain constants; the setter selectors are
// arbitrary synthetic values.
export const TRANSFER_SELECTOR = "0xa9059cbb";
export const TRANSFER_FROM_SELECTOR = "0x23b872dd";

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
export const MSTORE = 0x52;
export const EXP = 0x0a;
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
export const SHL = 0x1b;
export const SHR = 0x1c;
export const AND = 0x16;
export const OR = 0x17;
export const NOT = 0x19;
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

// Packed `owner|paused` slot-0 token (P-11 acceptance a): `pause()` sets
// bit 8 with a shifted OR and `unpause()` clears it with a shifted
// AND-NOT, while the transfer path reverts while the bit reads set. No
// SSTORE carries an adjacent value PUSH, so the v1 flag proof stays
// silent and only the v2 packed-bool read proves the writer. Synthetic
// selectors and hand-assembled bytecode only; no real contract code.
export const PACKED_PAUSE_SET = "0x0a9c6c1e";
export const PACKED_PAUSE_CLEAR = "0x0b9c6c1e";

function packedSetBody(): number[] {
  return [
    ...ownerGuard(0, 200),
    ...push1(0),
    SLOAD,
    ...push1(1),
    ...push1(8),
    SHL,
    OR,
    ...push1(0),
    SSTORE,
    STOP,
  ];
}

function packedClearBody(): number[] {
  return [
    ...ownerGuard(0, 200),
    ...push1(0),
    SLOAD,
    ...push1(1),
    ...push1(8),
    SHL,
    NOT,
    AND,
    ...push1(0),
    SSTORE,
    STOP,
  ];
}

function packedGatedTransferBody(): number[] {
  return [
    ...push1(0),
    SLOAD,
    ...push1(8),
    SHR,
    ...push1(0xff),
    AND,
    ISZERO,
    ...branchOk(),
    ...push1(0),
    0x80,
    REVERT,
    0x5b,
    ...sstoreConstSlot(2, [CALLDATALOAD]),
    STOP,
  ];
}

export function packedPauseToken(): BytecodeType {
  return tokenBytecode([
    { selector: PACKED_PAUSE_SET, body: packedSetBody() },
    { selector: PACKED_PAUSE_CLEAR, body: packedClearBody() },
    { selector: TRANSFER_SELECTOR, body: packedGatedTransferBody() },
  ]);
}

// Shared `_beforeTokenTransfer` blacklist token (P-11 acceptance b):
// `transfer` and `transferFrom` push their return address, jump into a
// shared helper that reverts while a mapping entry reads set, and return
// through a dynamic JUMP; a privileged setter writes the mapping. v1
// never follows the return jump, so the gate belongs to no region and the
// v1 proof stays silent; v2 attributes the shared body to both entries.
// A lone INVALID pads the structural fall-through of the dynamic jump.
// Both the writer and the gate hash their mapping through the explicit
// `keccak(key . baseSlot)` memory pattern (MSTORE key at 0x00, MSTORE
// base at 0x20, KECCAK256 over 0x00/0x40), so the extended proof can
// compare base slots. Synthetic selectors and hand-assembled bytecode
// only.
export const SHARED_BLACKLIST_SET = "0x0a9c6c1e";

// A table-named privileged list setter for the precision tests: it
// resolves through the selector table but is not a standard token
// entry, so it can prove a writer.
export const ADD_LIST_SET = "0x0ecb93c0";

export type SharedBaseGateConfig = {
  readonly writerSelector: string;
  readonly guarded: boolean;
  readonly writeBase: number;
  readonly gateBase: number;
};

export function sharedBaseGateTokenHex(config: SharedBaseGateConfig): string {
  const asm = new Asm();
  asm.op(0x80).push4(TRANSFER_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4(TRANSFER_FROM_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferFromEntry").op(0x57);
  asm.op(0x80).push4(config.writerSelector.slice(2)).op(0x14);
  asm.pushLabel2("setEntry").op(0x57);
  asm.label("fallback").op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("transferEntry").op(0x5b);
  asm.pushLabel2("ret1");
  asm.pushLabel2("shared");
  asm.op(0x56);
  asm.label("transferFromEntry").op(0x5b);
  asm.pushLabel2("ret2");
  asm.pushLabel2("shared");
  asm.op(0x56);
  // Mapping setter with an onlyOwner guard when configured.
  asm.label("setEntry").op(0x5b);
  if (config.guarded) {
    asm.op(0x33).push1(0x00).op(0x54, 0x14);
    asm.pushLabel2("setOk").op(0x57);
    asm.push1(0x00).op(0x80, 0xfd);
    asm.label("setOk").op(0x5b);
  }
  asm.op(0x35, 0x35).push1(0x00).op(0x52);
  asm.push1(config.writeBase).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x55);
  asm.op(0x00);
  // Shared transfer gate: revert while the mapping entry reads set.
  asm.label("shared").op(0x5b);
  asm.op(0x35).push1(0x00).op(0x52);
  asm.push1(config.gateBase).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x54, 0x15);
  asm.pushLabel2("sharedOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("sharedOk").op(0x5b);
  asm.op(0x56, 0xfe);
  asm.label("ret1").op(0x5b, 0x00);
  asm.label("ret2").op(0x5b, 0x00);
  return asm.build();
}

export function sharedBlacklistTokenHex(): string {
  return sharedBaseGateTokenHex({
    writerSelector: SHARED_BLACKLIST_SET,
    guarded: true,
    writeBase: 3,
    gateBase: 3,
  });
}

// Unguarded mapping write to an explicit base slot (linear body): the
// key comes from calldata, the base is a constant, and the value below
// the hash on the stack is stored. No caller check, so the writer never
// proves privilege.
function unguardedMappingWriteBody(base: number): number[] {
  return [
    CALLDATALOAD,
    CALLDATALOAD,
    ...push1(0),
    MSTORE,
    ...push1(base),
    ...push1(0x20),
    MSTORE,
    ...push1(0x40),
    ...push1(0x00),
    KECCAK,
    SSTORE,
    STOP,
  ];
}

// Unprivileged balance write plus a gate on another mapping (precision
// test a): `transfer` writes its balance mapping while gating on a
// foreign mapping no privileged writer touches, beside an owner setter
// that proves the owner slot elsewhere.
export function unprivilegedForeignGateToken(): BytecodeType {
  return tokenBytecode([
    { selector: "0x11111111", body: unguardedMappingWriteBody(5) },
    {
      selector: "0x22222222",
      body: [...ownerGuard(0, 200), ...sstoreConstSlot(0, [CALLDATALOAD]), STOP],
    },
    {
      selector: TRANSFER_SELECTOR,
      body: [
        ...unguardedMappingWriteBody(2).slice(0, -1),
        CALLDATALOAD,
        ...push1(0),
        MSTORE,
        ...push1(5),
        ...push1(0x20),
        MSTORE,
        ...push1(0x40),
        ...push1(0x00),
        KECCAK,
        SLOAD,
        ISZERO,
        ...branchOk(),
        ...push1(0),
        0x80,
        REVERT,
        0x5b,
        STOP,
      ],
    },
  ]);
}

// Old-solc EXP-shift packed pause (precision test e): `pause()` sets
// the bit with `PUSH 0x02 PUSH k EXP` (2**k) while `unpause()` clears
// it, and the transfer path reads the same slot and bit back through
// DIV by the same shift, AND with 0xff and a reverting gate. Synthetic
// selectors and hand-assembled bytecode only.
export const EXP_PAUSE_SET = "0x8456cb59";
export const EXP_PAUSE_CLEAR = "0x3f4ba83a";

function expSetBody(bit: number): number[] {
  return [
    ...ownerGuard(0, 200),
    ...push1(0),
    SLOAD,
    ...push1(1),
    ...push1(2),
    ...push1(bit),
    EXP,
    MUL,
    OR,
    ...push1(0),
    SSTORE,
    STOP,
  ];
}

function expClearBody(bit: number): number[] {
  return [
    ...ownerGuard(0, 200),
    ...push1(0),
    SLOAD,
    ...push1(2),
    ...push1(bit),
    EXP,
    NOT,
    AND,
    ...push1(0),
    SSTORE,
    STOP,
  ];
}

function expGatedTransferBody(bit: number): number[] {
  return [
    ...push1(2),
    ...push1(bit),
    EXP,
    ...push1(0),
    SLOAD,
    DIV,
    ...push1(0xff),
    AND,
    ISZERO,
    ...branchOk(),
    ...push1(0),
    0x80,
    REVERT,
    0x5b,
    ...sstoreConstSlot(2, [CALLDATALOAD]),
    STOP,
  ];
}

export function expPackedPauseToken(bit = 8): BytecodeType {
  return tokenBytecode([
    { selector: EXP_PAUSE_SET, body: expSetBody(bit) },
    { selector: EXP_PAUSE_CLEAR, body: expClearBody(bit) },
    { selector: TRANSFER_SELECTOR, body: expGatedTransferBody(bit) },
  ]);
}
