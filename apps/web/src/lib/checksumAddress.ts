// EIP-55 checksummed addresses with no new dependency: a small pure
// Keccak-256 over the lowercase hex address, then per-character casing
// from the hash nibbles. Display and copy use this; stored data, URLs,
// routing keys and API calls keep the original string.
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

const MASK64 = (1n << 64n) - 1n;

// Rotation offsets r[x][y] flattened as lane index x + 5 * y.
const RHO_OFFSETS = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];

const ROUND_CONSTANTS = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];

function rotl64(value: bigint, shift: number): bigint {
  const normalized = shift % 64;
  if (normalized === 0) {
    return value & MASK64;
  }
  return ((value << BigInt(normalized)) | (value >> BigInt(64 - normalized))) & MASK64;
}

function keccakF1600(state: bigint[]): void {
  for (let round = 0; round < 24; round += 1) {
    const columns = [0n, 0n, 0n, 0n, 0n];
    for (let x = 0; x < 5; x += 1) {
      columns[x] =
        ((state[x] ?? 0n) ^ (state[x + 5] ?? 0n) ^ (state[x + 10] ?? 0n) ^ (state[x + 15] ?? 0n) ^ (state[x + 20] ?? 0n)) &
        MASK64;
    }
    for (let x = 0; x < 5; x += 1) {
      const lane = ((columns[(x + 4) % 5] ?? 0n) ^ rotl64(columns[(x + 1) % 5] ?? 0n, 1)) & MASK64;
      for (let y = 0; y < 5; y += 1) {
        state[x + 5 * y] = ((state[x + 5 * y] ?? 0n) ^ lane) & MASK64;
      }
    }
    const next = new Array<bigint>(25).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const lane = x + 5 * y;
        const rotated = rotl64(state[lane] ?? 0n, RHO_OFFSETS[lane] ?? 0);
        const target = y + 5 * ((2 * x + 3 * y) % 5);
        next[target] = rotated;
      }
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const lane = x + 5 * y;
        const left = next[lane] ?? 0n;
        const middle = next[((x + 1) % 5) + 5 * y] ?? 0n;
        const right = next[((x + 2) % 5) + 5 * y] ?? 0n;
        state[lane] = (left ^ ((~middle & MASK64) & right)) & MASK64;
      }
    }
    state[0] = ((state[0] ?? 0n) ^ (ROUND_CONSTANTS[round] ?? 0n)) & MASK64;
  }
}

// Keccak-256 (original padding with domain byte 0x01) of an ASCII
// string, returned as lowercase hex. Only ASCII input is supported:
// every caller here hashes lowercase hex addresses.
export function keccak256Hex(message: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < message.length; index += 1) {
    bytes.push(message.charCodeAt(index) & 0xff);
  }
  const rate = 136;
  const paddedLength = Math.floor(bytes.length / rate) * rate + rate;
  const padded = new Array<number>(paddedLength).fill(0);
  for (let index = 0; index < bytes.length; index += 1) {
    padded[index] = bytes[index] ?? 0;
  }
  padded[bytes.length] = 0x01;
  padded[paddedLength - 1] = (padded[paddedLength - 1] ?? 0) | 0x80;
  const state = new Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < paddedLength; offset += rate) {
    for (let lane = 0; lane < 17; lane += 1) {
      let word = 0n;
      for (let byte = 0; byte < 8; byte += 1) {
        word |= BigInt(padded[offset + lane * 8 + byte] ?? 0) << BigInt(8 * byte);
      }
      state[lane] = ((state[lane] ?? 0n) ^ word) & MASK64;
    }
    keccakF1600(state);
  }
  let hex = "";
  for (let lane = 0; lane < 4; lane += 1) {
    const word = state[lane] ?? 0n;
    for (let byte = 0; byte < 8; byte += 1) {
      hex += ((word >> BigInt(8 * byte)) & 0xffn).toString(16).padStart(2, "0");
    }
  }
  return hex;
}

// EIP-55 mixed-case encoding of an address. Input that is not a plain
// 0x address passes through unchanged, so labels and code hashes that
// share a copy row never get mangled.
export function toChecksumAddress(address: string): string {
  if (!ADDRESS_PATTERN.test(address)) {
    return address;
  }
  const lower = address.slice(2).toLowerCase();
  const hash = keccak256Hex(lower);
  let checksummed = "0x";
  for (let index = 0; index < lower.length; index += 1) {
    const char = lower[index] ?? "";
    const nibble = Number.parseInt(hash[index] ?? "0", 16);
    checksummed += nibble >= 8 ? char.toUpperCase() : char;
  }
  return checksummed;
}
