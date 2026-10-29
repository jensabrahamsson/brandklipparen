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

export const CUSTOMIZE_KEY = "brandklipparen-customize-open";

function sessionStorageOf(): Storage | null {
  try {
    if (typeof sessionStorage === "undefined") {
      return null;
    }
    return sessionStorage;
  } catch {
    return null;
  }
}

// Customize-view disclosure state (S-118): remembered per session only, so
// a reload keeps the panel as the visitor left it without persisting
// anything across sessions. Anything unreadable collapses the panel.
export function readStoredCustomize(storage: Storage | null = sessionStorageOf()): boolean {
  if (storage === null) {
    return false;
  }
  try {
    return storage.getItem(CUSTOMIZE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeStoredCustomize(open: boolean, storage: Storage | null = sessionStorageOf()): void {
  if (storage === null) {
    return;
  }
  try {
    if (open) {
      storage.setItem(CUSTOMIZE_KEY, "1");
    } else {
      storage.removeItem(CUSTOMIZE_KEY);
    }
  } catch {
    // Local-only preference: the app works without persistence.
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
