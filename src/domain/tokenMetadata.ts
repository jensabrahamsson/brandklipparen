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

// Decodes one symbol()/name() return value: the 32-byte legacy form or
// the ABI string form with its length capped. Returns null for every
// malformed, overlong, empty or non-printable payload.
export function decodeTokenText(bytes: Uint8Array): string | null {
  if (bytes.length === 32) {
    let end = bytes.length;
    while (end > 0 && (bytes[end - 1] ?? 1) === 0) {
      end -= 1;
    }
    return cleanText(bytes.slice(0, end));
  }
  if (bytes.length < 96) {
    return null;
  }
  const words = wordsOf(bytes);
  if (words[0] !== 32n) {
    return null;
  }
  const length = words[1] ?? 0n;
  if (length <= 0n || length > BigInt(MAX_TEXT_LENGTH) || 64 + Number(length) > bytes.length) {
    return null;
  }
  return cleanText(bytes.slice(64, 64 + Number(length)));
}
