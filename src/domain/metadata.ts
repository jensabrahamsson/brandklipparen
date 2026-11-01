// Shared Solidity CBOR metadata footer handling (K-009, K-017, F-3/C-9).
// Runtime bytecode may end with a metadata section: a CBOR blob followed by
// a two-byte big-endian blob length (public Solidity metadata format). The
// blob length varies by compiler version and settings, and some bytecode
// carries no metadata at all. This module is the single place that detects
// the footer; CodeHash, SkeletonHash and selector extraction share it, so a
// new compiler layout is handled in one place. Pure: reads bytes only and
// returns either a prefix view of the input or the input itself.
//
// Strictness (F-3, part 1): the blob must parse as a definite CBOR map with
// header 0xa1-0xa5, text keys from the compiler's key set
// {ipfs, bzzr0, bzzr1, solc, experimental}, values that consume exactly the
// blob length, and no trailing bytes. A forged tail that merely starts with
// a map-looking byte is not cut, so it stays visible to every analysis.
// The cut is additionally refused when the code references bytes at or past
// it: any PUSH1-PUSH4 jump destination (the instruction before a JUMP or
// JUMPI, which covers every paired dispatcher target) or any PUSH1-PUSH4
// constant naming a JUMPDEST at or past the cut keeps the full bytecode.
// Real compiler output never jumps into its own metadata, so real solc
// 0.4/0.8 footers keep their cut while a forged footer hiding code does
// not. Failing closed: when in doubt the full code is analysed, never less.
const FOOTER_KEYS: ReadonlySet<string> = new Set([
  "ipfs",
  "bzzr0",
  "bzzr1",
  "solc",
  "experimental",
]);

type CborHead = {
  readonly major: number;
  readonly info: number;
  readonly value: number;
  readonly next: number;
};

// One CBOR initial byte plus its definite length at [pos, end).
// Returns null for indefinite lengths (0x1f), reserved additional info
// (28-30) and any overrun. Eight-byte lengths (0x1b) are rejected: no
// metadata blob fits them and accepting them risks overflow.
function readHead(code: Uint8Array, pos: number, end: number): CborHead | null {
  if (pos >= end) {
    return null;
  }
  const initial = code[pos] ?? 0;
  const major = initial >> 5;
  const info = initial & 0x1f;
  if (info < 24) {
    return { major, info, value: info, next: pos + 1 };
  }
  if (info === 24) {
    if (pos + 1 >= end) {
      return null;
    }
    return { major, info, value: code[pos + 1] ?? 0, next: pos + 2 };
  }
  if (info === 25) {
    if (pos + 2 >= end) {
      return null;
    }
    return {
      major,
      info,
      value: ((code[pos + 1] ?? 0) * 256) + (code[pos + 2] ?? 0),
      next: pos + 3,
    };
  }
  if (info === 26) {
    if (pos + 4 >= end) {
      return null;
    }
    let value = 0;
    for (let index = 1; index <= 4; index += 1) {
      value = value * 256 + (code[pos + index] ?? 0);
    }
    return { major, info, value, next: pos + 5 };
  }
  return null;
}

// End offset of the CBOR value starting at pos, or -1 when it is not one
// of the flat definite shapes compiler metadata uses: unsigned integers,
// byte strings, text strings and single-byte simple values (false, true,
// null). Nested maps, arrays, tags, floats and multi-byte simple values
// never appear in solc metadata and are rejected.
function skipValue(code: Uint8Array, pos: number, end: number): number {
  const head = readHead(code, pos, end);
  if (head === null) {
    return -1;
  }
  if (head.major === 0) {
    return head.next;
  }
  if (head.major === 2 || head.major === 3) {
    if (head.value < 0 || head.value > end - head.next) {
      return -1;
    }
    return head.next + head.value;
  }
  if (head.major === 7 && head.info < 24) {
    return head.next;
  }
  return -1;
}

// Start offset of a strictly valid CBOR metadata blob, or null when the
// tail is not one. The two-byte suffix names the blob length; the blob
// must be a definite map of 1-5 pairs with known text keys (each once)
// and values consuming exactly the blob bytes.
export function strictCborFooterStart(code: Uint8Array): number | null {
  const total = code.length;
  if (total < 3) {
    return null;
  }
  const blobLength = (code[total - 2] ?? 0) * 256 + (code[total - 1] ?? 0);
  if (blobLength <= 0 || blobLength + 2 > total) {
    return null;
  }
  const start = total - 2 - blobLength;
  const end = total - 2;
  const header = code[start] ?? 0;
  if (header < 0xa1 || header > 0xa5) {
    return null;
  }
  const pairs = header - 0xa0;
  let pos = start + 1;
  const seen = new Set<string>();
  for (let index = 0; index < pairs; index += 1) {
    const keyHead = readHead(code, pos, end);
    if (keyHead === null || keyHead.major !== 3) {
      return null;
    }
    if (keyHead.value < 0 || keyHead.value > end - keyHead.next) {
      return null;
    }
    const keyBytes = code.slice(keyHead.next, keyHead.next + keyHead.value);
    let key = "";
    for (const byte of keyBytes) {
      if (byte < 0x20 || byte > 0x7e) {
        return null;
      }
      key += String.fromCharCode(byte);
    }
    if (!FOOTER_KEYS.has(key) || seen.has(key)) {
      return null;
    }
    seen.add(key);
    const valueEnd = skipValue(code, keyHead.next + keyHead.value, end);
    if (valueEnd < 0) {
      return null;
    }
    pos = valueEnd;
  }
  if (pos !== end) {
    return null;
  }
  return start;
}

type SweptInstruction = {
  readonly pc: number;
  readonly opcode: number;
  readonly immStart: number;
  readonly immLen: number;
  readonly complete: boolean;
};

// Minimal sweep over the full code: PUSH data bytes are skipped so data
// never decodes as opcodes, matching the disassembler in ./selectors.ts.
// A truncated trailing PUSH ends the sweep; it is marked incomplete and
// never counts as a constant.
function sweepAll(code: Uint8Array): SweptInstruction[] {
  const out: SweptInstruction[] = [];
  const end = code.length;
  let pc = 0;
  while (pc < end) {
    const opcode = code[pc] ?? 0;
    if (opcode >= 0x60 && opcode <= 0x7f) {
      const width = opcode - 0x5f;
      const available = Math.min(width, end - pc - 1);
      out.push({
        pc,
        opcode,
        immStart: pc + 1,
        immLen: available,
        complete: available === width,
      });
      pc += 1 + available;
    } else {
      out.push({ pc, opcode, immStart: pc + 1, immLen: 0, complete: true });
      pc += 1;
    }
  }
  return out;
}

// Whether cutting the footer at start hides no referenced code. The cut is
// refused when a complete PUSH1-PUSH4 constant at or past start is either
// the proven target of a JUMP/JUMPI (the instruction right before it,
// which covers every paired dispatcher target) or names a JUMPDEST
// instruction there (a return address or handler the tail defines).
function cutIsSafe(code: Uint8Array, start: number): boolean {
  const total = code.length;
  const instructions = sweepAll(code);
  const jumpdests = new Set<number>();
  for (const instruction of instructions) {
    if (instruction.opcode === 0x5b) {
      jumpdests.add(instruction.pc);
    }
  }
  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index];
    if (
      instruction === undefined ||
      instruction.opcode < 0x60 ||
      instruction.opcode > 0x63 ||
      !instruction.complete
    ) {
      continue;
    }
    let value = 0;
    for (let offset = 0; offset < instruction.immLen; offset += 1) {
      value = value * 256 + (code[instruction.immStart + offset] ?? 0);
    }
    if (value < start || value >= total) {
      continue;
    }
    const next = instructions[index + 1];
    if (next !== undefined && (next.opcode === 0x56 || next.opcode === 0x57)) {
      return false;
    }
    if (jumpdests.has(value)) {
      return false;
    }
  }
  return true;
}

// Executable prefix length: the strict footer start when a valid footer is
// present and no code references bytes at or past it, else the full
// length. Every consumer (disassembly, SkeletonHash) shares this rule.
export function executableEnd(code: Uint8Array): number {
  const start = strictCborFooterStart(code);
  if (start === null) {
    return code.length;
  }
  return cutIsSafe(code, start) ? start : code.length;
}

export function stripCborFooter(code: Uint8Array): Uint8Array {
  return code.slice(0, executableEnd(code));
}

// True when the bytecode carries a strictly valid metadata-shaped region
// with referenced code at or past it, so the cut was refused and the tail
// is analysed as code. Callers map this to the `obfuscated-structure`
// cause: a forged footer hiding real code.
export function hasCodeAfterMetadata(code: Uint8Array): boolean {
  const start = strictCborFooterStart(code);
  return start !== null && !cutIsSafe(code, start);
}
