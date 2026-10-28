// Selector and pattern extraction in the fast path (K-009, S-012).
// Pure domain module: the disassembler and the dispatcher scan are total
// functions of the bytecode and never throw. No thresholds, weights or
// signature tables live here; each reported selector is either paired with
// its jump-target PC offset or explicitly marked unknown (A-15).
import { stripCborFooter } from "./metadata.ts";
import { PcOffset, Selector } from "./types.ts";
import type { Bytecode, PcOffset as PcOffsetType, Selector as SelectorType } from "./types.ts";

const HEX_DIGITS = "0123456789abcdef";

function byteToHex(byte: number): string {
  return `${HEX_DIGITS[(byte >> 4) & 15] ?? "0"}${HEX_DIGITS[byte & 15] ?? "0"}`;
}

// Opcode mnemonics from the public EVM specification. PUSH1..PUSH32 are
// 0x60..0x7f, DUP1..DUP16 are 0x80..0x8f, SWAP1..SWAP16 are 0x90..0x9f,
// LOG0..LOG4 are 0xa0..0xa4; every other undefined byte decodes as
// UNDEFINED and never breaks the sweep.
function buildOpcodeNames(): readonly string[] {
  const names = new Array<string>(256).fill("UNDEFINED");
  names[0x00] = "STOP";
  names[0x01] = "ADD";
  names[0x02] = "MUL";
  names[0x03] = "SUB";
  names[0x04] = "DIV";
  names[0x05] = "SDIV";
  names[0x06] = "MOD";
  names[0x07] = "SMOD";
  names[0x08] = "ADDMOD";
  names[0x09] = "MULMOD";
  names[0x0a] = "EXP";
  names[0x0b] = "SIGNEXTEND";
  names[0x10] = "LT";
  names[0x11] = "GT";
  names[0x12] = "SLT";
  names[0x13] = "SGT";
  names[0x14] = "EQ";
  names[0x15] = "ISZERO";
  names[0x16] = "AND";
  names[0x17] = "OR";
  names[0x18] = "XOR";
  names[0x19] = "NOT";
  names[0x1a] = "BYTE";
  names[0x1b] = "SHL";
  names[0x1c] = "SHR";
  names[0x1d] = "SAR";
  names[0x20] = "KECCAK256";
  names[0x30] = "ADDRESS";
  names[0x31] = "BALANCE";
  names[0x32] = "ORIGIN";
  names[0x33] = "CALLER";
  names[0x34] = "CALLVALUE";
  names[0x35] = "CALLDATALOAD";
  names[0x36] = "CALLDATASIZE";
  names[0x37] = "CALLDATACOPY";
  names[0x38] = "CODESIZE";
  names[0x39] = "CODECOPY";
  names[0x3a] = "GASPRICE";
  names[0x3b] = "EXTCODESIZE";
  names[0x3c] = "EXTCODECOPY";
  names[0x3d] = "RETURNDATASIZE";
  names[0x3e] = "RETURNDATACOPY";
  names[0x3f] = "EXTCODEHASH";
  names[0x40] = "BLOCKHASH";
  names[0x41] = "COINBASE";
  names[0x42] = "TIMESTAMP";
  names[0x43] = "NUMBER";
  names[0x44] = "PREVRANDAO";
  names[0x45] = "GASLIMIT";
  names[0x46] = "CHAINID";
  names[0x47] = "SELFBALANCE";
  names[0x48] = "BASEFEE";
  names[0x49] = "BLOBHASH";
  names[0x4a] = "BLOBBASEFEE";
  names[0x50] = "POP";
  names[0x51] = "MLOAD";
  names[0x52] = "MSTORE";
  names[0x53] = "MSTORE8";
  names[0x54] = "SLOAD";
  names[0x55] = "SSTORE";
  names[0x56] = "JUMP";
  names[0x57] = "JUMPI";
  names[0x58] = "PC";
  names[0x59] = "MSIZE";
  names[0x5a] = "GAS";
  names[0x5b] = "JUMPDEST";
  names[0x5c] = "TLOAD";
  names[0x5d] = "TSTORE";
  names[0x5e] = "MCOPY";
  names[0x5f] = "PUSH0";
  for (let n = 1; n <= 32; n += 1) {
    names[0x5f + n] = `PUSH${n}`;
  }
  for (let n = 1; n <= 16; n += 1) {
    names[0x7f + n] = `DUP${n}`;
    names[0x8f + n] = `SWAP${n}`;
  }
  for (let n = 0; n <= 4; n += 1) {
    names[0xa0 + n] = `LOG${n}`;
  }
  names[0xf0] = "CREATE";
  names[0xf1] = "CALL";
  names[0xf2] = "CALLCODE";
  names[0xf3] = "RETURN";
  names[0xf4] = "DELEGATECALL";
  names[0xf5] = "CREATE2";
  names[0xfa] = "STATICCALL";
  names[0xfd] = "REVERT";
  names[0xfe] = "INVALID";
  names[0xff] = "SELFDESTRUCT";
  return names;
}

const OPCODE_NAMES: readonly string[] = buildOpcodeNames();

export function opcodeName(opcode: number): string {
  return OPCODE_NAMES[opcode & 0xff] ?? "UNDEFINED";
}

// Linear sweep over the executable prefix: the CBOR metadata footer is cut
// through the shared helper in ./metadata.ts, the same rule behind CodeHash
// and SkeletonHash. Bytes after an INVALID marker are still swept linearly;
// only the footer region is cut, so alignment can never throw the scan.

export type Instruction = {
  readonly pc: number;
  readonly opcode: number;
  readonly name: string;
  readonly immediate: Uint8Array;
};

// Linear sweep over the executable prefix. PUSH data bytes are skipped,
// so data never decodes as opcodes. A truncated trailing PUSH takes the
// bytes that remain and ends the sweep; the sweep never throws.
export function disassemble(bytecode: Bytecode): readonly Instruction[] {
  const executable = stripCborFooter(bytecode);
  const end = executable.length;
  const out: Instruction[] = [];
  let pc = 0;
  while (pc < end) {
    const opcode = executable[pc] ?? 0;
    if (opcode >= 0x60 && opcode <= 0x7f) {
      const width = opcode - 0x5f;
      const available = Math.min(width, end - pc - 1);
      const immediate = executable.slice(pc + 1, pc + 1 + available);
      out.push({ pc, opcode, name: opcodeName(opcode), immediate });
      pc += 1 + available;
    } else {
      out.push({ pc, opcode, name: opcodeName(opcode), immediate: new Uint8Array(0) });
      pc += 1;
    }
  }
  return out;
}

// One extracted dispatcher entry: either paired with the jump-target PC
// offset read from the pattern, or explicitly marked unknown when the
// pattern carries no usable in-range destination.
export type SelectorEntry =
  | { kind: "paired"; selector: SelectorType; target: PcOffsetType }
  | { kind: "unknown"; selector: SelectorType };

// Big-endian value of a PUSH immediate, or null when it reaches past the
// end of the bytecode. The running total stays below the bytecode length
// until the cutoff, so the accumulation cannot overflow.
function pushValueBelow(immediate: Uint8Array, limit: number): number | null {
  let value = 0;
  for (let i = 0; i < immediate.length; i += 1) {
    value = value * 256 + (immediate[i] ?? 0);
    if (value >= limit) {
      return null;
    }
  }
  return value;
}

// Dispatcher windows, matched on the linear instruction stream where PUSH
// data is already skipped:
//   A: DUP1 PUSH4 <selector> EQ PUSHn <destination> JUMPI
//   B: PUSH4 <selector> DUP2 EQ PUSHn <destination> JUMPI
// A PUSH4 beside EQ without a following PUSH plus JUMPI still reports the
// selector, with the target explicitly marked unknown. Repeated selectors
// keep their first occurrence in PC order; the result sorts by selector.
export function extractSelectors(bytecode: Bytecode): readonly SelectorEntry[] {
  const code = disassemble(bytecode);
  const found: SelectorEntry[] = [];
  const seen = new Set<string>();

  const record = (selectorBytes: Uint8Array, target: PcOffsetType | null): void => {
    let text = "0x";
    for (let i = 0; i < selectorBytes.length; i += 1) {
      text += byteToHex(selectorBytes[i] ?? 0);
    }
    if (seen.has(text)) {
      return;
    }
    const parsed = Selector.parse(text);
    if (!parsed.ok) {
      return;
    }
    seen.add(text);
    if (target === null) {
      found.push({ kind: "unknown", selector: parsed.value });
    } else {
      found.push({ kind: "paired", selector: parsed.value, target });
    }
  };

  const handleCandidate = (selectorBytes: Uint8Array, nextIndex: number): void => {
    const dest = code[nextIndex];
    const jump = code[nextIndex + 1];
    if (
      dest !== undefined &&
      jump !== undefined &&
      jump.opcode === 0x57 &&
      dest.opcode >= 0x60 &&
      dest.opcode <= 0x7f
    ) {
      const value = pushValueBelow(dest.immediate, bytecode.length);
      if (value !== null) {
        const offset = PcOffset.of(value, bytecode);
        if (offset.ok) {
          record(selectorBytes, offset.value);
          return;
        }
      }
    }
    record(selectorBytes, null);
  };

  for (let i = 0; i < code.length; i += 1) {
    const first = code[i];
    if (first === undefined) {
      continue;
    }
    if (first.opcode === 0x80) {
      const push = code[i + 1];
      const eq = code[i + 2];
      if (
        push !== undefined &&
        eq !== undefined &&
        push.opcode === 0x63 &&
        push.immediate.length === 4 &&
        eq.opcode === 0x14
      ) {
        handleCandidate(push.immediate, i + 3);
      }
    } else if (first.opcode === 0x63 && first.immediate.length === 4) {
      const dup = code[i + 1];
      const eq = code[i + 2];
      if (dup !== undefined && eq !== undefined && dup.opcode === 0x81 && eq.opcode === 0x14) {
        handleCandidate(first.immediate, i + 3);
      }
    }
  }

  found.sort((left, right) => {
    const a = left.selector as string;
    const b = right.selector as string;
    if (a < b) {
      return -1;
    }
    if (a > b) {
      return 1;
    }
    return 0;
  });
  return found;
}

// Attribute one occurrence PC to the dispatcher function holding it: the
// paired entry with the greatest jump target at or below the PC. Function
// bodies follow their entry points in order, so an occurrence belongs to
// the last function entered at or before it. Returns null when no paired
// entry sits at or below the PC (dispatcher preamble or selector-less
// code): the caller keeps its own fallback so every occurrence still
// carries an offset beside a selector.
export function containingSelector(
  entries: readonly SelectorEntry[],
  pc: number,
): SelectorType | null {
  let holder: SelectorType | null = null;
  let best = -1;
  for (const entry of entries) {
    if (entry.kind !== "paired") {
      continue;
    }
    const target = entry.target as number;
    if (target <= pc && target > best) {
      best = target;
      holder = entry.selector;
    }
  }
  return holder;
}
