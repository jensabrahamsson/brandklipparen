// Strict ERC-20 text decoding for token symbol()/name() reads. Accepts
// the ABI string form (offset word 32, length word, bytes) and the
// compact bytes32 form; anything else reads as absent. Only printable
// ASCII survives (0x20-0x7E), trimmed, at most 32 characters: hostile or
// malformed returndata never reaches the UI. Decoded text is display
// data only and never steers scoring or evidence.
const PRINTABLE_MIN = 0x20;
const PRINTABLE_MAX = 0x7e;
const MAX_TEXT_LENGTH = 32;

function wordsOf(bytes: Uint8Array): bigint[] {
  const words: bigint[] = [];
  for (let offset = 0; offset + 32 <= bytes.length; offset += 32) {
    let value = 0n;
    for (let index = offset; index < offset + 32; index += 1) {
      value = (value << 8n) + BigInt(bytes[index] ?? 0);
    }
    words.push(value);
  }
  return words;
}

function cleanText(raw: Uint8Array): string | null {
  if (raw.length === 0 || raw.length > MAX_TEXT_LENGTH) {
    return null;
  }
  for (const byte of raw) {
    if (byte < PRINTABLE_MIN || byte > PRINTABLE_MAX) {
      return null;
    }
  }
  const text = new TextDecoder().decode(raw).trim();
  if (text.length === 0 || text.length > MAX_TEXT_LENGTH) {
    return null;
  }
  return text;
}

// Raw text bytes of one symbol()/name() return value: the 32-byte
// legacy form (trailing zero bytes trimmed) or the ABI string form
// with its length capped, or null for every malformed shape.
function rawTextBytes(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length === 32) {
    let end = bytes.length;
    while (end > 0 && (bytes[end - 1] ?? 1) === 0) {
      end -= 1;
    }
    return bytes.slice(0, end);
  }
  if (bytes.length < 96) {
    return null;
  }
  const words = wordsOf(bytes);
  if (words[0] !== 32n) {
    return null;
  }
  const length = words[1] ?? 0n;
  if (length <= 0n || length > BigInt(MAX_TEXT_LENGTH * 4) || 64 + Number(length) > bytes.length) {
    return null;
  }
  return bytes.slice(64, 64 + Number(length));
}

// Decodes one symbol()/name() return value: the 32-byte legacy form or
// the ABI string form with its length capped. Returns null for every
// malformed, overlong, empty or non-printable payload.
export function decodeTokenText(bytes: Uint8Array): string | null {
  const raw = rawTextBytes(bytes);
  if (raw === null || raw.length > MAX_TEXT_LENGTH) {
    return null;
  }
  return cleanText(raw);
}

// Display decoding for symbol()/name() (SCAN-2): strict printable ASCII
// keeps the plain text; valid UTF-8 carrying non-ASCII characters (a
// homoglyph name, for example) returns the decoded text with the
// non-ASCII flag set, so the caller can show it escaped and labelled
// instead of dropping it to empty. Control characters, malformed
// UTF-8, empty and overlong payloads stay absent.
export type TokenTextDisplay = {
  readonly text: string;
  readonly nonAscii: boolean;
};

export function decodeTokenTextDisplay(bytes: Uint8Array): TokenTextDisplay | null {
  const strict = decodeTokenText(bytes);
  if (strict !== null) {
    return Object.freeze({ text: strict, nonAscii: false });
  }
  const raw = rawTextBytes(bytes);
  if (raw === null) {
    return null;
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    // Lossy fallback (SCAN-4): bytes that carry non-ASCII content but
    // fail strict UTF-8 (a homoglyph name in a legacy encoding, a
    // truncated multi-byte sequence) still name the token. Decode with
    // replacement characters and flag the result, so the caller shows
    // it escaped instead of empty. Pure-ASCII or control-carrying
    // payloads stay absent.
    if (!raw.some((byte) => byte > 0x7e)) {
      return null;
    }
    decoded = new TextDecoder("utf-8", { fatal: false }).decode(raw);
  }
  const text = decoded.trim();
  const chars = [...text];
  if (chars.length === 0 || chars.length > MAX_TEXT_LENGTH) {
    return null;
  }
  let nonAscii = false;
  for (const char of chars) {
    const point = char.codePointAt(0) ?? 0;
    if (point < 0x20 || (point >= 0x7f && point <= 0x9f)) {
      return null;
    }
    if (point > 0x7e) {
      nonAscii = true;
    }
  }
  if (!nonAscii) {
    return null;
  }
  return Object.freeze({ text, nonAscii: true });
}
