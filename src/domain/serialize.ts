// Canonical serialization: the single serialization path for analysis
// results and for the artifact checksum (A-32 point 5, K-102).
// Pure: no I/O, no clock, no randomness, no platform imports. Object keys
// sort in lexicographic order, arrays keep the caller's stable order,
// bigint values write as decimal strings, Uint8Array values write as
// 0x-prefixed lowercase hex, and numbers write in their shortest
// round-trip form. Callers pre-round probabilities with
// Probability.ofRounded and pre-sort collections on their stated key
// (signals on SignalId, evidence on selector and PcOffset) so equal
// inputs give bit-identical bytes on every platform.
export type CanonicalValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

const HEX_DIGITS = "0123456789abcdef";

function bytesToHexLower(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    out += HEX_DIGITS[(byte >> 4) & 15] ?? "0";
    out += HEX_DIGITS[byte & 15] ?? "0";
  }
  return out;
}

function serializeObject(record: { readonly [key: string]: CanonicalValue }): string {
  const keys = Object.keys(record).sort();
  let out = "{";
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i] ?? "";
    if (i > 0) {
      out += ",";
    }
    out += `${JSON.stringify(key)}:${canonicalSerialize(record[key] as CanonicalValue)}`;
  }
  out += "}";
  return out;
}

export function canonicalSerialize(value: CanonicalValue): string {
  if (value === null) {
    return "null";
  }
  if (value === true) {
    return "true";
  }
  if (value === false) {
    return "false";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`canonical JSON turns away non-finite numbers: ${value}`);
    }
    // JSON.stringify writes -0 as "0", so signed zero normalizes here.
    return JSON.stringify(value);
  }
  if (value instanceof Uint8Array) {
    return JSON.stringify(`0x${bytesToHexLower(value)}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalSerialize(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    // Arrays and Uint8Array return above, so only records reach here.
    return serializeObject(value as { readonly [key: string]: CanonicalValue });
  }
  throw new TypeError("canonical JSON turns away undefined, functions and symbols");
}

// Stable sort on the caller's stated key with insertion-order ties.
// Returns a new frozen array and leaves the input untouched.
export function sortedBy<T>(items: readonly T[], key: (item: T) => string): readonly T[] {
  const copy = items.slice();
  copy.sort((left, right) => {
    const leftKey = key(left);
    const rightKey = key(right);
    if (leftKey < rightKey) {
      return -1;
    }
    if (leftKey > rightKey) {
      return 1;
    }
    return 0;
  });
  return Object.freeze(copy);
}

// Fixed UTF-8 encoding of the canonical text (A-32 point 5).
export function encodeUtf8(text: string): Uint8Array {
  const codes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let point = text.charCodeAt(i) ?? 0;
    if (point >= 0xd800 && point <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1) ?? 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        point = 0x10000 + ((point - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }
    if (point < 0x80) {
      codes.push(point);
    } else if (point < 0x800) {
      codes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    } else if (point < 0x10000) {
      codes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    } else {
      codes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      );
    }
  }
  return Uint8Array.from(codes);
}

export function canonicalBytes(value: CanonicalValue): Uint8Array {
  return encodeUtf8(canonicalSerialize(value));
}

// Pure SHA-256 over bytes for the artifact checksum path (A-20).
// Standard constants; all lanes stay in unsigned 32-bit arithmetic.
const SHA256_K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function sha256Blocks(padded: Uint8Array): Uint8Array {
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const schedule = new Array<number>(64).fill(0);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i += 1) {
      const offset = block + i * 4;
      schedule[i] =
        ((padded[offset] ?? 0) * 0x1000000 +
          ((padded[offset + 1] ?? 0) << 16) +
          ((padded[offset + 2] ?? 0) << 8) +
          (padded[offset + 3] ?? 0)) |
        0;
    }
    for (let i = 16; i < 64; i += 1) {
      const x = schedule[i - 15] ?? 0;
      const y = schedule[i - 2] ?? 0;
      const s0 =
        ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 =
        ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      schedule[i] = ((schedule[i - 16] ?? 0) + s0 + (schedule[i - 7] ?? 0) + s1) | 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i += 1) {
      const bigS1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + bigS1 + ch + (SHA256_K[i] ?? 0) + (schedule[i] ?? 0)) | 0;
      const bigS0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (bigS0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  const out = new Uint8Array(32);
  const words = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] ?? 0;
    out[i * 4] = (word >>> 24) & 0xff;
    out[i * 4 + 1] = (word >>> 16) & 0xff;
    out[i * 4 + 2] = (word >>> 8) & 0xff;
    out[i * 4 + 3] = word & 0xff;
  }
  return out;
}

// Exact-model-input cache key (C-20, F-20): the feature label plus the
// SHA-256 of the canonical bytes of the full serialized model input, so
// any change in owner/state meanings, evidence, lines or file misses
// instead of serving another address's narrative.
export function modelInputKey(feature: string, parts: CanonicalValue): string {
  return `${feature}|${sha256Hex(canonicalBytes(parts))}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  const bitLength = bytes.length * 8;
  const withOne = bytes.length + 1;
  const paddedLength = Math.ceil((withOne + 8) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes, 0);
  padded[bytes.length] = 0x80;
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  padded[paddedLength - 8] = (high >>> 24) & 0xff;
  padded[paddedLength - 7] = (high >>> 16) & 0xff;
  padded[paddedLength - 6] = (high >>> 8) & 0xff;
  padded[paddedLength - 5] = high & 0xff;
  padded[paddedLength - 4] = (low >>> 24) & 0xff;
  padded[paddedLength - 3] = (low >>> 16) & 0xff;
  padded[paddedLength - 2] = (low >>> 8) & 0xff;
  padded[paddedLength - 1] = low & 0xff;
  return bytesToHexLower(sha256Blocks(padded));
}
