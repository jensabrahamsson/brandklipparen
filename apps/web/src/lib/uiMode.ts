// Simple / Expert mode preference (S-061, K-034, P-20). Presentation
// state only, persisted locally: one versioned `localStorage` key holding
// the closed union `simple | expert`, read once at start-up. Any other
// stored value is ignored and Simple applies. The value is never sent to
// the server, never part of a cache key, and never logged: tampering can
// at most flip the detail depth on that device.

export const MODE_KEY = "brandklipparen-ui-mode";

export type UiMode = "simple" | "expert";

// Closed-union read (P-20): exactly `simple` or `expert` passes; every
// crafted, cased, padded, control-character or markup-bearing value falls
// back to Simple and never reaches the renderer as anything else.
export function parseStoredMode(raw: string | null | undefined): UiMode {
  if (raw === "simple" || raw === "expert") {
    return raw;
  }
  return "simple";
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

export function readStoredMode(storage: Storage | null = storageOf()): UiMode {
  if (storage === null) {
    return "simple";
  }
  try {
    return parseStoredMode(storage.getItem(MODE_KEY));
  } catch {
    return "simple";
  }
}

export function writeStoredMode(mode: UiMode, storage: Storage | null = storageOf()): void {
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(MODE_KEY, mode);
  } catch {
    // Local-only preference: the app works without persistence.
  }
}
