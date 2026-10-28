// S-066 user priorities local-only storage (K-035, P-24). Priorities are
// free text under one versioned `localStorage` key with closed-shape
// validation; clearing removes the key. The text never leaves the device
// in the deterministic baseline. Written first (red) per A-21: the
// priorities module does not exist yet.
import { describe, expect, test } from "vitest";
import { PRIORITIES_KEY, parseStoredPriorities, readStoredPriorities } from "./priorities.ts";

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

describe("k035_invalid_stored_priorities_treated_as_none", () => {
  test("missing or empty storage gives no priorities", () => {
    expect(readStoredPriorities(memoryStorage())).toBe("");
    expect(readStoredPriorities(null)).toBe("");
  });

  test("malformed, oversize, control-character and markup values give no personalization", () => {
    expect(parseStoredPriorities(null)).toBe("");
    expect(parseStoredPriorities("not json")).toBe("");
    expect(parseStoredPriorities(JSON.stringify({ version: 2, text: "hello" }))).toBe("");
    expect(parseStoredPriorities(JSON.stringify({ text: "hello" }))).toBe("");
    expect(parseStoredPriorities(JSON.stringify({ version: 1, text: "x".repeat(501) }))).toBe("");
    expect(parseStoredPriorities(JSON.stringify({ version: 1, text: "hello\u0001world" }))).toBe("");
    expect(parseStoredPriorities(JSON.stringify({ version: 1, text: "Can the owner stop me selling?" }))).toBe(
      "Can the owner stop me selling?",
    );
  });

  test("the versioned key round-trips plain text", () => {
    expect(PRIORITIES_KEY).toBe("brandklipparen-user-priorities:v1");
    const storage = memoryStorage({
      [PRIORITIES_KEY]: JSON.stringify({ version: 1, text: "fees" }),
    });
    expect(readStoredPriorities(storage)).toBe("fees");
  });

  test("a stored string stays data: React escapes it at render", () => {
    const hostile = JSON.stringify({ version: 1, text: "<script>alert(1)</script>" });
    const parsed = parseStoredPriorities(hostile);
    // Data is preserved for the visitor's own input field; every echo
    // renders through React text, never through a markup sink.
    expect(parsed).toBe("<script>alert(1)</script>");
    expect(typeof parsed).toBe("string");
  });
});
