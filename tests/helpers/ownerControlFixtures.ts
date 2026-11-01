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
