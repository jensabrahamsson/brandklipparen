// S-061 Simple / Expert mode storage (K-034, P-20). The preference is
// presentation state only: one versioned `localStorage` key holding the
// closed union `simple | expert`. Any other stored value is ignored and
// Simple applies; the value never reaches the renderer as anything but
// the union, never leaves the device, and never enters a cache key or a
// log. Written first (red) per A-21.
import { describe, expect, test } from "vitest";
import {
  CUSTOMIZE_KEY,
  MODE_KEY,
  hasStoredCustomize,
  parseStoredMode,
  readStoredCustomize,
  readStoredMode,
  writeStoredCustomize,
} from "./uiMode.ts";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get length() {
      return store.size;
    },
    clear: () => {
      store.clear();
    },
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

describe("k034_invalid_stored_mode_falls_back_to_simple", () => {
  test("missing or empty storage gives Simple", () => {
    expect(readStoredMode(memoryStorage())).toBe("simple");
  });

  test("crafted and markup-bearing values give Simple", () => {
    for (const raw of [
      "expert ",
      "Expert",
      "SIMPLE",
      "admin",
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "{\"mode\":\"expert\"}",
      "simple\0expert",
    ]) {
      expect(parseStoredMode(raw)).toBe("simple");
    }
  });

  test("the versioned key round-trips both modes", () => {
    expect(MODE_KEY).toBe("brandklipparen-ui-mode");
    expect(parseStoredMode("simple")).toBe("simple");
    expect(parseStoredMode("expert")).toBe("expert");
    const storage = memoryStorage({ [MODE_KEY]: "expert" });
    expect(readStoredMode(storage)).toBe("expert");
  });

  test("a stored value never reaches the renderer as markup", () => {
    const hostile = "<script>alert(1)</script>";
    const mode = parseStoredMode(hostile);
    expect(mode).toBe("simple");
    expect(mode).not.toContain("<");
  });
});

describe("customize_open_storage_round_trip", () => {
  test("missing storage collapses the panel", () => {
    expect(readStoredCustomize(memoryStorage())).toBe(false);
  });

  test("only the exact marker opens the panel", () => {
    for (const raw of ["0", "yes", "true", "2", " 1", "<b>1</b>"]) {
      expect(readStoredCustomize(memoryStorage({ [CUSTOMIZE_KEY]: raw }))).toBe(false);
    }
    expect(readStoredCustomize(memoryStorage({ [CUSTOMIZE_KEY]: "1" }))).toBe(true);
  });

  test("writing true stores the marker, writing false stores an explicit closed marker", () => {
    const storage = memoryStorage();
    writeStoredCustomize(true, storage);
    expect(storage.getItem(CUSTOMIZE_KEY)).toBe("1");
    expect(readStoredCustomize(storage)).toBe(true);
    expect(hasStoredCustomize(storage)).toBe(true);
    writeStoredCustomize(false, storage);
    expect(storage.getItem(CUSTOMIZE_KEY)).toBe("0");
    expect(readStoredCustomize(storage)).toBe(false);
    expect(hasStoredCustomize(storage)).toBe(true);
  });

  test("null storage collapses without throwing", () => {
    expect(readStoredCustomize(null)).toBe(false);
    expect(() => writeStoredCustomize(true, null)).not.toThrow();
    expect(() => writeStoredCustomize(false, null)).not.toThrow();
  });
});
