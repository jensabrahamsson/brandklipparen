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
// the bit with `PUSH k PUSH 0x02 EXP` (2**k, exponent first as solc
// emits it) while `unpause()` clears it, and the transfer path reads
// the same slot and bit back through DIV by the same shift, AND with
// 0xff and a reverting gate. Synthetic selectors and hand-assembled
// bytecode only.
export const EXP_PAUSE_SET = "0x8456cb59";
export const EXP_PAUSE_CLEAR = "0x3f4ba83a";

function expSetBody(bit: number): number[] {
  return [
    ...ownerGuard(0, 200),
    ...push1(0),
    SLOAD,
    ...push1(1),
    ...push1(bit),
    ...push1(2),
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
    ...push1(bit),
    ...push1(2),
    EXP,
    NOT,
    AND,
    ...push1(0),
    SSTORE,
    STOP,
  ];
}

export function expGatedTransferBody(bit: number): number[] {
  return [
    ...push1(bit),
    ...push1(2),
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

// Masked old-solc packed pause (P-11 follow-up): the write value is a
// computed word, never a constant. `pause()` sets the bit with
// `OR(AND(SLOAD, NOT(mask)), 1 << k)` and `unpause()` clears it with
// `AND(OR(SLOAD, mask), NOT(1 << k))`, both shift-built with
// `PUSH k PUSH 0x02 EXP` (2**k, exponent first as solc emits it); the
// transfer path reads the same slot and bit back through DIV by the
// same shift, AND with 0xff and a reverting gate. The v1 proof stays
// silent (no plain flag value sits
// beside the stores) and the unmasked packed proof stays silent too (the
// masking hides both shapes), while the extended masked proof pairs the
// set/unset writers with the gate, so the mode is pause. Synthetic
// selectors and hand-assembled bytecode only.
export const MASKED_PAUSE_SET = "0x1a2b3c4d";
export const MASKED_PAUSE_CLEAR = "0x5e6f7a8b";

export function maskedPauseSetBody(bit: number): number[] {
  return [
    ...ownerGuard(0, 200),
    ...push1(0),
    SLOAD,
    0x63,
    0xff,
    0xff,
    0xff,
    0x00,
    NOT,
    AND,
    ...push1(1),
    ...push1(bit),
    ...push1(2),
    EXP,
    MUL,
    OR,
    ...push1(0),
    SSTORE,
    STOP,
  ];
}

export function maskedPauseClearBody(bit: number): number[] {
  return [
    ...ownerGuard(0, 200),
    ...push1(0),
    SLOAD,
    ...push1(0x01),
    OR,
    ...push1(bit),
    ...push1(2),
    EXP,
    NOT,
    AND,
    ...push1(0),
    SSTORE,
    STOP,
  ];
}

export function maskedPackedPauseToken(bit = 8): BytecodeType {
  return tokenBytecode([
    { selector: MASKED_PAUSE_SET, body: maskedPauseSetBody(bit) },
    { selector: MASKED_PAUSE_CLEAR, body: maskedPauseClearBody(bit) },
    { selector: TRANSFER_SELECTOR, body: expGatedTransferBody(bit) },
  ]);
}

// Packed bool-in-mapping blacklist (P-11 follow-up): the onlyOwner setter
// writes a mapping entry with the packed read-modify-write
// `SSTORE(keccak, OR(AND(SLOAD(keccak), NOT(0xff)), value))`, the bool
// value coming from calldata with the hash kept for the store, and the
// transfer path reverts while packed fields of the same entry read set.
// A two-field gate (a plain-masked field plus an EXP-shifted field
// combined with OR) spans more than the beside window, so the scored and
// beside-window proofs stay silent while the extended packed-gate proof
// pairs the writer with the gate. `writeBase` and `gateBase` hash the
// same entry only when equal. Synthetic selectors and hand-assembled
// bytecode only.
export const PACKED_MAPPING_SET = "0x3c4d5e6f";

function packedMappingWriteBody(base: number): number[] {
  return [
    ...ownerGuard(0, 200),
    CALLDATALOAD,
    ...push1(0),
    MSTORE,
    ...push1(base),
    ...push1(0x20),
    MSTORE,
    ...push1(0x40),
    ...push1(0x00),
    KECCAK,
    0x80,
    SLOAD,
    ...push1(0xff),
    NOT,
    AND,
    CALLDATALOAD,
    OR,
    0x90,
    SSTORE,
    STOP,
  ];
}

function packedMappingGateBody(base: number): number[] {
  return [
    CALLDATALOAD,
    ...push1(0),
    MSTORE,
    ...push1(base),
    ...push1(0x20),
    MSTORE,
    ...push1(0x40),
    ...push1(0x00),
    KECCAK,
    SLOAD,
    ...push1(0xff),
    AND,
    ...push1(0x01),
    AND,
    ...push1(8),
    ...push1(2),
    EXP,
    DIV,
    ...push1(0xff),
    AND,
    ...push1(0x01),
    AND,
    OR,
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

export function packedMappingBlacklistToken(writeBase = 5, gateBase = 5): BytecodeType {
  return tokenBytecode([
    { selector: PACKED_MAPPING_SET, body: packedMappingWriteBody(writeBase) },
    { selector: TRANSFER_SELECTOR, body: packedMappingGateBody(gateBase) },
  ]);
}

// Old-solc 0.4.x packed bool write (P-10d): the exact instruction sequence
// from real bytecode, hand-assembled with synthetic selectors only:
// PUSH1 1; PUSH1 0; PUSH1 20; PUSH2 0x0100; EXP; DUP2; SLOAD; DUP2;
// PUSH1 0xff; MUL; NOT; AND; SWAP1; DUP4; ISZERO; ISZERO; MUL; OR; SWAP1;
// SSTORE — i.e. SSTORE(0, OR(AND(SLOAD(0), NOT(0xff*256**20)),
// ISZERO(ISZERO(1))*256**20)). The shift 256**20 is built with base
// 0x0100, which the legacy window matcher never names; the expression
// interpreter folds EXP in EVM order and proves bit 160.
export const OLD_SOLC_PAUSE_SET = "0x0a0b0c0d";

const DUP2 = 0x81;
const DUP4 = 0x83;
const SWAP1 = 0x90;

export function oldSolcWriteSeq(): number[] {
  return [
    0x60, 0x01, 0x60, 0x00, 0x60, 0x14, 0x61, 0x01, 0x00, EXP,
    DUP2, SLOAD, DUP2, 0x60, 0xff, MUL, NOT, AND, SWAP1, DUP4,
    ISZERO, ISZERO, MUL, OR, SWAP1, SSTORE,
  ];
}

function oldSolcPauseBody(): number[] {
  return [...ownerGuard(0, 200), ...oldSolcWriteSeq(), STOP];
}

function oldSolcGatedTransferBody(): number[] {
  return [
    ...push1(0),
    SLOAD,
    ...push1(0x14),
    0x61, 0x01, 0x00,
    EXP,
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

export function oldSolcPauseToken(): BytecodeType {
  return tokenBytecode([
    { selector: OLD_SOLC_PAUSE_SET, body: oldSolcPauseBody() },
    { selector: TRANSFER_SELECTOR, body: oldSolcGatedTransferBody() },
  ]);
}

export function oldSolcPauseUnguardedToken(): BytecodeType {
  return tokenBytecode([
    { selector: OLD_SOLC_PAUSE_SET, body: [...oldSolcWriteSeq(), STOP] },
    { selector: TRANSFER_SELECTOR, body: oldSolcGatedTransferBody() },
  ]);
}

export const OZ4_BLACKLIST_SET = "0x12345678";

export function oz4BlacklistTokenHex(writeBase = 5, gateBase = 5, guarded = true): string {
  const asm = new Asm();
  asm.op(0x80).push4(TRANSFER_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4(OZ4_BLACKLIST_SET.slice(2)).op(0x14);
  asm.pushLabel2("setEntry").op(0x57);
  asm.label("fallback").op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("transferEntry").op(0x5b);
  asm.op(0x35).push1(0x00).op(0x52);
  asm.push1(gateBase).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x54, 0x15);
  asm.pushLabel2("tok").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("tok").op(0x5b);
  asm.op(0x35, 0x35).push1(0x02).op(0x55, 0x00);
  asm.label("setEntry").op(0x5b);
  if (guarded) {
    asm.pushLabel2("retOwner").pushLabel2("funcOwner").op(0x56);
    asm.label("retOwner").op(0x5b);
    asm.pushLabel2("retSender").pushLabel2("funcSender").op(0x56);
    asm.label("retSender").op(0x5b);
    asm.op(0x14);
    asm.pushLabel2("ok").op(0x57);
    asm.push1(0x00).op(0x80, 0xfd);
    asm.label("ok").op(0x5b);
  }
  asm.op(0x35, 0x35).push1(0x00).op(0x52);
  asm.push1(writeBase).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x55, 0x00);
  if (guarded) {
    asm.label("funcOwner").op(0x5b);
    asm.push1(0x00).op(0x54, 0x90, 0x56);
    asm.label("funcSender").op(0x5b);
    asm.op(0x33, 0x90, 0x56);
  }
  asm.label("end").op(0x5b, 0xfe);
  return asm.build();
}

// OZ-4-shaped token on a modern compiler layout (P-10f): every writer
// calls a shared `_checkOwner` internal function, which itself calls
// `owner()` and `_msgSender()` internal functions and, on mismatch,
// builds its revert through a shared encoding helper that returns with
// a dynamic JUMP to a REVERT block. The blacklist gate in the transfer
// path is split over two conditional jumps (a duplicated ISZERO
// condition, with the revert under the second jump), and the limit
// compare sits in the continuation block after an internal helper call,
// far past the scored beside window from its slot load. Hand-assembled
// with synthetic selectors only; no real contract code.
export const OZ4_REVERT_SET = "0x22334455";
export const OZ4_REVERT_LIMIT_SET = "0x33445566";
export const OZ4_REVERT_OWN_SET = "0x44556677";

export function oz4RevertHelperTokenHex(writeBase = 4, gateBase = 4, guarded = true): string {
  const asm = new Asm();
  asm.op(0x80).push4(TRANSFER_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4(OZ4_REVERT_SET.slice(2)).op(0x14);
  asm.pushLabel2("setEntry").op(0x57);
  asm.op(0x80).push4(OZ4_REVERT_LIMIT_SET.slice(2)).op(0x14);
  asm.pushLabel2("limitEntry").op(0x57);
  asm.op(0x80).push4(OZ4_REVERT_OWN_SET.slice(2)).op(0x14);
  asm.pushLabel2("ownEntry").op(0x57);
  asm.label("fallback").op(0x5b).push1(0x00).op(0x80, 0xfd);
  // Transfer: split blacklist gate, then the helper-interleaved limit.
  asm.label("transferEntry").op(0x5b);
  asm.op(0x35).push1(0x00).op(0x52);
  asm.push1(gateBase).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x54);
  asm.push1(0xff).op(0x16, 0x15, 0x80, 0x15);
  asm.pushLabel2("gateSecond").op(0x57);
  asm.op(0x50);
  asm.pushLabel2("gateOk").op(0x56);
  asm.label("gateSecond").op(0x5b);
  asm.pushLabel2("gateOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("gateOk").op(0x5b);
  asm.push1(0x07).op(0x54);
  asm.push1(0x24).op(0x35);
  for (let pad = 0; pad < 4; pad += 1) {
    asm.push1(0x00).op(0x50);
  }
  asm.pushLabel2("retGt").pushLabel2("funcAdd").op(0x56);
  asm.label("retGt").op(0x5b);
  asm.op(0x11, 0x15);
  asm.pushLabel2("limOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("limOk").op(0x5b);
  asm.op(0x35, 0x35).push1(0x02).op(0x55, 0x00);
  // Blacklist writer: guarded mapping store.
  asm.label("setEntry").op(0x5b);
  if (guarded) {
    asm.pushLabel2("retCheck1").pushLabel2("funcCheck").op(0x56);
    asm.label("retCheck1").op(0x5b);
  }
  asm.op(0x35, 0x35).push1(0x00).op(0x52);
  asm.push1(writeBase).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x55, 0x00);
  // Limit writer: guarded slot-7 store of a caller-chosen value.
  asm.label("limitEntry").op(0x5b);
  if (guarded) {
    asm.pushLabel2("retCheck2").pushLabel2("funcCheck").op(0x56);
    asm.label("retCheck2").op(0x5b);
  }
  asm.op(0x35).push1(0x07).op(0x55, 0x00);
  // Ownership writer: guarded slot-0 store of a caller-chosen value.
  asm.label("ownEntry").op(0x5b);
  if (guarded) {
    asm.pushLabel2("retCheck3").pushLabel2("funcCheck").op(0x56);
    asm.label("retCheck3").op(0x5b);
  }
  asm.op(0x35).push1(0x00).op(0x55, 0x00);
  if (guarded) {
    // Shared internal functions: _checkOwner, owner(), _msgSender(),
    // and the revert encoding helper with its dynamic return.
    asm.label("funcCheck").op(0x5b);
    asm.pushLabel2("retOwner").pushLabel2("funcOwner").op(0x56);
    asm.label("retOwner").op(0x5b);
    asm.pushLabel2("retSender").pushLabel2("funcSender").op(0x56);
    asm.label("retSender").op(0x5b);
    asm.op(0x14);
    asm.pushLabel2("checkOk").op(0x57);
    asm.pushLabel2("retRevert").pushLabel2("funcEncode").op(0x56);
    asm.label("retRevert").op(0x5b).push1(0x00).op(0x80, 0xfd);
    asm.label("checkOk").op(0x5b, 0x56);
    asm.label("funcOwner").op(0x5b);
    asm.push1(0x00).op(0x54, 0x90, 0x56);
    asm.label("funcSender").op(0x5b);
    asm.op(0x33, 0x90, 0x56);
    asm.label("funcEncode").op(0x5b);
    asm.push1(0x01).push1(0x00).op(0x52);
    asm.push1(0x00).op(0x90, 0x56);
  }
  asm.label("funcAdd").op(0x5b, 0x56);
  asm.label("end").op(0x5b, 0xfe);
  return asm.build();
}

// Fee-exempt gate token (SCAN-1): a guarded setter writes mapping base
// 7, and both transfer entries route through a shared helper that reads
// the same entry only to skip a limit check on constant slot 6 (the
// exempt path returns at once; the non-exempt path runs the reverting
// limit compare). The mapping value never itself gates a revert, so no
// blacklist pair is proven. The gate lives in the shared helper, so the
// scored proof stays silent and only the extended proof can misfire.
// Synthetic selectors and hand-assembled bytecode only.
export const FEE_EXEMPT_SET = "0x0a9c6c1e";

export function feeExemptGateTokenHex(writeBase = 7, gateBase = 7): string {
  const asm = new Asm();
  asm.op(0x80).push4(TRANSFER_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4(TRANSFER_FROM_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferFromEntry").op(0x57);
  asm.op(0x80).push4(FEE_EXEMPT_SET.slice(2)).op(0x14);
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
  asm.label("setEntry").op(0x5b);
  asm.op(0x33).push1(0x00).op(0x54, 0x14);
  asm.pushLabel2("setOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("setOk").op(0x5b);
  asm.op(0x35, 0x35).push1(0x00).op(0x52);
  asm.push1(writeBase).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x55);
  asm.op(0x00);
  // Shared helper: exempt entries return at once; the rest run a
  // reverting limit compare on constant slot 6.
  asm.label("shared").op(0x5b);
  asm.op(0x35).push1(0x00).op(0x52);
  asm.push1(gateBase).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x54, 0x15);
  asm.pushLabel2("check").op(0x57);
  asm.op(0x56);
  asm.label("check").op(0x5b);
  asm.op(0x35).push1(0x06).op(0x54, 0x10, 0x15);
  asm.pushLabel2("sharedOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("sharedOk").op(0x5b);
  asm.op(0x56, 0xfe);
  asm.label("ret1").op(0x5b, 0x00);
  asm.label("ret2").op(0x5b, 0x00);
  return asm.build();
}

// Dual-entry blacklist gate token (SCAN-1): both transfer entries route
// through a shared helper that reverts while either of two entries of
// mapping base 7 reads set (sender and recipient shaped), and a guarded
// setter writes the same base. Synthetic selectors and bytecode only.
export const DUAL_BLACKLIST_SET = "0x0a9c6c1e";

export function dualBlacklistGateTokenHex(writeBase = 7, gateBase = 7): string {
  const asm = new Asm();
  asm.op(0x80).push4(TRANSFER_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4(TRANSFER_FROM_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferFromEntry").op(0x57);
  asm.op(0x80).push4(DUAL_BLACKLIST_SET.slice(2)).op(0x14);
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
  asm.label("setEntry").op(0x5b);
  asm.op(0x33).push1(0x00).op(0x54, 0x14);
  asm.pushLabel2("setOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("setOk").op(0x5b);
  asm.op(0x35, 0x35).push1(0x00).op(0x52);
  asm.push1(writeBase).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x55);
  asm.op(0x00);
  asm.label("shared").op(0x5b);
  asm.op(0x35).push1(0x00).op(0x52);
  asm.push1(gateBase).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x54, 0x15);
  asm.pushLabel2("second").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("second").op(0x5b);
  asm.op(0x35).push1(0x00).op(0x52);
  asm.push1(gateBase).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x54, 0x15);
  asm.pushLabel2("sharedOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("sharedOk").op(0x5b);
  asm.op(0x56, 0xfe);
  asm.label("ret1").op(0x5b, 0x00);
  asm.label("ret2").op(0x5b, 0x00);
  return asm.build();
}

// Shared-flag pause token (SCAN-1): both transfer entries route through
// a shared helper that reverts while flag slot 4 reads set. The setter
// always writes one; with `reversible` a second guarded setter also
// writes zero, so the flag flips both ways. Synthetic only.
export const SHARED_PAUSE_SET = "0x0a9c6c1e";
export const SHARED_PAUSE_CLEAR = "0x0b9c6c1e";

export function sharedPauseTokenHex(reversible: boolean): string {
  const asm = new Asm();
  asm.op(0x80).push4(TRANSFER_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4(TRANSFER_FROM_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferFromEntry").op(0x57);
  asm.op(0x80).push4(SHARED_PAUSE_SET.slice(2)).op(0x14);
  asm.pushLabel2("setEntry").op(0x57);
  if (reversible) {
    asm.op(0x80).push4(SHARED_PAUSE_CLEAR.slice(2)).op(0x14);
    asm.pushLabel2("clearEntry").op(0x57);
  }
  asm.label("fallback").op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("transferEntry").op(0x5b);
  asm.pushLabel2("ret1");
  asm.pushLabel2("shared");
  asm.op(0x56);
  asm.label("transferFromEntry").op(0x5b);
  asm.pushLabel2("ret2");
  asm.pushLabel2("shared");
  asm.op(0x56);
  asm.label("setEntry").op(0x5b);
  asm.op(0x33).push1(0x00).op(0x54, 0x14);
  asm.pushLabel2("setOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("setOk").op(0x5b);
  asm.push1(0x01).push1(0x04).op(0x55, 0x00);
  if (reversible) {
    asm.label("clearEntry").op(0x5b);
    asm.op(0x33).push1(0x00).op(0x54, 0x14);
    asm.pushLabel2("clearOk").op(0x57);
    asm.push1(0x00).op(0x80, 0xfd);
    asm.label("clearOk").op(0x5b);
    asm.push1(0x00).push1(0x04).op(0x55, 0x00);
  }
  asm.label("shared").op(0x5b);
  asm.push1(0x04).op(0x54, 0x15);
  asm.pushLabel2("sharedOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("sharedOk").op(0x5b);
  asm.op(0x56, 0xfe);
  asm.label("ret1").op(0x5b, 0x00);
  asm.label("ret2").op(0x5b, 0x00);
  return asm.build();
}

// Shared wallet-limit gate token (SCAN-1): both transfer entries route
// through a shared helper that reverts while balance(recipient) plus
// the amount exceeds limit slot 6, and a guarded setter writes slot 6
// with a computed (multiplied) caller value. Synthetic only.
export const SHARED_LIMIT_SET = "0x0a9c6c1e";

export function sharedLimitGateTokenHex(): string {
  const asm = new Asm();
  asm.op(0x80).push4(TRANSFER_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4(TRANSFER_FROM_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferFromEntry").op(0x57);
  asm.op(0x80).push4(SHARED_LIMIT_SET.slice(2)).op(0x14);
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
  asm.label("setEntry").op(0x5b);
  asm.op(0x33).push1(0x00).op(0x54, 0x14);
  asm.pushLabel2("setOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("setOk").op(0x5b);
  asm.op(0x35).push2(1000).op(0x02).push1(0x06).op(0x55, 0x00);
  asm.label("shared").op(0x5b);
  asm.op(0x35).push1(0x00).op(0x52);
  asm.push1(0x02).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x54);
  asm.op(0x35, 0x01).push1(0x06).op(0x54, 0x11, 0x15);
  asm.pushLabel2("sharedOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("sharedOk").op(0x5b);
  asm.op(0x56, 0xfe);
  asm.label("ret1").op(0x5b, 0x00);
  asm.label("ret2").op(0x5b, 0x00);
  return asm.build();
}

// Jump-side blacklist gate token (SCAN-2): both transfer entries route
// through a shared helper that jumps straight to its revert block while
// a mapping entry reads set (`if (listed[from]) revert` shape), and a
// guarded setter writes the same base. No ISZERO sits beside the gate
// load, so beside-window proofs stay silent. Synthetic only.
export const JUMP_GATE_SET = "0x0a9c6c1e";

export function jumpSideBlacklistTokenHex(writeBase = 7, gateBase = 7): string {
  const asm = new Asm();
  asm.op(0x80).push4(TRANSFER_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4(TRANSFER_FROM_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferFromEntry").op(0x57);
  asm.op(0x80).push4(JUMP_GATE_SET.slice(2)).op(0x14);
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
  asm.label("setEntry").op(0x5b);
  asm.op(0x33).push1(0x00).op(0x54, 0x14);
  asm.pushLabel2("setOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("setOk").op(0x5b);
  asm.op(0x35, 0x35).push1(0x00).op(0x52);
  asm.push1(writeBase).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x55);
  asm.op(0x00);
  asm.label("shared").op(0x5b);
  asm.op(0x35).push1(0x00).op(0x52);
  asm.push1(gateBase).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x54);
  asm.pushLabel2("blocked").op(0x57);
  asm.op(0x56);
  asm.label("blocked").op(0x5b);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("ret1").op(0x5b, 0x00);
  asm.label("ret2").op(0x5b, 0x00);
  return asm.build();
}

// Short-circuit blacklist gate token (SCAN-2): the shared helper
// reverts only when the listed entry reads set and the exempt entry
// reads clear, tested by two jumps in sequence, and a guarded setter
// writes the listed base. No single jump both tests the listed entry
// and reverts. Synthetic only.
export const SHORT_CIRCUIT_SET = "0x0a9c6c1e";

export function shortCircuitBlacklistTokenHex(): string {
  const asm = new Asm();
  asm.op(0x80).push4(TRANSFER_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4(TRANSFER_FROM_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferFromEntry").op(0x57);
  asm.op(0x80).push4(SHORT_CIRCUIT_SET.slice(2)).op(0x14);
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
  asm.label("setEntry").op(0x5b);
  asm.op(0x33).push1(0x00).op(0x54, 0x14);
  asm.pushLabel2("setOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("setOk").op(0x5b);
  asm.op(0x35, 0x35).push1(0x00).op(0x52);
  asm.push1(0x07).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x55);
  asm.op(0x00);
  asm.label("shared").op(0x5b);
  asm.op(0x35).push1(0x00).op(0x52);
  asm.push1(0x07).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x54, 0x15);
  asm.pushLabel2("sharedOk").op(0x57);
  asm.op(0x35).push1(0x00).op(0x52);
  asm.push1(0x08).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x54, 0x15);
  asm.pushLabel2("blocked").op(0x57);
  asm.op(0x56);
  asm.label("blocked").op(0x5b);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("sharedOk").op(0x5b);
  asm.op(0x56, 0xfe);
  asm.label("ret1").op(0x5b, 0x00);
  asm.label("ret2").op(0x5b, 0x00);
  return asm.build();
}

// Shifted-owner blacklist token (SCAN-2): the owner word sits packed
// above a flag byte, so the writer guard shifts the loaded slot word
// before comparing it with the caller. The gate is the jump-side
// shared helper on base 7. Synthetic only.
export const SHIFTED_OWNER_SET = "0x0a9c6c1e";

export function shiftedOwnerBlacklistTokenHex(): string {
  const asm = new Asm();
  asm.op(0x80).push4(TRANSFER_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4(SHIFTED_OWNER_SET.slice(2)).op(0x14);
  asm.pushLabel2("setEntry").op(0x57);
  asm.label("fallback").op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("transferEntry").op(0x5b);
  asm.op(0x35).push1(0x00).op(0x52);
  asm.push1(0x07).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x54);
  asm.pushLabel2("blocked").op(0x57);
  asm.op(0x00);
  asm.label("blocked").op(0x5b);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("setEntry").op(0x5b);
  asm.push1(0x00).op(0x54);
  asm.push1(0x08).op(0x1c, 0x33, 0x14);
  asm.pushLabel2("setOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("setOk").op(0x5b);
  asm.op(0x35, 0x35).push1(0x00).op(0x52);
  asm.push1(0x07).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x55);
  asm.op(0x00);
  return asm.build();
}

// Role-only blacklist token (SCAN-2): no constant owner slot exists.
// The setter is guarded only by a caller-keyed role entry on base 9,
// while the transfer path gates on mapping base 7. Synthetic only.
export const ROLE_ONLY_SET = "0x0a9c6c1e";

function roleOnlyGuard(asm: Asm, okLabel: string, blockedLabel: string): void {
  asm.op(0x33).push1(0x00).op(0x52);
  asm.push1(0x09).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x54, 0x15);
  asm.pushLabel2(blockedLabel).op(0x57);
  asm.pushLabel2(okLabel).op(0x56);
  asm.label(blockedLabel).op(0x5b);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label(okLabel).op(0x5b);
}

export function roleOnlyBlacklistTokenHex(): string {
  const asm = new Asm();
  asm.op(0x80).push4(TRANSFER_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4(ROLE_ONLY_SET.slice(2)).op(0x14);
  asm.pushLabel2("setEntry").op(0x57);
  asm.label("fallback").op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("transferEntry").op(0x5b);
  asm.op(0x35).push1(0x00).op(0x52);
  asm.push1(0x07).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x54, 0x15);
  asm.pushLabel2("tok").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("tok").op(0x5b, 0x00);
  asm.label("setEntry").op(0x5b);
  roleOnlyGuard(asm, "setOk", "setBlocked");
  asm.op(0x35, 0x35).push1(0x00).op(0x52);
  asm.push1(0x07).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x55);
  asm.op(0x00);
  return asm.build();
}

// Role-only pause token (SCAN-2): no constant owner slot exists. Both
// flag writers are guarded only by a caller-keyed role entry on base 9,
// while the transfer path gates on flag slot 4. Synthetic only.
export const ROLE_ONLY_PAUSE_SET = "0x0a9c6c1e";
export const ROLE_ONLY_PAUSE_CLEAR = "0x0b9c6c1e";

export function roleOnlyPauseTokenHex(): string {
  const asm = new Asm();
  asm.op(0x80).push4(TRANSFER_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4(ROLE_ONLY_PAUSE_SET.slice(2)).op(0x14);
  asm.pushLabel2("setEntry").op(0x57);
  asm.op(0x80).push4(ROLE_ONLY_PAUSE_CLEAR.slice(2)).op(0x14);
  asm.pushLabel2("clearEntry").op(0x57);
  asm.label("fallback").op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("transferEntry").op(0x5b);
  asm.push1(0x04).op(0x54, 0x15);
  asm.pushLabel2("tok").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("tok").op(0x5b, 0x00);
  asm.label("setEntry").op(0x5b);
  roleOnlyGuard(asm, "setOk", "setBlocked");
  asm.push1(0x01).push1(0x04).op(0x55, 0x00);
  asm.label("clearEntry").op(0x5b);
  roleOnlyGuard(asm, "clearOk", "clearBlocked");
  asm.push1(0x00).push1(0x04).op(0x55, 0x00);
  return asm.build();
}

// Scratch-offset blacklist gate token (SCAN-2): the transfer gate
// hashes its mapping entry from scratch memory at 0x40/0x60 instead of
// the usual 0x00/0x20 pair, so neither the interpreter memory model nor
// the legacy base pattern names the base. The guarded setter writes
// base 7 through the usual layout. Synthetic only.
export const SCRATCH_GATE_SET = "0x0a9c6c1e";

export function scratchOffsetBlacklistTokenHex(): string {
  const asm = new Asm();
  asm.op(0x80).push4(TRANSFER_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4(SCRATCH_GATE_SET.slice(2)).op(0x14);
  asm.pushLabel2("setEntry").op(0x57);
  asm.label("fallback").op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("transferEntry").op(0x5b);
  asm.op(0x35).push1(0x40).op(0x52);
  asm.push1(0x07).push1(0x60).op(0x52);
  asm.push1(0x80).push1(0x40).op(0x20, 0x54, 0x15);
  asm.pushLabel2("tok").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("tok").op(0x5b, 0x00);
  asm.label("setEntry").op(0x5b);
  asm.op(0x33).push1(0x00).op(0x54, 0x14);
  asm.pushLabel2("setOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("setOk").op(0x5b);
  asm.op(0x35, 0x35).push1(0x00).op(0x52);
  asm.push1(0x07).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x55);
  asm.op(0x00);
  return asm.build();
}

// Balance-gate precision token (SCAN-2): a guarded writer credits
// mapping base 2, and the transfer path only checks the loaded balance
// against the calldata amount with LT before reverting. The mapping
// value prices a comparison, never a boolean gate. Synthetic only.
export const BALANCE_GATE_SET = "0x0a9c6c1e";

export function balanceGateTokenHex(): string {
  const asm = new Asm();
  asm.op(0x80).push4(TRANSFER_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4(BALANCE_GATE_SET.slice(2)).op(0x14);
  asm.pushLabel2("setEntry").op(0x57);
  asm.label("fallback").op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("transferEntry").op(0x5b);
  asm.op(0x35).push1(0x00).op(0x52);
  asm.push1(0x02).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x54);
  asm.op(0x35, 0x10, 0x15);
  asm.pushLabel2("tok").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("tok").op(0x5b, 0x00);
  asm.label("setEntry").op(0x5b);
  asm.op(0x33).push1(0x00).op(0x54, 0x14);
  asm.pushLabel2("setOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("setOk").op(0x5b);
  asm.op(0x35, 0x35).push1(0x00).op(0x52);
  asm.push1(0x02).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x55);
  asm.op(0x00);
  return asm.build();
}

// Compound-guard writer token (SCAN-2): the writer reaches its store
// only through a shared check helper that accepts the caller when it
// equals the stored owner or holds a caller-keyed role entry, and
// reverts otherwise. The gate or use site is supplied by the caller:
// `kind` picks a shared mapping gate, a flag gate, a fee use or a limit
// compare over the written slot or base. Synthetic only.
export const COMPOUND_SET = "0x0a9c6c1e";
export const COMPOUND_CLEAR = "0x0b9c6c1e";

function compoundCheckHelper(asm: Asm): void {
  asm.label("funcCheck").op(0x5b);
  asm.push1(0x00).op(0x54, 0x33, 0x14);
  asm.pushLabel2("checkOk").op(0x57);
  // Stack-neutral padding: the role path sits far past the beside
  // windows, so only the expression guard proof can follow it.
  for (let pad = 0; pad < 40; pad += 1) {
    asm.push1(0x00).op(0x50);
  }
  asm.op(0x33).push1(0x00).op(0x52);
  asm.push1(0x09).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x54);
  asm.pushLabel2("checkOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("checkOk").op(0x5b, 0x56);
}

export function compoundGuardBlacklistTokenHex(): string {
  const asm = new Asm();
  asm.op(0x80).push4(TRANSFER_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4(COMPOUND_SET.slice(2)).op(0x14);
  asm.pushLabel2("setEntry").op(0x57);
  asm.label("fallback").op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("transferEntry").op(0x5b);
  asm.op(0x35).push1(0x00).op(0x52);
  asm.push1(0x07).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x54, 0x15);
  asm.pushLabel2("tok").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("tok").op(0x5b, 0x00);
  asm.label("setEntry").op(0x5b);
  asm.pushLabel2("retCheck").pushLabel2("funcCheck").op(0x56);
  asm.label("retCheck").op(0x5b);
  asm.op(0x35, 0x35).push1(0x00).op(0x52);
  asm.push1(0x07).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x55);
  asm.op(0x00);
  compoundCheckHelper(asm);
  return asm.build();
}

export function compoundGuardPauseTokenHex(): string {
  const asm = new Asm();
  asm.op(0x80).push4(TRANSFER_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4(COMPOUND_SET.slice(2)).op(0x14);
  asm.pushLabel2("setEntry").op(0x57);
  asm.op(0x80).push4(COMPOUND_CLEAR.slice(2)).op(0x14);
  asm.pushLabel2("clearEntry").op(0x57);
  asm.label("fallback").op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("transferEntry").op(0x5b);
  asm.push1(0x04).op(0x54, 0x15);
  asm.pushLabel2("tok").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("tok").op(0x5b, 0x00);
  asm.label("setEntry").op(0x5b);
  asm.pushLabel2("retSet").pushLabel2("funcCheck").op(0x56);
  asm.label("retSet").op(0x5b);
  asm.push1(0x01).push1(0x04).op(0x55, 0x00);
  asm.label("clearEntry").op(0x5b);
  asm.pushLabel2("retClear").pushLabel2("funcCheck").op(0x56);
  asm.label("retClear").op(0x5b);
  asm.push1(0x00).push1(0x04).op(0x55, 0x00);
  compoundCheckHelper(asm);
  return asm.build();
}

// Jump-side pause gate token (SCAN-2): the transfer path jumps straight
// to its revert block while flag slot 4 reads set, with no ISZERO beside
// the load. `reversible` adds the guarded zero writer. Synthetic only.
export const JUMP_PAUSE_SET = "0x0a9c6c1e";
export const JUMP_PAUSE_CLEAR = "0x0b9c6c1e";

export function jumpSidePauseTokenHex(reversible: boolean): string {
  const asm = new Asm();
  asm.op(0x80).push4(TRANSFER_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4(JUMP_PAUSE_SET.slice(2)).op(0x14);
  asm.pushLabel2("setEntry").op(0x57);
  if (reversible) {
    asm.op(0x80).push4(JUMP_PAUSE_CLEAR.slice(2)).op(0x14);
    asm.pushLabel2("clearEntry").op(0x57);
  }
  asm.label("fallback").op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("transferEntry").op(0x5b);
  asm.push1(0x04).op(0x54);
  asm.pushLabel2("blocked").op(0x57);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("blocked").op(0x5b);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("setEntry").op(0x5b);
  asm.op(0x33).push1(0x00).op(0x54, 0x14);
  asm.pushLabel2("setOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("setOk").op(0x5b);
  asm.push1(0x01).push1(0x04).op(0x55, 0x00);
  if (reversible) {
    asm.label("clearEntry").op(0x5b);
    asm.op(0x33).push1(0x00).op(0x54, 0x14);
    asm.pushLabel2("clearOk").op(0x57);
    asm.push1(0x00).op(0x80, 0xfd);
    asm.label("clearOk").op(0x5b);
    asm.push1(0x00).push1(0x04).op(0x55, 0x00);
  }
  return asm.build();
}

// Mask-gate packed pause token (SCAN-2): flag bit 8 of slot 4 is set
// and cleared by guarded packed writers, and the transfer path tests
// the bit with a single-bit AND mask and no shift anywhere, so the
// shift matchers stay silent. Synthetic only.
export const MASK_PAUSE_SET = "0x0a9c6c1e";
export const MASK_PAUSE_CLEAR = "0x0b9c6c1e";

export function maskGatePauseTokenHex(): BytecodeType {
  const writeSeq = (value: number): number[] => [
    0x60, value, 0x60, 0x04, 0x60, 0x01, 0x61, 0x01, 0x00, EXP,
    DUP2, SLOAD, DUP2, 0x60, 0xff, MUL, NOT, AND, SWAP1, DUP4,
    ISZERO, ISZERO, MUL, OR, SWAP1, SSTORE,
  ];
  return tokenBytecode([
    {
      selector: MASK_PAUSE_SET,
      body: [...ownerGuard(0, 200), ...writeSeq(1), STOP],
    },
    {
      selector: MASK_PAUSE_CLEAR,
      body: [...ownerGuard(0, 200), ...writeSeq(0), STOP],
    },
    {
      selector: TRANSFER_SELECTOR,
      body: [
        ...push1(4),
        SLOAD,
        0x61,
        0x01,
        0x00,
        AND,
        ISZERO,
        ...branchOk(),
        ...push1(0),
        0x80,
        REVERT,
        0x5b,
        ...sstoreConstSlot(2, [CALLDATALOAD]),
        STOP,
      ],
    },
  ]);
}

// Compound-guard fee token (SCAN-2): the rate writer is guarded by the
// shared compound check helper; the transfer path multiplies the loaded
// rate with the calldata amount and subtracts it. Synthetic only.
export function compoundGuardFeeTokenHex(): string {
  const asm = new Asm();
  asm.op(0x80).push4(TRANSFER_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4(COMPOUND_SET.slice(2)).op(0x14);
  asm.pushLabel2("setEntry").op(0x57);
  asm.label("fallback").op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("transferEntry").op(0x5b);
  asm.op(0x35).push1(0x05).op(0x54, 0x02, 0x03);
  asm.push1(0x02).op(0x55, 0x00);
  asm.label("setEntry").op(0x5b);
  asm.pushLabel2("retCheck").pushLabel2("funcCheck").op(0x56);
  asm.label("retCheck").op(0x5b);
  asm.op(0x35).push1(0x05).op(0x55, 0x00);
  compoundCheckHelper(asm);
  return asm.build();
}

// Compound-guard limit token (SCAN-2): the limit writer is guarded by
// the shared compound check helper; the transfer path compares the
// calldata amount against the loaded limit and reverts past it.
// Synthetic only.
export function compoundGuardLimitTokenHex(): string {
  const asm = new Asm();
  asm.op(0x80).push4(TRANSFER_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4(COMPOUND_SET.slice(2)).op(0x14);
  asm.pushLabel2("setEntry").op(0x57);
  asm.label("fallback").op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("transferEntry").op(0x5b);
  asm.op(0x35).push1(0x06).op(0x54, 0x11, 0x15);
  asm.pushLabel2("tok").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("tok").op(0x5b, 0x00);
  asm.label("setEntry").op(0x5b);
  asm.pushLabel2("retCheck").pushLabel2("funcCheck").op(0x56);
  asm.label("retCheck").op(0x5b);
  asm.op(0x35).push1(0x06).op(0x55, 0x00);
  compoundCheckHelper(asm);
  return asm.build();
}

export function oldSolcPauseBitMismatchToken(): BytecodeType {
  return tokenBytecode([
    { selector: OLD_SOLC_PAUSE_SET, body: oldSolcPauseBody() },
    {
      selector: TRANSFER_SELECTOR,
      body: [
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
      ],
    },
  ]);
}

// Shuffled-store blacklist gate token (SCAN-2): the transfer gate
// stores its mapping key at scratch 0 through PUSH 0x00, SWAP1, DUP2,
// MSTORE, so the key destination push never sits beside the MSTORE.
// The guarded setter writes base 7 through the usual layout and the
// gate reverts while the entry reads set. Synthetic only.
export const SHUFFLED_GATE_SET = "0x0a9c6c1e";

export function shuffledStoreBlacklistTokenHex(): string {
  const asm = new Asm();
  asm.op(0x80).push4(TRANSFER_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4(SHUFFLED_GATE_SET.slice(2)).op(0x14);
  asm.pushLabel2("setEntry").op(0x57);
  asm.label("fallback").op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("transferEntry").op(0x5b);
  asm.op(0x35).push1(0x00).op(0x90, 0x81, 0x52);
  asm.push1(0x07).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x54, 0x15);
  asm.pushLabel2("tok").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("tok").op(0x5b, 0x00);
  asm.label("setEntry").op(0x5b);
  asm.op(0x33).push1(0x00).op(0x54, 0x14);
  asm.pushLabel2("setOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("setOk").op(0x5b);
  asm.op(0x35, 0x35).push1(0x00).op(0x52);
  asm.push1(0x07).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x55);
  asm.op(0x00);
  return asm.build();
}

// Byte-mask pause token (SCAN-2): packed bit 0 of slot 4 is set and
// cleared by guarded packed writers, and the transfer path tests the
// low byte of the slot word with AND 0xff and no shift anywhere, so
// the shift matchers stay silent. Synthetic only.
export const BYTE_MASK_PAUSE_SET = "0x0a9c6c1e";
export const BYTE_MASK_PAUSE_CLEAR = "0x0b9c6c1e";

export function byteMaskPauseTokenHex(): string {
  const asm = new Asm();
  asm.op(0x80).push4(TRANSFER_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4(BYTE_MASK_PAUSE_SET.slice(2)).op(0x14);
  asm.pushLabel2("setEntry").op(0x57);
  asm.op(0x80).push4(BYTE_MASK_PAUSE_CLEAR.slice(2)).op(0x14);
  asm.pushLabel2("clearEntry").op(0x57);
  asm.label("fallback").op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("transferEntry").op(0x5b);
  asm.push1(0x04).op(0x54);
  asm.push1(0xff).op(0x16, 0x15);
  asm.pushLabel2("tok").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("tok").op(0x5b);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("setEntry").op(0x5b);
  asm.op(0x33).push1(0x00).op(0x54, 0x14);
  asm.pushLabel2("setOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("setOk").op(0x5b);
  asm.push1(0x04).op(0x54);
  asm.push1(0x01).op(0x17);
  asm.push1(0x04).op(0x55, 0x00);
  asm.label("clearEntry").op(0x5b);
  asm.op(0x33).push1(0x00).op(0x54, 0x14);
  asm.pushLabel2("clearOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("clearOk").op(0x5b);
  asm.push1(0x04).op(0x54);
  asm.push1(0x01).op(0x19, 0x16);
  asm.push1(0x04).op(0x55, 0x00);
  return asm.build();
}

// SCAN-3 idiom fixtures: array-loop list writers, feature-flag batch
// setters, internal pause helpers, exempt-or-flag trading toggles,
// pair-only pause gates, dual-rate fee setters, scaled and removable
// limits, a block-number gate and supply-decreasing burn shapes. Every
// builder uses synthetic selectors and hand-assembled bytecode only.
export const SCAN3_SET = "0x0a9c6c1e";
export const SCAN3_CLEAR = "0x0b9c6c1e";
export const SCAN3_BURN = "0x42966c68";
export const SCAN3_SUPPLY = "0x18160ddd";

function scan3Dispatcher(asm: Asm, entries: readonly (readonly [string, string])[]): void {
  for (const [selector, label] of entries) {
    asm.op(0x80).push4(selector.slice(2)).op(0x14);
    asm.pushLabel2(label).op(0x57);
  }
  asm.label("fallback").op(0x5b).push1(0x00).op(0x80, 0xfd);
}

function scan3OwnerGuard(asm: Asm, okLabel: string, blockedLabel: string): void {
  asm.op(0x33).push1(0x00).op(0x54, 0x14);
  asm.pushLabel2(okLabel).op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label(blockedLabel).op(0x5b);
  asm.label(okLabel).op(0x5b);
}

// One mapping write of base `base` through the explicit keccak(key .
// baseSlot) memory pattern; key and value arrive as two calldata loads.
function scan3MappingWrite(asm: Asm, base: number): void {
  asm.op(0x35, 0x35).push1(0x00).op(0x52);
  asm.push1(base).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x55);
}

// One mapping load of base `base` keyed by a calldata word.
function scan3MappingLoad(asm: Asm, base: number): void {
  asm.op(0x35).push1(0x00).op(0x52);
  asm.push1(base).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x54);
}

function scan3SharedHead(asm: Asm): void {
  asm.label("transferEntry").op(0x5b);
  asm.pushLabel2("ret1");
  asm.pushLabel2("shared");
  asm.op(0x56);
  asm.label("transferFromEntry").op(0x5b);
  asm.pushLabel2("ret2");
  asm.pushLabel2("shared");
  asm.op(0x56);
}

function scan3SharedTail(asm: Asm): void {
  asm.label("ret1").op(0x5b, 0x00);
  asm.label("ret2").op(0x5b, 0x00);
}

// Bots-array blacklist token (SCAN-3): the list writer loops over a
// calldata array, storing one mapping entry of base 7 per iteration
// behind an owner guard; a second guarded writer clears entries the
// same way. Both transfer entries route through a shared gate that
// reverts while either of two entries of base 7 reads set.
export function botsArrayBlacklistTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [TRANSFER_FROM_SELECTOR, "transferFromEntry"],
    [SCAN3_SET, "setEntry"],
    [SCAN3_CLEAR, "clearEntry"],
  ]);
  scan3SharedHead(asm);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.label("setLoop").op(0x5b);
  scan3MappingWrite(asm, 7);
  asm.pushLabel2("setLoop").op(0x56);
  asm.label("clearEntry").op(0x5b);
  scan3OwnerGuard(asm, "clearOk", "clearBlocked");
  asm.label("clearLoop").op(0x5b);
  scan3MappingWrite(asm, 7);
  asm.pushLabel2("clearLoop").op(0x56);
  asm.label("shared").op(0x5b);
  scan3MappingLoad(asm, 7);
  asm.op(0x15);
  asm.pushLabel2("second").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("second").op(0x5b);
  scan3MappingLoad(asm, 7);
  asm.op(0x15);
  asm.pushLabel2("sharedOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("sharedOk").op(0x5b);
  asm.op(0x56, 0xfe);
  scan3SharedTail(asm);
  return asm.build();
}

// Feature-flag batch blacklist token (SCAN-3): the guarded batch setter
// first requires feature flag slot 8 to read set, then loops mapping
// writes of base 7. The shared transfer gate jumps straight to its
// revert while an entry reads set (`if (listed[from]) revert` shape).
export function featureFlagBatchBlacklistTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [TRANSFER_FROM_SELECTOR, "transferFromEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  scan3SharedHead(asm);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.push1(0x08).op(0x54, 0x15);
  asm.pushLabel2("setLoopHead").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("setLoopHead").op(0x5b);
  scan3MappingWrite(asm, 7);
  asm.pushLabel2("setLoopHead").op(0x56);
  asm.label("shared").op(0x5b);
  scan3MappingLoad(asm, 7);
  asm.pushLabel2("blocked").op(0x57);
  asm.op(0x56);
  asm.label("blocked").op(0x5b);
  asm.push1(0x00).op(0x80, 0xfd);
  scan3SharedTail(asm);
  return asm.build();
}

// Dead-setter token (SCAN-3, negative): a guarded writer sets mapping
// base 7, but the transfer path only checks the balance mapping of
// base 2 against the amount and never reads base 7, so no list power
// is proven.
export function deadSetterBlacklistTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  scan3MappingLoad(asm, 2);
  asm.op(0x35, 0x10, 0x15);
  asm.pushLabel2("tok").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("tok").op(0x5b);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  scan3MappingWrite(asm, 7);
  asm.op(0x00);
  return asm.build();
}

// Exempt-skip token (SCAN-3, negative): a guarded writer sets an
// exemption mapping of base 7. Both transfer entries route through a
// shared helper that returns at once while either of two exemption
// entries reads set, and otherwise runs a reverting limit compare on
// slot 6; the exemption itself never reverts a transfer.
export function exemptSkipLimitTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [TRANSFER_FROM_SELECTOR, "transferFromEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  scan3SharedHead(asm);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  scan3MappingWrite(asm, 7);
  asm.op(0x00);
  asm.label("shared").op(0x5b);
  scan3MappingLoad(asm, 7);
  asm.op(0x15);
  asm.pushLabel2("second").op(0x57);
  asm.op(0x56);
  asm.label("second").op(0x5b);
  scan3MappingLoad(asm, 7);
  asm.op(0x15);
  asm.pushLabel2("check").op(0x57);
  asm.op(0x56);
  asm.label("check").op(0x5b);
  asm.op(0x35).push1(0x06).op(0x54, 0x11, 0x15);
  asm.pushLabel2("sharedOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("sharedOk").op(0x5b);
  asm.op(0x56, 0xfe);
  scan3SharedTail(asm);
  return asm.build();
}

// Internal-helper pause token (SCAN-3): both guarded pause entries jump
// into one shared write helper carrying the new flag value, which
// stores slot 4 and returns through the dynamic return address. Both
// transfer entries route through a shared gate that jumps straight to
// its revert while slot 4 reads set.
export function internalPauseTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [TRANSFER_FROM_SELECTOR, "transferFromEntry"],
    [SCAN3_SET, "setEntry"],
    [SCAN3_CLEAR, "clearEntry"],
  ]);
  scan3SharedHead(asm);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.pushLabel2("setRet");
  asm.push1(0x01);
  asm.pushLabel2("writeHelper");
  asm.op(0x56);
  asm.label("setRet").op(0x5b, 0x00);
  asm.label("clearEntry").op(0x5b);
  scan3OwnerGuard(asm, "clearOk", "clearBlocked");
  asm.pushLabel2("clearRet");
  asm.push1(0x00);
  asm.pushLabel2("writeHelper");
  asm.op(0x56);
  asm.label("clearRet").op(0x5b, 0x00);
  asm.label("writeHelper").op(0x5b);
  asm.push1(0x04).op(0x55, 0x56);
  asm.label("shared").op(0x5b);
  asm.push1(0x04).op(0x54);
  asm.pushLabel2("blocked").op(0x57);
  asm.op(0x56);
  asm.label("blocked").op(0x5b);
  asm.push1(0x00).op(0x80, 0xfd);
  scan3SharedTail(asm);
  return asm.build();
}

// Trading-toggle token (SCAN-3): guarded writers flip flag slot 4 both
// ways. The transfer path proceeds while the flag reads set or an
// exemption entry of base 7 reads set, and reverts otherwise
// (`require(flag || exempt[from])` shape).
export function tradingToggleExemptTokenHex(reversible: boolean): string {
  const asm = new Asm();
  const entries: (readonly [string, string])[] = reversible
    ? [
        [TRANSFER_SELECTOR, "transferEntry"],
        [SCAN3_SET, "setEntry"],
        [SCAN3_CLEAR, "clearEntry"],
      ]
    : [
        [TRANSFER_SELECTOR, "transferEntry"],
        [SCAN3_SET, "setEntry"],
      ];
  scan3Dispatcher(asm, entries);
  asm.label("transferEntry").op(0x5b);
  asm.push1(0x04).op(0x54);
  asm.pushLabel2("tok").op(0x57);
  scan3MappingLoad(asm, 7);
  asm.pushLabel2("tok").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("tok").op(0x5b);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.push1(0x01).push1(0x04).op(0x55, 0x00);
  if (reversible) {
    asm.label("clearEntry").op(0x5b);
    scan3OwnerGuard(asm, "clearOk", "clearBlocked");
    asm.push1(0x00).push1(0x04).op(0x55, 0x00);
  }
  return asm.build();
}

// Pair-only pause token (SCAN-3): guarded writers flip flag slot 4 both
// ways. The transfer path reverts only while the flag reads set and
// the recipient equals the stored pair address of slot 9.
export function pairOnlyPauseTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SET, "setEntry"],
    [SCAN3_CLEAR, "clearEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  asm.push1(0x04).op(0x54, 0x15);
  asm.pushLabel2("tok").op(0x57);
  asm.op(0x35).push1(0x09).op(0x54, 0x14, 0x15);
  asm.pushLabel2("tok").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("tok").op(0x5b);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.push1(0x01).push1(0x04).op(0x55, 0x00);
  asm.label("clearEntry").op(0x5b);
  scan3OwnerGuard(asm, "clearOk", "clearBlocked");
  asm.push1(0x00).push1(0x04).op(0x55, 0x00);
  return asm.build();
}

// Dual-rate fee token (SCAN-3): one guarded setter stores two calldata
// rates into slots 5 and 6 after a cap compare against 1000, and the
// transfer path multiplies the amount by slot 5 and subtracts.
export function dualRateFeeTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  asm.op(0x35).push1(0x05).op(0x54, 0x02, 0x03);
  asm.push1(0x02).op(0x55, 0x00);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.op(0x35).push2(1000).op(0x11, 0x15);
  asm.pushLabel2("wok").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("wok").op(0x5b);
  asm.op(0x35).push1(0x05).op(0x55);
  asm.op(0x35).push1(0x06).op(0x55, 0x00);
  return asm.build();
}

// Scaled-limit token (SCAN-3): the guarded setter stores the calldata
// value multiplied by 1000 into limit slot 6, and both transfer
// entries route through a shared gate that reverts while the loaded
// balance of base 2 plus the amount exceeds slot 6.
export function scaledLimitTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [TRANSFER_FROM_SELECTOR, "transferFromEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  scan3SharedHead(asm);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.op(0x35).push2(1000).op(0x02).push1(0x06).op(0x55, 0x00);
  asm.label("shared").op(0x5b);
  scan3MappingLoad(asm, 2);
  asm.op(0x35, 0x01).push1(0x06).op(0x54, 0x11, 0x15);
  asm.pushLabel2("sharedOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("sharedOk").op(0x5b);
  asm.op(0x56, 0xfe);
  scan3SharedTail(asm);
  return asm.build();
}

// Scaled limit with an unrelated popped timestamp read before the
// amount-versus-limit compare in the shared transfer path.
export function timestampPoppedLimitTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [TRANSFER_FROM_SELECTOR, "transferFromEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  scan3SharedHead(asm);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.op(0x35).push2(1000).op(0x02).push1(0x06).op(0x55, 0x00);
  asm.label("shared").op(0x5b);
  asm.op(0x42, 0x50);
  scan3MappingLoad(asm, 2);
  asm.op(0x35, 0x01).push1(0x06).op(0x54, 0x11, 0x15);
  asm.pushLabel2("sharedOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("sharedOk").op(0x5b);
  asm.op(0x56, 0xfe);
  scan3SharedTail(asm);
  return asm.build();
}

// Removable-limit token (SCAN-3): the guarded writer stores one large
// constant into limit slot 6 (a remove-limits write), and the transfer
// path reverts while the amount exceeds slot 6.
export function removableLimitTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  asm.op(0x35).push1(0x06).op(0x54, 0x11, 0x15);
  asm.pushLabel2("tok").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("tok").op(0x5b);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.push2(60000).push1(0x06).op(0x55, 0x00);
  return asm.build();
}

// Block-number gate token (SCAN-3, negative): the guarded writer
// stores a computed end block into slot 7, and the transfer path
// reverts while the block number reads below slot 7. No amount or
// balance is compared, so no limit power is proven.
export function blockNumberGateTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  asm.op(0x43).push1(0x07).op(0x54, 0x10, 0x15);
  asm.pushLabel2("tok").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("tok").op(0x5b);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.op(0x35).push1(0x0a).op(0x01).push1(0x07).op(0x55, 0x00);
  return asm.build();
}

// Burn-only token (SCAN-3, negative): the public burn entry decreases
// supply slot 2 by subtraction and adjusts a balance entry of base 3
// by addition beside the store (a shared update shape). No entry
// increases the supply slot, so no mint power is proven.
export function burnOnlyTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SUPPLY, "supplyEntry"],
    [SCAN3_BURN, "burnEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("supplyEntry").op(0x5b);
  asm.push1(0x02).op(0x54, 0x00);
  asm.label("burnEntry").op(0x5b);
  asm.push1(0x02).op(0x54);
  asm.op(0x35, 0x03).push1(0x02).op(0x55);
  scan3MappingLoad(asm, 3);
  asm.op(0x35, 0x01);
  scan3MappingLoad(asm, 3);
  asm.op(0x55, 0x00);
  return asm.build();
}

// Stored-recipient mint token (SCAN-3): the guarded writer increases
// supply slot 2 by the calldata amount and credits the balance entry
// of base 3 keyed by the stored owner address of slot 0 (an `issue`
// shape that mints to a stored account, not a calldata address).
export function storedRecipientMintTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SUPPLY, "supplyEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("supplyEntry").op(0x5b);
  asm.push1(0x02).op(0x54, 0x00);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.push1(0x02).op(0x54);
  asm.op(0x35, 0x01).push1(0x02).op(0x55);
  asm.push1(0x00).op(0x54).push1(0x00).op(0x52);
  asm.push1(0x03).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x80, 0x54);
  asm.op(0x35, 0x01, 0x90, 0x55, 0x00);
  return asm.build();
}

// Internal-clear pause token (SCAN-3): the guarded set entry stores
// one directly beside the SSTORE, while the guarded clear entry jumps
// into a shared write helper carrying zero, so only the expression
// view proves the flag also flips back. Both transfer entries route
// through a shared gate that reverts while slot 4 reads set.
export function internalClearPauseTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [TRANSFER_FROM_SELECTOR, "transferFromEntry"],
    [SCAN3_SET, "setEntry"],
    [SCAN3_CLEAR, "clearEntry"],
  ]);
  scan3SharedHead(asm);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.push1(0x01).push1(0x04).op(0x55, 0x00);
  asm.label("clearEntry").op(0x5b);
  scan3OwnerGuard(asm, "clearOk", "clearBlocked");
  asm.pushLabel2("clearRet");
  asm.push1(0x00);
  asm.pushLabel2("writeHelper");
  asm.op(0x56);
  asm.label("clearRet").op(0x5b, 0x00);
  asm.label("writeHelper").op(0x5b);
  asm.push1(0x04).op(0x55, 0x56);
  asm.label("shared").op(0x5b);
  asm.push1(0x04).op(0x54, 0x15);
  asm.pushLabel2("sharedOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("sharedOk").op(0x5b);
  asm.op(0x56, 0xfe);
  scan3SharedTail(asm);
  return asm.build();
}

// Struct fee token (SCAN-3): one guarded setter stores three calldata
// fee fields into consecutive slots 5, 6 and 7, and the transfer path
// sums two loaded fields, multiplies the amount by the sum, divides
// by 10000 and subtracts the result.
export function structFeeTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  asm.op(0x35).push1(0x05).op(0x54).push1(0x06).op(0x54, 0x01, 0x02);
  asm.push2(10000).op(0x04, 0x03);
  asm.push1(0x02).op(0x55, 0x00);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.op(0x35).push1(0x05).op(0x55);
  asm.op(0x35).push1(0x06).op(0x55);
  asm.op(0x35).push1(0x07).op(0x55, 0x00);
  return asm.build();
}

// Nested-role frozen token (SCAN-3): the list writer is guarded only
// by a nested role entry — the caller keyed under a role word hashed
// with base 9 in two keccak stages — and writes frozen mapping base 7.
// The shared transfer gate jumps straight to its revert while an
// entry reads set.
export function nestedRoleFrozenTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [TRANSFER_FROM_SELECTOR, "transferFromEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  scan3SharedHead(asm);
  asm.label("setEntry").op(0x5b);
  // Inner hash: keccak(role . base 9) left in memory at 0x00.
  asm.push1(0x2a).push1(0x00).op(0x52);
  asm.push1(0x09).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20);
  // Outer hash: keccak(caller . inner) keyed load.
  asm.push1(0x20).op(0x52);
  asm.op(0x33).push1(0x00).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x54, 0x15);
  asm.pushLabel2("setBlocked").op(0x57);
  asm.pushLabel2("setOk").op(0x56);
  asm.label("setBlocked").op(0x5b);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("setOk").op(0x5b);
  scan3MappingWrite(asm, 7);
  asm.op(0x00);
  asm.label("shared").op(0x5b);
  scan3MappingLoad(asm, 7);
  asm.pushLabel2("blocked").op(0x57);
  asm.op(0x56);
  asm.label("blocked").op(0x5b);
  asm.push1(0x00).op(0x80, 0xfd);
  scan3SharedTail(asm);
  return asm.build();
}

// Caller-keyed gate token (SCAN-3): the guarded writer sets mapping
// base 7, and the transfer path gates on the entry keyed by the
// caller itself (`require(!listed[msg.sender])` shape), tested by a
// raw load that jumps straight to its revert.
export function callerKeyedBlacklistTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  asm.op(0x33).push1(0x00).op(0x52);
  asm.push1(0x07).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x54);
  asm.pushLabel2("blocked").op(0x57);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("blocked").op(0x5b);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  scan3MappingWrite(asm, 7);
  asm.op(0x00);
  return asm.build();
}

// Short-circuit packed pause token (SCAN-2): packed bit 8 of slot 0 is
// set and cleared by guarded packed writers. While the bit reads set
// the transfer path reverts only when the calldata word also reads
// nonzero, tested by a second jump, so no single jump both tests the
// flag and reverts on every path. Synthetic only.
export const SHORT_PAUSE_SET = "0x0a9c6c1e";
export const SHORT_PAUSE_CLEAR = "0x0b9c6c1e";

// Direct exemption token (SCAN-4, negative): a guarded writer sets an
// exemption mapping of base 7, and the transfer entry itself (no shared
// helper) branches around a flag check while either exemption entry
// reads set: `if (!exempt[from] && !exempt[to]) require(flag)`. The
// exemption load sits beside an ISZERO in the transfer entry, but the
// only revert gates on flag slot 4, never on the exemption entry, so
// no blacklist power is proven.
export function directExemptBlacklistTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SET, "setEntry"],
    [SCAN3_CLEAR, "clearEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  scan3MappingLoad(asm, 7);
  asm.op(0x15);
  asm.pushLabel2("flagCheck").op(0x57);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("flagCheck").op(0x5b);
  asm.push1(0x04).op(0x54, 0x15);
  asm.pushLabel2("proceed").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("proceed").op(0x5b);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  scan3MappingWrite(asm, 7);
  asm.op(0x00);
  asm.label("clearEntry").op(0x5b);
  scan3OwnerGuard(asm, "clearOk", "clearBlocked");
  asm.push1(0x01).push1(0x04).op(0x55, 0x00);
  return asm.build();
}

// Bool-helper pause token (SCAN-4): guarded writers flip flag slot 4
// both ways. Both transfer entries route through a shared gate that
// first jumps into a getter helper which loads slot 4 and returns the
// value on the stack; the gate then jumps straight to its revert while
// the returned value reads set (the `paused()` getter shape, where no
// load sits beside the gate compare in the gate block itself).
export function boolHelperPauseTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [TRANSFER_FROM_SELECTOR, "transferFromEntry"],
    [SCAN3_SET, "setEntry"],
    [SCAN3_CLEAR, "clearEntry"],
  ]);
  scan3SharedHead(asm);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.push1(0x01).push1(0x04).op(0x55, 0x00);
  asm.label("clearEntry").op(0x5b);
  scan3OwnerGuard(asm, "clearOk", "clearBlocked");
  asm.push1(0x00).push1(0x04).op(0x55, 0x00);
  asm.label("shared").op(0x5b);
  asm.pushLabel2("check");
  asm.pushLabel2("getter");
  asm.op(0x56);
  asm.label("check").op(0x5b);
  asm.pushLabel2("blocked").op(0x57);
  asm.op(0x56, 0xfe);
  asm.label("blocked").op(0x5b);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("getter").op(0x5b);
  asm.push1(0x04).op(0x54, 0x56);
  scan3SharedTail(asm);
  return asm.build();
}

// Bool-helper blacklist token (SCAN-4): the guarded writer sets mapping
// base 7. Both transfer entries route through a shared gate that jumps
// into a require-helper; the helper loads the entry of base 7 and jumps
// straight to its revert while the entry reads set, returning to the
// gate otherwise (the `_requireNotBlacklisted(account)` shape).
export function boolHelperBlacklistTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [TRANSFER_FROM_SELECTOR, "transferFromEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  scan3SharedHead(asm);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  scan3MappingWrite(asm, 7);
  asm.op(0x00);
  asm.label("shared").op(0x5b);
  asm.pushLabel2("afterRequire");
  asm.pushLabel2("requireHelper");
  asm.op(0x56);
  asm.label("afterRequire").op(0x5b);
  asm.op(0x56, 0xfe);
  asm.label("requireHelper").op(0x5b);
  scan3MappingLoad(asm, 7);
  asm.pushLabel2("blocked").op(0x57);
  asm.op(0x56);
  asm.label("blocked").op(0x5b);
  asm.push1(0x00).op(0x80, 0xfd);
  scan3SharedTail(asm);
  return asm.build();
}

// Memory-key bots token (SCAN-4): the guarded list writer loops over a
// memory array, so each mapping key arrives by MLOAD instead of a
// calldata load, storing one entry of base 7 per iteration behind an
// owner guard; a second guarded writer clears entries the same way.
// Both transfer entries route through a shared gate that reverts while
// either of two entries of base 7 reads set.
export function memoryKeyBotsBlacklistTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [TRANSFER_FROM_SELECTOR, "transferFromEntry"],
    [SCAN3_SET, "setEntry"],
    [SCAN3_CLEAR, "clearEntry"],
  ]);
  scan3SharedHead(asm);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.label("setLoop").op(0x5b);
  asm.op(0x35);
  asm.push1(0x00).op(0x51).push1(0x00).op(0x52);
  asm.push1(0x07).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x55);
  asm.pushLabel2("setLoop").op(0x56);
  asm.label("clearEntry").op(0x5b);
  scan3OwnerGuard(asm, "clearOk", "clearBlocked");
  asm.label("clearLoop").op(0x5b);
  asm.op(0x35);
  asm.push1(0x00).op(0x51).push1(0x00).op(0x52);
  asm.push1(0x07).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x55);
  asm.pushLabel2("clearLoop").op(0x56);
  asm.label("shared").op(0x5b);
  scan3MappingLoad(asm, 7);
  asm.op(0x15);
  asm.pushLabel2("second").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("second").op(0x5b);
  scan3MappingLoad(asm, 7);
  asm.op(0x15);
  asm.pushLabel2("sharedOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("sharedOk").op(0x5b);
  asm.op(0x56, 0xfe);
  scan3SharedTail(asm);
  return asm.build();
}

// Array-share fee token (SCAN-4): the guarded writer stores a
// calldata share into a dynamic-array element (slot derived as
// keccak(array slot) plus an index), and the transfer path loads an
// element of the same array, multiplies the amount by it, divides
// by 10000 and subtracts the result.
export function arrayShareFeeTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  asm.op(0x35, 0x80);
  asm.push1(0x09).push1(0x00).op(0x52);
  asm.push1(0x20).push1(0x00).op(0x20);
  asm.op(0x35, 0x01, 0x54, 0x02);
  asm.push2(10000).op(0x04, 0x03);
  asm.push1(0x02).op(0x55, 0x00);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.op(0x35);
  asm.push1(0x09).push1(0x00).op(0x52);
  asm.push1(0x20).push1(0x00).op(0x20);
  asm.op(0x35, 0x01, 0x55, 0x00);
  return asm.build();
}

// Enforce-guard blacklist token (SCAN-4): the guarded writer sets
// mapping base 7 and a second guarded writer sets exemption mapping
// base 8. Both transfer entries route through a shared guard that
// reverts while an entry of base 7 reads set and the matching entry
// of base 8 reads clear (`listed[from] && !exempt[from]` shape).
export function enforceGuardBlacklistTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [TRANSFER_FROM_SELECTOR, "transferFromEntry"],
    [SCAN3_SET, "setEntry"],
    [SCAN3_CLEAR, "clearEntry"],
  ]);
  scan3SharedHead(asm);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  scan3MappingWrite(asm, 7);
  asm.op(0x00);
  asm.label("clearEntry").op(0x5b);
  scan3OwnerGuard(asm, "clearOk", "clearBlocked");
  scan3MappingWrite(asm, 8);
  asm.op(0x00);
  asm.label("shared").op(0x5b);
  scan3MappingLoad(asm, 7);
  scan3MappingLoad(asm, 8);
  asm.op(0x15, 0x16, 0x15);
  asm.pushLabel2("sharedOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("sharedOk").op(0x5b);
  asm.op(0x56, 0xfe);
  scan3SharedTail(asm);
  return asm.build();
}

// Namespaced-slot pause token (SCAN-4): the flag lives at a wide
// storage slot pushed with PUSH32 (a namespaced storage location),
// set and cleared by guarded writers, and the transfer path loads
// the same wide slot beside an ISZERO gate that reverts.
export function namespacedPauseTokenHex(): string {
  const asm = new Asm();
  const wideSlot = (): void => {
    asm.op(0x7f);
    for (let index = 0; index < 31; index += 1) {
      asm.op(0x00);
    }
    asm.op(0x2a);
  };
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SET, "setEntry"],
    [SCAN3_CLEAR, "clearEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  wideSlot();
  asm.op(0x54, 0x15);
  asm.pushLabel2("tok").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("tok").op(0x5b);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.push1(0x01);
  wideSlot();
  asm.op(0x55, 0x00);
  asm.label("clearEntry").op(0x5b);
  scan3OwnerGuard(asm, "clearOk", "clearBlocked");
  asm.push1(0x00);
  wideSlot();
  asm.op(0x55, 0x00);
  return asm.build();
}

// Anti-whale struct limit token (SCAN-4): one guarded setter stores
// three struct fields into consecutive slots 6, 7 and 8, and both
// transfer entries route through a shared gate that reverts while
// the amount exceeds field slot 6.
export function antiWhaleLimitTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [TRANSFER_FROM_SELECTOR, "transferFromEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  scan3SharedHead(asm);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.op(0x35).push1(0x06).op(0x55);
  asm.op(0x35).push1(0x07).op(0x55);
  asm.op(0x35).push1(0x08).op(0x55, 0x00);
  asm.label("shared").op(0x5b);
  asm.op(0x35).push1(0x06).op(0x54, 0x11, 0x15);
  asm.pushLabel2("sharedOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("sharedOk").op(0x5b);
  asm.op(0x56, 0xfe);
  scan3SharedTail(asm);
  return asm.build();
}

// Snipe-window token (SCAN-4, negative): a hook-guarded writer stores
// an end block (calldata plus a small constant) into slot 6, and the
// shared transfer path compares the block number against slot 6 to
// decide an automatic listing store. No amount or balance is ever
// compared against slot 6, so no limit power is proven.
export function snipeWindowLimitTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [TRANSFER_FROM_SELECTOR, "transferFromEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  scan3SharedHead(asm);
  asm.label("setEntry").op(0x5b);
  asm.op(0x33).push1(0x05).op(0x54, 0x14);
  asm.pushLabel2("setOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("setOk").op(0x5b);
  asm.op(0x35).push1(0x04).op(0x01).push1(0x06).op(0x55, 0x00);
  asm.label("shared").op(0x5b);
  asm.op(0x43).push1(0x06).op(0x54, 0x11, 0x15);
  asm.pushLabel2("sharedOk").op(0x57);
  scan3MappingWrite(asm, 7);
  asm.label("sharedOk").op(0x5b);
  asm.op(0x56, 0xfe);
  scan3SharedTail(asm);
  return asm.build();
}

// Burn-through-update token (SCAN-4, negative): the public burn entry
// and both transfer entries route through one shared update helper
// that only ever decreases supply slot 2 (a subtraction beside the
// store) and adjusts a balance entry of base 3. No entry increases
// the supply slot, so no mint power is proven.
export function burnThroughUpdateTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [TRANSFER_FROM_SELECTOR, "transferFromEntry"],
    [SCAN3_SUPPLY, "supplyEntry"],
    [SCAN3_BURN, "burnEntry"],
  ]);
  scan3SharedHead(asm);
  asm.label("supplyEntry").op(0x5b);
  asm.push1(0x02).op(0x54, 0x00);
  asm.label("burnEntry").op(0x5b);
  asm.pushLabel2("burnRet");
  asm.pushLabel2("shared");
  asm.op(0x56);
  asm.label("burnRet").op(0x5b, 0x00);
  asm.label("shared").op(0x5b);
  asm.push1(0x02).op(0x54);
  asm.op(0x35, 0x03).push1(0x02).op(0x55);
  scan3MappingLoad(asm, 3);
  asm.op(0x35, 0x03);
  scan3MappingLoad(asm, 3);
  asm.op(0x55, 0x56, 0xfe);
  scan3SharedTail(asm);
  return asm.build();
}

// Packed-slot pause token (SCAN-4): flag bit 0 of slot 4 is packed
// beside other data in the same word. The guarded set writer stores
// `word | 1` and the clear writer stores `word & ~1`, so no constant
// sits beside either SSTORE. The transfer path masks bit 0 out of
// slot 4 and reverts while it reads set.
export function packedSlotPauseTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SET, "setEntry"],
    [SCAN3_CLEAR, "clearEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  asm.push1(0x04).op(0x54);
  asm.push1(0x01).op(0x16, 0x15);
  asm.pushLabel2("tok").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("tok").op(0x5b);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.push1(0x04).op(0x54);
  asm.push1(0x01).op(0x17).push1(0x04).op(0x55, 0x00);
  asm.label("clearEntry").op(0x5b);
  scan3OwnerGuard(asm, "clearOk", "clearBlocked");
  asm.push1(0x04).op(0x54);
  asm.push1(0x01).op(0x19, 0x16).push1(0x04).op(0x55, 0x00);
  return asm.build();
}

// Packed-struct fee token (SCAN-4): one guarded setter packs two
// calldata fee fields into slot 5 (low field, then a shifted high
// field stored with an OR), and the transfer path extracts a field
// with a shift and mask, multiplies the amount by it, divides by
// 10000 and subtracts the result (a packed fee-struct shape).
export function packedStructFeeTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  asm.op(0x35).push1(0x05).op(0x54);
  asm.push1(0x10).op(0x1c);
  asm.push1(0xff).op(0x16, 0x02);
  asm.push2(10000).op(0x04, 0x03);
  asm.push1(0x02).op(0x55, 0x00);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.op(0x35, 0x35).push1(0x10).op(0x1b, 0x17).push1(0x05).op(0x55, 0x00);
  return asm.build();
}

// Internal-setter fee token (SCAN-4): the guarded fee entry jumps into
// a shared internal setter carrying the calldata rate on the stack,
// which stores slot 5 and returns through the dynamic return address.
// The transfer path multiplies the amount by slot 5, divides by 10000
// and subtracts.
export function internalSetterFeeTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  asm.op(0x35).push1(0x05).op(0x54, 0x02);
  asm.push2(10000).op(0x04, 0x03);
  asm.push1(0x02).op(0x55, 0x00);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.pushLabel2("setRet");
  asm.op(0x35);
  asm.pushLabel2("writeHelper");
  asm.op(0x56);
  asm.label("setRet").op(0x5b, 0x00);
  asm.label("writeHelper").op(0x5b);
  asm.push1(0x05).op(0x55, 0x56);
  return asm.build();
}

// Max-wallet helper limit token (SCAN-4): the guarded writer stores a
// caller-chosen limit into slot 6, and both transfer entries route
// through a shared gate that reverts while the recipient balance of
// base 2 plus the amount exceeds slot 6.
export function maxWalletLimitTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [TRANSFER_FROM_SELECTOR, "transferFromEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  scan3SharedHead(asm);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.op(0x35).push1(0x06).op(0x55, 0x00);
  asm.label("shared").op(0x5b);
  scan3MappingLoad(asm, 2);
  asm.op(0x35, 0x01).push1(0x06).op(0x54, 0x11, 0x15);
  asm.pushLabel2("sharedOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("sharedOk").op(0x5b);
  asm.op(0x56, 0xfe);
  scan3SharedTail(asm);
  return asm.build();
}

// Internal-mint token (SCAN-4): the guarded mint entry jumps into a
// shared internal mint helper carrying the amount on the stack, which
// increases supply slot 2 by the amount and credits a balance entry of
// base 3, then returns through the dynamic return address.
export function internalMintTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SUPPLY, "supplyEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("supplyEntry").op(0x5b);
  asm.push1(0x02).op(0x54, 0x00);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.pushLabel2("mintRet");
  asm.op(0x35);
  asm.pushLabel2("mintHelper");
  asm.op(0x56);
  asm.label("mintRet").op(0x5b, 0x00);
  asm.label("mintHelper").op(0x5b);
  asm.push1(0x02).op(0x54);
  asm.op(0x90, 0x01).push1(0x02).op(0x55);
  scan3MappingLoad(asm, 3);
  asm.op(0x35, 0x01, 0x55, 0x56);
  return asm.build();
}

// Getter-helper blacklist token (SCAN-4): the guarded writer sets
// mapping base 7. Both transfer entries route through a shared gate
// that jumps into a getter helper which loads the entry of base 7 and
// returns the value on the stack; the gate then jumps straight to its
// revert while the returned value reads set (the
// `_isAddressBlacklisted(account)` shape, where no load sits beside
// the gate compare in the gate block itself).
export function getterHelperBlacklistTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [TRANSFER_FROM_SELECTOR, "transferFromEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  scan3SharedHead(asm);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  scan3MappingWrite(asm, 7);
  asm.op(0x00);
  asm.label("shared").op(0x5b);
  asm.pushLabel2("check");
  asm.pushLabel2("getter");
  asm.op(0x56);
  asm.label("check").op(0x5b);
  asm.pushLabel2("blocked").op(0x57);
  asm.op(0x56, 0xfe);
  asm.label("blocked").op(0x5b);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("getter").op(0x5b);
  scan3MappingLoad(asm, 7);
  asm.op(0x56);
  scan3SharedTail(asm);
  return asm.build();
}

// Custom-error gate token (SCAN-4): the guarded writer sets mapping
// base 7, and the transfer entry jumps straight to a long revert block
// (a custom-error payload built with several memory stores) while an
// entry reads set, so the revert sits far past the gate jump.
export function customErrorBlacklistTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  scan3MappingLoad(asm, 7);
  asm.pushLabel2("blocked").op(0x57);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("blocked").op(0x5b);
  for (let index = 0; index < 8; index += 1) {
    asm.push1(index).push1(index * 32).op(0x52);
  }
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  scan3MappingWrite(asm, 7);
  asm.op(0x00);
  return asm.build();
}

export function shortCircuitPackedPauseTokenHex(): string {
  const asm = new Asm();
  asm.op(0x80).push4(TRANSFER_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4(SHORT_PAUSE_SET.slice(2)).op(0x14);
  asm.pushLabel2("setEntry").op(0x57);
  asm.op(0x80).push4(SHORT_PAUSE_CLEAR.slice(2)).op(0x14);
  asm.pushLabel2("clearEntry").op(0x57);
  asm.label("fallback").op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("transferEntry").op(0x5b);
  asm.push1(0x00).op(0x54);
  asm.push1(0x08).op(0x1c);
  asm.push1(0xff).op(0x16, 0x15);
  asm.pushLabel2("tok").op(0x57);
  asm.op(0x35, 0x15);
  asm.pushLabel2("tok").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("tok").op(0x5b);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("setEntry").op(0x5b);
  asm.op(0x33).push1(0x00).op(0x54, 0x14);
  asm.pushLabel2("setOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("setOk").op(0x5b);
  asm.push1(0x00).op(0x54);
  asm.push1(0x01).push1(0x08).op(0x1b, 0x17);
  asm.push1(0x00).op(0x55, 0x00);
  asm.label("clearEntry").op(0x5b);
  asm.op(0x33).push1(0x00).op(0x54, 0x14);
  asm.pushLabel2("clearOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("clearOk").op(0x5b);
  asm.push1(0x00).op(0x54);
  asm.push1(0x01).push1(0x08).op(0x1b, 0x19, 0x16);
  asm.push1(0x00).op(0x55, 0x00);
  return asm.build();
}

// SCAN-P pause idioms from the dev set, reproduced as synthetic
// bytecode. Each builder mirrors how the source idiom compiles: a
// bool slot load feeding a conditional jump on the transfer path,
// with a guarded writer that can store both flag values.

// Bool-argument setter token (SCAN-P): one guarded writer stores the
// cleaned calldata bool (`ISZERO ISZERO` normalization) into flag
// slot 4, so the same entry writes both 0 and 1 (`setPaused(bool)`
// shape). The transfer path reverts while the flag reads set.
export function boolArgPauseTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  asm.push1(0x04).op(0x54, 0x15);
  asm.pushLabel2("tok").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("tok").op(0x5b);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.push1(0x04).op(0x35, 0x15, 0x15).push1(0x04).op(0x55, 0x00);
  return asm.build();
}

// Bool-argument trading switch (SCAN-P): one guarded writer stores
// the masked calldata bool (`AND 1`) into flag slot 4
// (`setTrading(bool)` shape). The transfer path proceeds while the
// flag reads set or an exemption entry reads set, and reverts
// otherwise (`require(tradingEnabled || exempt[from])` shape).
export function boolArgTradingTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  asm.push1(0x04).op(0x54);
  asm.pushLabel2("tok").op(0x57);
  scan3MappingLoad(asm, 7);
  asm.pushLabel2("tok").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("tok").op(0x5b);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.push1(0x04).op(0x35).push1(0x01).op(0x16).push1(0x04).op(0x55, 0x00);
  return asm.build();
}

// Early-return pause token (SCAN-P): guarded writers flip flag slot
// 4 both ways. While the flag reads set the transfer path jumps to
// a bare RETURN with no balance write (a silent early return), so
// no REVERT sits on the blocked side.
export function earlyReturnPauseTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SET, "setEntry"],
    [SCAN3_CLEAR, "clearEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  asm.push1(0x04).op(0x54);
  asm.pushLabel2("blocked").op(0x57);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("blocked").op(0x5b);
  asm.push1(0x00).op(0x80, 0xf3);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.push1(0x01).push1(0x04).op(0x55, 0x00);
  asm.label("clearEntry").op(0x5b);
  scan3OwnerGuard(asm, "clearOk", "clearBlocked");
  asm.push1(0x00).push1(0x04).op(0x55, 0x00);
  return asm.build();
}

// Two-flag AND gate token (SCAN-P): the transfer path reverts while
// both the deploy flag of slot 5 and the pause flag of slot 4 read
// set (`pausable && _paused` shape). Guarded writers flip slot 4
// both ways; slot 5 has no writer.
export function andGatePauseTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SET, "setEntry"],
    [SCAN3_CLEAR, "clearEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  asm.push1(0x05).op(0x54).push1(0x04).op(0x54, 0x16);
  asm.pushLabel2("blocked").op(0x57);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("blocked").op(0x5b);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.push1(0x01).push1(0x04).op(0x55, 0x00);
  asm.label("clearEntry").op(0x5b);
  scan3OwnerGuard(asm, "clearOk", "clearBlocked");
  asm.push1(0x00).push1(0x04).op(0x55, 0x00);
  return asm.build();
}

// Precondition pair-gate pause token (SCAN-P): the writers each
// require the flag's current value before flipping it
// (`pauseTrading`/`unpauseTrading` shape), and the transfer path
// reverts while the flag reads set on a pair trade that no
// whitelist entry covers. Guarded writers flip slot 4 both ways.
export function preconditionPairPauseTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SET, "setEntry"],
    [SCAN3_CLEAR, "clearEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  scan3MappingLoad(asm, 7);
  asm.op(0x15);
  asm.pushLabel2("tok").op(0x57);
  scan3MappingLoad(asm, 8);
  asm.pushLabel2("tok").op(0x57);
  asm.push1(0x04).op(0x54);
  asm.pushLabel2("blocked").op(0x57);
  asm.label("tok").op(0x5b);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("blocked").op(0x5b);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setGuardOk", "setGuardBlocked");
  asm.push1(0x04).op(0x54, 0x15);
  asm.pushLabel2("setOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("setOk").op(0x5b);
  asm.push1(0x01).push1(0x04).op(0x55, 0x00);
  asm.label("clearEntry").op(0x5b);
  scan3OwnerGuard(asm, "clearGuardOk", "clearGuardBlocked");
  asm.push1(0x04).op(0x54);
  asm.pushLabel2("clearOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("clearOk").op(0x5b);
  asm.push1(0x00).push1(0x04).op(0x55, 0x00);
  return asm.build();
}

// Fee-exempt mapping token (SCAN-P negative): one guarded writer
// stores a calldata bool into exemption mapping base 7. The
// transfer path only skips a step while an entry reads set; no
// side reverts or halts on the mapping, and no flag slot exists.
export function feeExemptBoolArgTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  scan3MappingLoad(asm, 7);
  asm.pushLabel2("skip").op(0x57);
  asm.push1(0x01).op(0x50);
  asm.label("skip").op(0x5b);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  scan3MappingWrite(asm, 7);
  asm.op(0x00);
  return asm.build();
}

// Raw calldata rate token (SCAN-P negative): one guarded writer
// stores the raw calldata word into slot 5 with no bool cleanup,
// and the transfer path branches on slot 5 reading zero. A raw
// word proves no boolean, so no flag writer is proven.
export function rawCalldataRateTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  asm.push1(0x05).op(0x54, 0x15);
  asm.pushLabel2("tok").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("tok").op(0x5b);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  asm.push1(0x04).op(0x35).push1(0x05).op(0x55, 0x00);
  return asm.build();
}

// SCAN-R fixtures: synthetic mirrors of the real-bytecode idioms the
// recall round fixed. No real bytecode, selectors or addresses.
export const SCANR_PLAIN_SET = "0x1c2d3e4f";
export const SCANR_SUB_SET = "0x2d3e4f50";
export const SCANR_SUB_CLEAR = "0x3e4f5061";
export const SCANR_OWNER_SET = "0x4f506172";

// Owner guard by subtraction (SCAN-R): the caller check compares the
// owner load and CALLER with SUB instead of EQ, jumping to its revert
// while the difference reads nonzero. The guarded body follows the
// guard and ends before the revert label.
function scanRSubGuard(asm: Asm, revertLabel: string): void {
  asm.op(0x33).push1(0x00).op(0x54, 0x03);
  asm.pushLabel2(revertLabel).op(0x57);
}

function scanRRevert(asm: Asm, revertLabel: string): void {
  asm.label(revertLabel).op(0x5b).push1(0x00).op(0x80, 0xfd);
}

// Packed pause with a plain constant writer beside it (SCAN-R): one
// guarded setter sets bit 8 of slot 0 with a shifted OR, another
// guarded setter writes the whole slot as constant one (the legacy
// toggle scan therefore reads a one-way flag), and with `withClear`
// a third guarded setter clears the same bit with an AND-NOT mask.
// The transfer path reverts while bit 8 reads set.
export function scanRPackedClearTokenHex(withClear: boolean): string {
  const asm = new Asm();
  const entries: (readonly [string, string])[] = [
    [TRANSFER_SELECTOR, "transferEntry"],
    [PACKED_PAUSE_SET, "setPackedEntry"],
    [SCANR_PLAIN_SET, "setPlainEntry"],
  ];
  if (withClear) {
    entries.push([PACKED_PAUSE_CLEAR, "clearPackedEntry"]);
  }
  scan3Dispatcher(asm, entries);
  asm.label("transferEntry").op(0x5b);
  asm.push1(0x00).op(0x54);
  asm.push1(0x08).op(0x1c);
  asm.push1(0xff).op(0x16, 0x15);
  asm.pushLabel2("tok").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("tok").op(0x5b);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("setPackedEntry").op(0x5b);
  scan3OwnerGuard(asm, "setPackedOk", "setPackedBlocked");
  asm.push1(0x00).op(0x54);
  asm.push1(0x01).push1(0x08).op(0x1b, 0x17);
  asm.push1(0x00).op(0x55, 0x00);
  asm.label("setPlainEntry").op(0x5b);
  scan3OwnerGuard(asm, "setPlainOk", "setPlainBlocked");
  asm.push1(0x01).push1(0x00).op(0x55, 0x00);
  if (withClear) {
    asm.label("clearPackedEntry").op(0x5b);
    scan3OwnerGuard(asm, "clearPackedOk", "clearPackedBlocked");
    asm.push1(0x00).op(0x54);
    asm.push1(0x01).push1(0x08).op(0x1b, 0x19, 0x16);
    asm.push1(0x00).op(0x55, 0x00);
  }
  return asm.build();
}

// Trading toggle behind a subtraction owner guard (SCAN-R): two
// guarded setters write one and zero to flag slot 4, the transfer
// path reverts while the flag reads clear, and a separate equality-
// guarded writer stores CALLER into owner slot 0 so the owner seat
// is proven. The flag writers carry no EQ, so only the subtraction
// guard proof can prove them.
export function scanRSubGuardPauseTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCANR_SUB_SET, "setEntry"],
    [SCANR_SUB_CLEAR, "clearEntry"],
    [SCANR_OWNER_SET, "ownerEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  asm.push1(0x04).op(0x54, 0x15);
  asm.pushLabel2("tok").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("tok").op(0x5b);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("setEntry").op(0x5b);
  scanRSubGuard(asm, "setRevert");
  asm.push1(0x01).push1(0x04).op(0x55, 0x00);
  scanRRevert(asm, "setRevert");
  asm.label("clearEntry").op(0x5b);
  scanRSubGuard(asm, "clearRevert");
  asm.push1(0x00).push1(0x04).op(0x55, 0x00);
  scanRRevert(asm, "clearRevert");
  asm.label("ownerEntry").op(0x5b);
  scan3OwnerGuard(asm, "ownerOk", "ownerBlocked");
  asm.op(0x33).push1(0x00).op(0x55, 0x00);
  return asm.build();
}

// Fee-exempt setter behind a subtraction owner guard (SCAN-R
// negative): the transfer path opens while a trading flag (slot 4)
// reads set or while the caller's entry of mapping base 7 reads set,
// and a guarded equality writer proves owner slot 0. The exemption
// setter is privileged in fact, but its subtraction guard alone
// never proves a list writer for the blacklist proof.
export function scanRSubGuardFeeExemptTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [TRANSFER_FROM_SELECTOR, "transferFromEntry"],
    [FEE_EXEMPT_SET, "setEntry"],
    [SCANR_OWNER_SET, "ownerEntry"],
  ]);
  scan3SharedHead(asm);
  asm.label("setEntry").op(0x5b);
  scanRSubGuard(asm, "setRevert");
  scan3MappingWrite(asm, 7);
  asm.op(0x00);
  scanRRevert(asm, "setRevert");
  asm.label("ownerEntry").op(0x5b);
  scan3OwnerGuard(asm, "ownerOk", "ownerBlocked");
  asm.op(0x33).push1(0x00).op(0x55, 0x00);
  asm.label("shared").op(0x5b);
  asm.push1(0x04).op(0x54);
  asm.pushLabel2("sharedOk").op(0x57);
  scan3MappingLoad(asm, 7);
  asm.pushLabel2("sharedOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("sharedOk").op(0x5b);
  asm.op(0x56, 0xfe);
  scan3SharedTail(asm);
  return asm.build();
}

// Blacklist setter behind a subtraction owner guard: the writer proves
// its caller check with SUB(owner, caller) gated to a revert, and the
// shared transfer gate reverts while the written entry reads set.
export function scanRSubGuardBlacklistTokenHex(): string {
  const asm = new Asm();
  asm.op(0x80).push4(TRANSFER_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4(JUMP_GATE_SET.slice(2)).op(0x14);
  asm.pushLabel2("setEntry").op(0x57);
  asm.op(0x80).push4(SCANR_OWNER_SET.slice(2)).op(0x14);
  asm.pushLabel2("ownerEntry").op(0x57);
  asm.label("fallback").op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("transferEntry").op(0x5b);
  asm.pushLabel2("ret1");
  asm.pushLabel2("shared");
  asm.op(0x56);
  asm.label("ownerEntry").op(0x5b);
  scan3OwnerGuard(asm, "ownerOk", "ownerBlocked");
  asm.op(0x33).push1(0x00).op(0x55, 0x00);
  asm.label("setEntry").op(0x5b);
  asm.op(0x33).push1(0x00).op(0x54, 0x03);
  asm.pushLabel2("setBlocked").op(0x57);
  asm.op(0x35, 0x35).push1(0x00).op(0x52);
  asm.push1(0x07).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x55);
  asm.op(0x00);
  asm.label("setBlocked").op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("shared").op(0x5b);
  asm.op(0x35).push1(0x00).op(0x52);
  asm.push1(0x07).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x54);
  asm.pushLabel2("blocked").op(0x57);
  asm.op(0x56);
  asm.label("blocked").op(0x5b);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("ret1").op(0x5b, 0x00);
  return asm.build();
}

// Exempt entry that still runs a limit check (SCAN-R negative): the
// transfer path reads mapping base 7 as a cleaned boolean; both the
// exempt and the non-exempt continuation run a limit compare on
// slot 6 that can revert, then store balances. A guarded setter
// writes base 7 and an equality-guarded writer proves owner slot 0.
// The exempt read branches around no list gate, so no blacklist
// fact is proven even though a revert is reachable past it.
export function scanRExemptLimitTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [FEE_EXEMPT_SET, "setEntry"],
    [SCANR_OWNER_SET, "ownerEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  scan3MappingLoad(asm, 7);
  asm.push1(0xff).op(0x16, 0x15);
  asm.pushLabel2("limit").op(0x57);
  asm.label("limit").op(0x5b);
  asm.push1(0x06).op(0x54);
  asm.push1(0x24).op(0x35, 0x10, 0x15);
  asm.pushLabel2("tok").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("tok").op(0x5b);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  scan3MappingWrite(asm, 7);
  asm.op(0x00);
  asm.label("ownerEntry").op(0x5b);
  scan3OwnerGuard(asm, "ownerOk", "ownerBlocked");
  asm.op(0x33).push1(0x00).op(0x55, 0x00);
  return asm.build();
}

// Allowlist-and token (SCAN-B, negative): a guarded writer sets
// mapping base 7, and the transfer entry requires both entries of
// base 7 to read set before it stores. A set entry lets a transfer
// through and a clear entry blocks it, which is an allowlist power,
// never a list, so no blacklist fact is proven.
export function allowlistAndBlacklistTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  scan3MappingLoad(asm, 7);
  asm.op(0x15);
  asm.pushLabel2("blocked").op(0x57);
  scan3MappingLoad(asm, 7);
  asm.op(0x15);
  asm.pushLabel2("blocked").op(0x57);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("blocked").op(0x5b);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  scan3MappingWrite(asm, 7);
  asm.op(0x00);
  return asm.build();
}

// Allowlist-or token (SCAN-B, negative): a guarded writer sets
// mapping base 7, and the transfer entry passes while either entry
// of base 7 reads set and reverts while both read clear. The set
// side is the passing side, so no blacklist fact is proven.
export function allowlistOrBlacklistTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  scan3MappingLoad(asm, 7);
  asm.pushLabel2("pass").op(0x57);
  scan3MappingLoad(asm, 7);
  asm.pushLabel2("pass").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("pass").op(0x5b);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  scan3MappingWrite(asm, 7);
  asm.op(0x00);
  return asm.build();
}

// Nested-helper blacklist token (SCAN-B): both transfer entries jump
// into a mid helper that jumps into a gate helper, which loads
// mapping base 7 and reverts while the entry reads set. A guarded
// writer sets base 7. The gate sits two internal jumps below the
// transfer entry, outside every entry-scoped walk.
export function nestedHelperBlacklistTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [TRANSFER_FROM_SELECTOR, "transferFromEntry"],
    [SCAN3_SET, "setEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  asm.pushLabel2("tAfter");
  asm.pushLabel2("mid");
  asm.op(0x56);
  asm.label("transferFromEntry").op(0x5b);
  asm.pushLabel2("tAfter");
  asm.pushLabel2("mid");
  asm.op(0x56);
  asm.label("tAfter").op(0x5b);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("mid").op(0x5b);
  asm.pushLabel2("mAfter");
  asm.pushLabel2("gate");
  asm.op(0x56);
  asm.label("mAfter").op(0x5b);
  asm.op(0x56);
  asm.label("gate").op(0x5b);
  scan3MappingLoad(asm, 7);
  asm.op(0x15);
  asm.pushLabel2("gOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("gOk").op(0x5b);
  asm.op(0x56);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  scan3MappingWrite(asm, 7);
  asm.op(0x00);
  return asm.build();
}

// Listed-and-not-exempt token (SCAN-B): the gate helper loads the
// list entry of base 7 and, while it reads set, loads the exemption
// entry of base 8 and reverts unless that reads set too. Guarded
// writers set both bases. The list gate proves through the second
// boolean test.
// Helper-owner token (SCORE-3): `owner()`/`getOwner()` returns the
// masked low 160 bits of `ownerSlot`, while every setter reaches a
// shared internal `_checkOwner` helper by JUMP. The helper calls
// internal owner/sender helpers (each returning through a dynamic
// JUMP), masks the loaded owner word, compares it with CALLER and
// reverts on mismatch. No single function region holds the whole
// check, so only getter-derived attribution can name the seat.
// Synthetic selectors and hand-assembled bytecode only.
export const HELPER_OWNER_SET = "0x5ab1e001";

export function helperOwnerTokenHex(
  ownerSlot = 3,
  guardSlot: number = ownerSlot,
  getter: "owner" | "getOwner" | null = "owner",
): string {
  const asm = new Asm();
  const mask = Array.from({ length: 20 }, () => 0xff);
  asm.op(0x80).push4(TRANSFER_SELECTOR.slice(2)).op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4(HELPER_OWNER_SET.slice(2)).op(0x14);
  asm.pushLabel2("setEntry").op(0x57);
  if (getter !== null) {
    asm.op(0x80).push4(getter === "owner" ? "8da5cb5b" : "893d20e8").op(0x14);
    asm.pushLabel2("getterEntry").op(0x57);
  }
  asm.label("fallback").op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("transferEntry").op(0x5b);
  asm.op(0x35).push1(0x00).op(0x52);
  asm.push1(4).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x54, 0x15);
  asm.pushLabel2("gateOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("gateOk").op(0x5b);
  asm.op(0x35, 0x35).push1(0x02).op(0x55, 0x00);
  asm.label("setEntry").op(0x5b);
  asm.pushLabel2("retCheck").pushLabel2("funcCheck").op(0x56);
  asm.label("retCheck").op(0x5b);
  asm.op(0x35, 0x35).push1(0x00).op(0x52);
  asm.push1(4).push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x55, 0x00);
  if (getter !== null) {
    asm.label("getterEntry").op(0x5b);
    asm.push1(ownerSlot).op(0x54);
    asm.op(0x73, ...mask, 0x16);
    asm.push1(0x00).op(0x52);
    asm.push1(0x20).push1(0x00).op(0xf3);
  }
  asm.label("funcCheck").op(0x5b);
  asm.pushLabel2("retOwner").pushLabel2("funcOwner").op(0x56);
  asm.label("retOwner").op(0x5b);
  asm.pushLabel2("retSender").pushLabel2("funcSender").op(0x56);
  asm.label("retSender").op(0x5b);
  asm.op(0x14);
  asm.pushLabel2("checkOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("checkOk").op(0x5b, 0x56);
  asm.label("funcOwner").op(0x5b);
  asm.push1(guardSlot).op(0x54);
  asm.op(0x73, ...mask, 0x16, 0x90, 0x56);
  asm.label("funcSender").op(0x5b);
  asm.op(0x33, 0x90, 0x56);
  asm.label("end").op(0x5b, 0xfe);
  return asm.build();
}

export function listedNotExemptBlacklistTokenHex(): string {
  const asm = new Asm();
  scan3Dispatcher(asm, [
    [TRANSFER_SELECTOR, "transferEntry"],
    [SCAN3_SET, "setEntry"],
    [SCAN3_CLEAR, "exemptEntry"],
  ]);
  asm.label("transferEntry").op(0x5b);
  asm.pushLabel2("tAfter");
  asm.pushLabel2("gate");
  asm.op(0x56);
  asm.label("tAfter").op(0x5b);
  asm.op(0x35).push1(0x02).op(0x55, 0x00);
  asm.label("gate").op(0x5b);
  scan3MappingLoad(asm, 7);
  asm.op(0x15);
  asm.pushLabel2("gOk").op(0x57);
  scan3MappingLoad(asm, 8);
  asm.pushLabel2("gOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("gOk").op(0x5b);
  asm.op(0x56);
  asm.label("setEntry").op(0x5b);
  scan3OwnerGuard(asm, "setOk", "setBlocked");
  scan3MappingWrite(asm, 7);
  asm.op(0x00);
  asm.label("exemptEntry").op(0x5b);
  scan3OwnerGuard(asm, "exemptOk", "exemptBlocked");
  scan3MappingWrite(asm, 8);
  asm.op(0x00);
  return asm.build();
}
