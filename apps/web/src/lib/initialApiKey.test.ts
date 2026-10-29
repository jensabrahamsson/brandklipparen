// Unit test for the demo API key initial value: the dev-only demo key
// fills the field solely in dev without a stored key, and production
// never reads it. Pure helper, no DOM.
import { describe, expect, test } from "vitest";
import { initialApiKey } from "./initialApiKey.ts";

describe("initial API key for the demo UI", () => {
  test("a stored key always wins over the demo key", () => {
    expect(initialApiKey("visitor-key", true, "demo-key")).toBe("visitor-key");
    expect(initialApiKey("visitor-key", false, "demo-key")).toBe("visitor-key");
    expect(initialApiKey("visitor-key", true, undefined)).toBe("visitor-key");
  });

  test("the dev-only demo key fills an empty field in dev", () => {
    expect(initialApiKey(null, true, "demo-key")).toBe("demo-key");
    expect(initialApiKey("", true, "demo-key")).toBe("demo-key");
  });

  test("production never reads the demo key", () => {
    expect(initialApiKey(null, false, "demo-key")).toBe("");
    expect(initialApiKey("", false, "demo-key")).toBe("");
  });

  test("an absent or empty demo key leaves the field empty", () => {
    expect(initialApiKey(null, true, undefined)).toBe("");
    expect(initialApiKey(null, true, "")).toBe("");
    expect(initialApiKey(null, false, undefined)).toBe("");
  });
});
