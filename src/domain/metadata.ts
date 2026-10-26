// Shared Solidity CBOR metadata footer handling (K-009, K-017).
// Runtime bytecode may end with a metadata section: a CBOR blob followed by
// a two-byte big-endian blob length (public Solidity metadata format). The
// blob length varies by compiler version and settings, and some bytecode
// carries no metadata at all. This module is the single place that detects
// the footer; CodeHash, SkeletonHash and selector extraction share it, so a
// new compiler layout is handled in one place. Pure: reads bytes only and
// returns either a prefix view of the input or the input itself.
export function stripCborFooter(code: Uint8Array): Uint8Array {
  const total = code.length;
  if (total < 3) {
    return code;
  }
  const high = code[total - 2] ?? 0;
  const low = code[total - 1] ?? 0;
  const blobLength = high * 256 + low;
  if (blobLength <= 0 || blobLength + 2 > total) {
    return code;
  }
  const start = total - 2 - blobLength;
  const first = code[start] ?? 0;
  const definiteMap = first >= 0xa0 && first <= 0xbb;
  if (!definiteMap && first !== 0xbf) {
    return code;
  }
  return code.slice(0, start);
}
