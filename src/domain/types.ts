// Branded domain types with smart constructors (A-10, A-11).
// Every concept in the core is a nominal type. The constructor object next to
// each type is the single entry path and returns Result, never throws.
// Values are immutable by value (primitives) or freshly allocated on every
// parse (byte arrays), so construction never shares mutable state.
import { stripCborFooter } from "./metadata.ts";
import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";

// Broken invariant at construction (A-15). One branch per branded type so a
// new type forces an explicit branch at every exhaustive switch.
export type DomainError =
  | { kind: "invalid-address"; message: string }
  | { kind: "invalid-bytecode"; message: string }
  | { kind: "invalid-code-hash"; message: string }
  | { kind: "invalid-skeleton-hash"; message: string }
  | { kind: "invalid-selector"; message: string }
  | { kind: "invalid-pc-offset"; message: string }
  | { kind: "invalid-slot"; message: string }
  | { kind: "invalid-call-data"; message: string }
  | { kind: "invalid-storage-word"; message: string }
  | { kind: "invalid-probability"; message: string }
  | { kind: "invalid-risk-score"; message: string }
  | { kind: "invalid-chain-id"; message: string }
  | { kind: "invalid-block-number"; message: string }
  | { kind: "invalid-model-version"; message: string }
  | { kind: "invalid-index-version"; message: string }
  | { kind: "invalid-template-version"; message: string }
  | { kind: "invalid-prompt-version"; message: string }
  | { kind: "invalid-model-id"; message: string }
  | { kind: "invalid-explanation-schema-version"; message: string }
  | { kind: "invalid-artifact-checksum"; message: string }
  | { kind: "invalid-request-id"; message: string }
  | { kind: "invalid-evidence-id"; message: string }
  | { kind: "invalid-timestamp"; message: string }
  | { kind: "invalid-untrusted-text"; message: string }
  | { kind: "invalid-signal-id"; message: string }
  | { kind: "invalid-evidence"; message: string }
  | { kind: "invalid-signal"; message: string }
  | { kind: "invalid-code-snippet"; message: string }
  | { kind: "invalid-cant-tell"; message: string }
  | { kind: "invalid-clone-group-id"; message: string }
  | { kind: "invalid-cache-key"; message: string }
  | { kind: "invalid-page-size"; message: string }
  | { kind: "invalid-model-artifact"; message: string };

// Placeholder operational limits (A-17). The running boundary passes the
// versioned values from the operational configuration; these defaults keep
// single-argument constructor calls well-formed in tests and offline use.
export const DEFAULT_MAX_BYTECODE_BYTES = 24576;
export const DEFAULT_MAX_UNTRUSTED_TEXT_CHARS = 10000;
export const DEFAULT_MAX_PAGE_SIZE = 100;
// Fixed storage precision for probabilities (A-32 point 6).
export const PROBABILITY_DECIMALS = 6;

function isHexChars(text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const isDigit = code >= 48 && code <= 57;
    const isLower = code >= 97 && code <= 102;
    const isUpper = code >= 65 && code <= 70;
    if (!isDigit && !isLower && !isUpper) {
      return false;
    }
  }
  return true;
}

function strip0x(raw: string): string | null {
  if (raw.startsWith("0x") || raw.startsWith("0X")) {
    return raw.slice(2);
  }
  return null;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const HEX_DIGITS = "0123456789abcdef";

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    out += HEX_DIGITS[(byte >> 4) & 15] ?? "0";
    out += HEX_DIGITS[byte & 15] ?? "0";
  }
  return out;
}

function utf8Encode(text: string): Uint8Array {
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

// Pure Keccak-256 (Ethereum variant, suffix 0x01) with no platform imports.
// BigInt keeps the 64-bit lanes exact on every platform (A-32).
const MASK_64 = (1n << 64n) - 1n;

function rotl64(value: bigint, shift: bigint): bigint {
  const normalized = shift % 64n;
  if (normalized === 0n) {
    return value & MASK_64;
  }
  return ((value << normalized) | (value >> (64n - normalized))) & MASK_64;
}

const KECCAK_ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const KECCAK_ROTATIONS: readonly (readonly number[])[] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function keccakF1600(state: bigint[]): void {
  const next = new Array<bigint>(25).fill(0n);
  for (let round = 0; round < 24; round += 1) {
    const col = new Array<bigint>(5).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      col[x] =
        (state[x] ?? 0n) ^ (state[x + 5] ?? 0n) ^ (state[x + 10] ?? 0n) ^
        (state[x + 15] ?? 0n) ^ (state[x + 20] ?? 0n);
    }
    const diag = new Array<bigint>(5).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      diag[x] = (col[(x + 4) % 5] ?? 0n) ^ rotl64(col[(x + 1) % 5] ?? 0n, 1n);
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        state[x + 5 * y] = (state[x + 5 * y] ?? 0n) ^ (diag[x] ?? 0n);
      }
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const rotation = KECCAK_ROTATIONS[x]?.[y] ?? 0;
        const target = y + 5 * ((2 * x + 3 * y) % 5);
        next[target] = rotl64(state[x + 5 * y] ?? 0n, BigInt(rotation));
      }
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const base = x + 5 * y;
        const low = (base + 1) % 5 + 5 * y;
        const high = (base + 2) % 5 + 5 * y;
        state[base] =
          (next[base] ?? 0n) ^ ((MASK_64 ^ (next[low] ?? 0n)) & (next[high] ?? 0n));
      }
    }
    state[0] = (state[0] ?? 0n) ^ (KECCAK_ROUND_CONSTANTS[round] ?? 0n);
  }
}

function keccak256Bytes(input: Uint8Array): Uint8Array {
  const rate = 136;
  const blocks = Math.max(1, Math.ceil((input.length + 1) / rate));
  const padded = new Uint8Array(blocks * rate);
  padded.set(input, 0);
  padded[input.length] = 0x01;
  padded[padded.length - 1] = (padded[padded.length - 1] ?? 0) | 0x80;
  const state = new Array<bigint>(25).fill(0n);
  for (let block = 0; block < blocks; block += 1) {
    for (let lane = 0; lane < rate / 8; lane += 1) {
      let word = 0n;
      for (let byte = 0; byte < 8; byte += 1) {
        word |= BigInt(padded[block * rate + lane * 8 + byte] ?? 0) << BigInt(byte * 8);
      }
      state[lane] = (state[lane] ?? 0n) ^ word;
    }
    keccakF1600(state);
  }
  const out = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane += 1) {
    const word = state[lane] ?? 0n;
    for (let byte = 0; byte < 8; byte += 1) {
      out[lane * 8 + byte] = Number((word >> BigInt(byte * 8)) & 0xffn);
    }
  }
  return out;
}

function keccak256Hex(input: Uint8Array): string {
  return `0x${bytesToHex(keccak256Bytes(input))}`;
}

// Keccak-256 over the UTF-8 bytes of a text label, 0x-prefixed lowercase.
// Pure helper for spec-formula derivations such as the proxy storage slots:
// tests recompute the expected slots through this function, so the slot
// values are derived from the formula rather than copied from elsewhere.
export function keccak256HexOfUtf8(text: string): string {
  return keccak256Hex(utf8Encode(text));
}

// 0x followed by 40 hex characters, stored in EIP-55 checksummed form.
export type Address = string & { readonly __brand: "Address" };
export const Address = {
  parse(raw: string): Result<Address, DomainError> {
    const body = strip0x(raw);
    if (body === null || body.length !== 40 || !isHexChars(body)) {
      return err({ kind: "invalid-address", message: `address must be 0x plus 40 hex characters: ${raw}` });
    }
    const lower = body.toLowerCase();
    const hashHex = bytesToHex(keccak256Bytes(utf8Encode(lower)));
    let checksummed = "0x";
    for (let i = 0; i < 40; i += 1) {
      const char = lower[i] ?? "";
      const nibble = parseInt(hashHex[i] ?? "0", 16);
      checksummed += nibble >= 8 ? char.toUpperCase() : char;
    }
    return ok(checksummed as Address);
  },
};

// Even hex length; length at most the operational limit (A-17). A fresh
// array is allocated on every parse, so values never share mutable bytes.
// Object.freeze is deliberately not used: it throws on typed arrays.
export type Bytecode = Uint8Array & { readonly __brand: "Bytecode" };
export const Bytecode = {
  parse(raw: string, maxBytes: number = DEFAULT_MAX_BYTECODE_BYTES): Result<Bytecode, DomainError> {
    const withoutPrefix = strip0x(raw);
    const hex = withoutPrefix === null ? raw : withoutPrefix;
    if (raw.length === 0 || hex.length % 2 !== 0 || (hex.length > 0 && !isHexChars(hex))) {
      return err({ kind: "invalid-bytecode", message: `bytecode must be an even-length hex string: ${raw}` });
    }
    const bytes = hexToBytes(hex);
    if (bytes.length > maxBytes) {
      return err({ kind: "invalid-bytecode", message: `bytecode holds ${bytes.length} bytes, above the limit of ${maxBytes}` });
    }
    return ok(bytes as Bytecode);
  },
};

// keccak256 of the full runtime bytecode, footer included. The cache key
// derives from this hash, so two deployments that differ only in a
// trailing blob never share a cache entry: a tail shaped like CBOR
// metadata can still carry reachable jump targets at runtime, so stripping
// it from the cache identity would let a poisoned variant inherit a clean
// score. Executable-template identity stays with SkeletonHash (and selector
// extraction keeps its own footer exclusion); this hash names exact bytes.
export type CodeHash = string & { readonly __brand: "CodeHash" };
export const CodeHash = {
  of(bytecode: Bytecode): Result<CodeHash, DomainError> {
    return ok(keccak256Hex(bytecode) as CodeHash);
  },
};

// Hash over the opcode sequence of the executable prefix (CBOR metadata
// stripped through the shared footer helper) with PUSH operands masked,
// so equal templates with different parameters share one hash (glossary).
export type SkeletonHash = string & { readonly __brand: "SkeletonHash" };
export const SkeletonHash = {
  of(bytecode: Bytecode): Result<SkeletonHash, DomainError> {
    const masked = Uint8Array.from(stripCborFooter(bytecode));
    let i = 0;
    while (i < masked.length) {
      const opcode = masked[i] ?? 0;
      if (opcode >= 0x60 && opcode <= 0x7f) {
        const width = opcode - 0x5f;
        const end = Math.min(masked.length, i + 1 + width);
        masked.fill(0, i + 1, end);
        i = end;
      } else {
        i += 1;
      }
    }
    return ok(keccak256Hex(masked) as SkeletonHash);
  },
};

// Exactly 4 bytes hex (0x plus 8 hex characters).
export type Selector = string & { readonly __brand: "Selector" };
export const Selector = {
  parse(raw: string): Result<Selector, DomainError> {
    const body = strip0x(raw);
    if (body === null || body.length !== 8 || !isHexChars(body)) {
      return err({ kind: "invalid-selector", message: `selector must be 0x plus 8 hex characters: ${raw}` });
    }
    return ok(`0x${body.toLowerCase()}` as Selector);
  },
};

// Integer at least 0 and inside the bytecode length.
export type PcOffset = number & { readonly __brand: "PcOffset" };
export const PcOffset = {
  of(offset: number, bytecode: Bytecode): Result<PcOffset, DomainError> {
    if (!Number.isInteger(offset) || offset < 0 || offset >= bytecode.length) {
      return err({ kind: "invalid-pc-offset", message: `pc offset must be an integer in [0, ${bytecode.length}): ${offset}` });
    }
    return ok(offset as PcOffset);
  },
};

// Exactly 32 bytes hex (uint256), 0x prefixed and stored lowercase.
export type Slot = string & { readonly __brand: "Slot" };
export const Slot = {
  parse(raw: string): Result<Slot, DomainError> {
    const body = strip0x(raw);
    if (body === null || body.length !== 64 || !isHexChars(body)) {
      return err({ kind: "invalid-slot", message: `slot must be 0x plus 64 hex characters: ${raw}` });
    }
    return ok(`0x${body.toLowerCase()}` as Slot);
  },
};

// Even hex length; the first four bytes hold the selector when present.
export type CallData = Uint8Array & { readonly __brand: "CallData" };
export const CallData = {
  parse(raw: string): Result<CallData, DomainError> {
    const withoutPrefix = strip0x(raw);
    const hex = withoutPrefix === null ? raw : withoutPrefix;
    if (raw.length === 0 || hex.length % 2 !== 0 || (hex.length > 0 && !isHexChars(hex))) {
      return err({ kind: "invalid-call-data", message: `call data must be an even-length hex string: ${raw}` });
    }
    return ok(hexToBytes(hex) as CallData);
  },
};

// Exactly 32 bytes hex (uint256), 0x prefixed and stored lowercase.
export type StorageWord = string & { readonly __brand: "StorageWord" };
export const StorageWord = {
  parse(raw: string): Result<StorageWord, DomainError> {
    const body = strip0x(raw);
    if (body === null || body.length !== 64 || !isHexChars(body)) {
      return err({ kind: "invalid-storage-word", message: `storage word must be 0x plus 64 hex characters: ${raw}` });
    }
    return ok(`0x${body.toLowerCase()}` as StorageWord);
  },
};

// Number in [0, 1] with fixed rounding; NaN and infinities are rejected.
export type Probability = number & { readonly __brand: "Probability" };
export const Probability = {
  of(value: number): Result<Probability, DomainError> {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      return err({ kind: "invalid-probability", message: `probability must be a number in [0, 1]: ${value}` });
    }
    return ok(value as Probability);
  },
  ofRounded(value: number): Result<Probability, DomainError> {
    if (!Number.isFinite(value)) {
      return err({ kind: "invalid-probability", message: `probability must be a number in [0, 1]: ${value}` });
    }
    const factor = 10 ** PROBABILITY_DECIMALS;
    return Probability.of(Math.round(value * factor) / factor);
  },
};

// Integer in [0, 100].
export type RiskScore = number & { readonly __brand: "RiskScore" };
export const RiskScore = {
  of(value: number): Result<RiskScore, DomainError> {
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      return err({ kind: "invalid-risk-score", message: `risk score must be an integer in [0, 100]: ${value}` });
    }
    return ok(value as RiskScore);
  },
};

// Positive integer; the Ethereum mainnet value comes from the configuration.
export type ChainId = number & { readonly __brand: "ChainId" };
export const ChainId = {
  of(value: number): Result<ChainId, DomainError> {
    if (!Number.isSafeInteger(value) || value <= 0) {
      return err({ kind: "invalid-chain-id", message: `chain id must be a positive integer: ${value}` });
    }
    return ok(value as ChainId);
  },
};

// Integer at least 0.
export type BlockNumber = number & { readonly __brand: "BlockNumber" };
export const BlockNumber = {
  of(value: number): Result<BlockNumber, DomainError> {
    if (!Number.isSafeInteger(value) || value < 0) {
      return err({ kind: "invalid-block-number", message: `block number must be an integer at least 0: ${value}` });
    }
    return ok(value as BlockNumber);
  },
};

// Strict semantic versions with no leading zeros, after the semver rule.
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export type ModelVersion = string & { readonly __brand: "ModelVersion" };
export const ModelVersion = {
  parse(raw: string): Result<ModelVersion, DomainError> {
    if (!SEMVER_PATTERN.test(raw)) {
      return err({ kind: "invalid-model-version", message: `model version must be semver MAJOR.MINOR.PATCH: ${raw}` });
    }
    return ok(raw as ModelVersion);
  },
};

export type IndexVersion = string & { readonly __brand: "IndexVersion" };
export const IndexVersion = {
  parse(raw: string): Result<IndexVersion, DomainError> {
    if (!SEMVER_PATTERN.test(raw)) {
      return err({ kind: "invalid-index-version", message: `index version must be semver MAJOR.MINOR.PATCH: ${raw}` });
    }
    return ok(raw as IndexVersion);
  },
};

export type TemplateVersion = string & { readonly __brand: "TemplateVersion" };
export const TemplateVersion = {
  parse(raw: string): Result<TemplateVersion, DomainError> {
    if (!SEMVER_PATTERN.test(raw)) {
      return err({ kind: "invalid-template-version", message: `template version must be semver MAJOR.MINOR.PATCH: ${raw}` });
    }
    return ok(raw as TemplateVersion);
  },
};

export type PromptVersion = string & { readonly __brand: "PromptVersion" };
export const PromptVersion = {
  parse(raw: string): Result<PromptVersion, DomainError> {
    if (!SEMVER_PATTERN.test(raw)) {
      return err({ kind: "invalid-prompt-version", message: `prompt version must be semver MAJOR.MINOR.PATCH: ${raw}` });
    }
    return ok(raw as PromptVersion);
  },
};

export type ExplanationSchemaVersion = string & { readonly __brand: "ExplanationSchemaVersion" };
export const ExplanationSchemaVersion = {
  parse(raw: string): Result<ExplanationSchemaVersion, DomainError> {
    if (!SEMVER_PATTERN.test(raw)) {
      return err({ kind: "invalid-explanation-schema-version", message: `explanation schema version must be semver MAJOR.MINOR.PATCH: ${raw}` });
    }
    return ok(raw as ExplanationSchemaVersion);
  },
};

// Provider model identifier, for example meta-models/muse-spark-open-1026.
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,255}$/;
export type ModelId = string & { readonly __brand: "ModelId" };
export const ModelId = {
  parse(raw: string): Result<ModelId, DomainError> {
    if (!MODEL_ID_PATTERN.test(raw)) {
      return err({ kind: "invalid-model-id", message: `model id must be 1-256 identifier characters: ${raw}` });
    }
    return ok(raw as ModelId);
  },
};

// SHA-256 in hex, exactly 64 characters with no prefix.
export type ArtifactChecksum = string & { readonly __brand: "ArtifactChecksum" };
export const ArtifactChecksum = {
  parse(raw: string): Result<ArtifactChecksum, DomainError> {
    if (raw.length !== 64 || !isHexChars(raw)) {
      return err({ kind: "invalid-artifact-checksum", message: `artifact checksum must be 64 hex characters: ${raw}` });
    }
    return ok(raw as ArtifactChecksum);
  },
};

// UUID form; generated at the boundary and follows the analysis (I-10).
// Generation is a pure function of the passed-in time value, so repeated
// calls with the same value give the same id; production uniqueness relies
// on the boundary passing a fresh timestamp per request.
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export type RequestId = string & { readonly __brand: "RequestId" };
export const RequestId = {
  parse(raw: string): Result<RequestId, DomainError> {
    if (!UUID_PATTERN.test(raw)) {
      return err({ kind: "invalid-request-id", message: `request id must be UUID form: ${raw}` });
    }
    return ok(raw as RequestId);
  },
  generate(clock: Timestamp | { now(): Timestamp }): Result<RequestId, DomainError> {
    const at: Timestamp =
      typeof clock === "object" && clock !== null && "now" in clock ? clock.now() : (clock as Timestamp);
    const digest = keccak256Bytes(utf8Encode(`request-id:${at as number}`));
    digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x40;
    digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
    const hex = bytesToHex(digest.slice(0, 16));
    const raw = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
    return RequestId.parse(raw);
  },
};

// Milliseconds since epoch, integer at least 0, delivered by ClockPort.
export type Timestamp = number & { readonly __brand: "Timestamp" };
export const Timestamp = {
  of(value: number): Result<Timestamp, DomainError> {
    if (!Number.isSafeInteger(value) || value < 0) {
      return err({ kind: "invalid-timestamp", message: `timestamp must be an integer at least 0: ${value}` });
    }
    return ok(value as Timestamp);
  },
};

// Contract string capped at the length limit, marked as untrusted data.
export type UntrustedText = string & { readonly __brand: "UntrustedText" };
export const UntrustedText = {
  quote(raw: string, maxChars: number = DEFAULT_MAX_UNTRUSTED_TEXT_CHARS): Result<UntrustedText, DomainError> {
    if (raw.length > maxChars) {
      return err({ kind: "invalid-untrusted-text", message: `untrusted text holds ${raw.length} characters, above the limit of ${maxChars}` });
    }
    return ok(raw as UntrustedText);
  },
};

// Stably derived from code hash, selector and optional PC offset.
export type EvidenceId = string & { readonly __brand: "EvidenceId" };
export const EvidenceId = {
  of(codeHash: CodeHash, selector: Selector, offset?: PcOffset): Result<EvidenceId, DomainError> {
    const point = offset === undefined ? "none" : `${offset as number}`;
    return ok(keccak256Hex(utf8Encode(`evidence:${codeHash as string}:${selector as string}:${point}`)) as EvidenceId);
  },
};

// Stably derived from code hash and the evidence selector.
export type SignalId = string & { readonly __brand: "SignalId" };
export const SignalId = {
  of(codeHash: CodeHash, selector: Selector): Result<SignalId, DomainError> {
    return ok(keccak256Hex(utf8Encode(`signal:${codeHash as string}:${selector as string}`)) as SignalId);
  },
};

// Stable group id from the clone index.
const CLONE_GROUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
export type CloneGroupId = string & { readonly __brand: "CloneGroupId" };
export const CloneGroupId = {
  parse(raw: string): Result<CloneGroupId, DomainError> {
    if (!CLONE_GROUP_PATTERN.test(raw)) {
      return err({ kind: "invalid-clone-group-id", message: `clone group id must be 1-128 identifier characters: ${raw}` });
    }
    return ok(raw as CloneGroupId);
  },
};

// Composed of code hash and model version, so a new model version gives a new key.
export type CacheKey = string & { readonly __brand: "CacheKey" };
export const CacheKey = {
  of(codeHash: CodeHash, modelVersion: ModelVersion): Result<CacheKey, DomainError> {
    return ok(`${codeHash as string}:${modelVersion as string}` as CacheKey);
  },
};

// Positive integer within the page-size limit.
export type PageSize = number & { readonly __brand: "PageSize" };
export const PageSize = {
  of(value: number, maxPageSize: number = DEFAULT_MAX_PAGE_SIZE): Result<PageSize, DomainError> {
    if (!Number.isSafeInteger(value) || value <= 0 || value > maxPageSize) {
      return err({ kind: "invalid-page-size", message: `page size must be an integer in [1, ${maxPageSize}]: ${value}` });
    }
    return ok(value as PageSize);
  },
};
