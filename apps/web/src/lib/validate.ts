// Contract address input validation (K-020, K-507): plain checks at the
// boundary, mirroring the REST gate. Invalid input shows an error in-view
// and never reaches the network.

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function normalizeAddress(raw: string): string {
  return raw.trim();
}

export function isValidAddress(raw: string): boolean {
  return ADDRESS_PATTERN.test(normalizeAddress(raw));
}

export function validationMessage(raw: string): string {
  const normalized = normalizeAddress(raw);
  if (normalized.length === 0) {
    return "Enter a contract address starting with 0x.";
  }
  if (!normalized.startsWith("0x")) {
    return "Invalid address: expected 0x followed by 40 hex characters.";
  }
  if (normalized.length !== 42) {
    return `Invalid address: expected 40 hex characters after 0x, found ${normalized.length - 2}.`;
  }
  return "Invalid address: expected 0x followed by 40 hex characters.";
}
