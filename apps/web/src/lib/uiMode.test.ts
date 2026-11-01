// S-061 Simple / Expert mode storage (K-034, P-20). The preference is
// presentation state only: one versioned `localStorage` key holding the
// closed union `simple | expert`. Any other stored value is ignored and
// Simple applies; the value never reaches the renderer as anything but
// the union, never leaves the device, and never enters a cache key or a
// log. Written first (red) per A-21.
import { describe, expect, test } from "vitest";
import { MODE_KEY, parseStoredMode, readStoredMode } from "./uiMode.ts";

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

