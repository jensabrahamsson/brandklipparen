// Motion on/off preference (UI v2 §5.6, W-10, WCAG 2.2.2). Presentation
// state only, persisted locally: one `localStorage` key holding the
// closed union `on | off`, read once at start-up. Any other stored value
// is ignored and motion stays on (the operating-system reduced-motion
// setting still applies through the media query). Switching off sets
// `data-motion="off"` on <html>, which applies the same static rules as
// `prefers-reduced-motion: reduce`. The value is never sent to the
// server, never part of a cache key, and never logged.

export const MOTION_KEY = "brandklipparen-motion";

export type MotionPref = "on" | "off";

// Closed-union read: exactly `on` or `off` passes; every crafted, cased,
// padded or markup-bearing value falls back to on.
export function parseStoredMotion(raw: string | null | undefined): MotionPref {
  if (raw === "on" || raw === "off") {
    return raw;
  }
  return "on";
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

export function readStoredMotion(storage: Storage | null = storageOf()): MotionPref {
  if (storage === null) {
    return "on";
  }
  try {
    return parseStoredMotion(storage.getItem(MOTION_KEY));
  } catch {
    return "on";
  }
}

export function writeStoredMotion(pref: MotionPref, storage: Storage | null = storageOf()): void {
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(MOTION_KEY, pref);
  } catch {
    // Local-only preference: the app works without persistence.
  }
}

// Applies the preference to the document: "off" pins the static
// attribute, "on" removes it so the operating-system setting decides.
export function applyMotionPref(pref: MotionPref): void {
  if (typeof document === "undefined") {
    return;
  }
  if (pref === "off") {
    document.documentElement.dataset["motion"] = "off";
  } else {
    delete document.documentElement.dataset["motion"];
  }
}
