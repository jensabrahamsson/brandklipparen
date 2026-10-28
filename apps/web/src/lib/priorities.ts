// User priorities local-only storage (S-066, K-035, P-24). The token page
// offers one free-text field ("What matters to you?"); the text lives
// under one versioned `localStorage` key as `{ version: 1, text }` and is
// read once at start-up and on edit, in `apps/web` only. There is no
// server-side profile: no REST field, no MCP field, no database row, no
// cache key and no log field ever carries the priorities text. Clearing
// the field removes the key. The text is trimmed, capped at 500
// characters, and rejected to empty on oversize, control characters or a
// shape mismatch — the same closed-read posture as the mode preference.

// Versioned key for the visitor's own words (P-24).
export const PRIORITIES_KEY = "brandklipparen-user-priorities:v1";

// Current schema version of the stored shape.
export const PRIORITIES_VERSION = 1;

// Length cap for the stored text (P-24).
export const PRIORITIES_MAX_CHARS = 500;

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

// Closed-shape read: exactly `{ version: 1, text: string }` with trimmed
// text inside the cap and without control characters passes; everything
// else is no priorities stated. Never throws.
export function parseStoredPriorities(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw.length === 0) {
    return "";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return "";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "";
  }
  const record = parsed as Record<string, unknown>;
  if (record["version"] !== PRIORITIES_VERSION || typeof record["text"] !== "string") {
    return "";
  }
  const text = (record["text"] as string).trim();
  if (text.length === 0 || text.length > PRIORITIES_MAX_CHARS || hasControlCharacter(text)) {
    return "";
  }
  return text;
}

function storageOf(): Storage | null {
  try {
    if (typeof localStorage === "undefined") {
      return null;
    }
    return localStorage;
  } catch {
    return null;
  }
}

export function readStoredPriorities(storage: Storage | null = storageOf()): string {
  if (storage === null) {
    return "";
  }
  try {
    return parseStoredPriorities(storage.getItem(PRIORITIES_KEY));
  } catch {
    return "";
  }
}

export function writeStoredPriorities(text: string, storage: Storage | null = storageOf()): void {
  if (storage === null) {
    return;
  }
  try {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      storage.removeItem(PRIORITIES_KEY);
      return;
    }
    storage.setItem(PRIORITIES_KEY, JSON.stringify({ version: PRIORITIES_VERSION, text: trimmed }));
  } catch {
    // Local-only preference: the app works without persistence.
  }
}

export function clearStoredPriorities(storage: Storage | null = storageOf()): void {
  if (storage === null) {
    return;
  }
  try {
    storage.removeItem(PRIORITIES_KEY);
  } catch {
    // Local-only preference: the app works without persistence.
  }
}
