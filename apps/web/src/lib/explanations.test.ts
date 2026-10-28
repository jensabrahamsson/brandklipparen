// Lookup coverage for the reusable explanation data (S-113, K-021).
// Written first per A-21 (red): ./explanations.ts and
// ./explanations.generated.ts do not exist yet. Every key the UI renders
// must resolve to a non-empty title and body, and unknown keys must fall
// back to a non-empty generic entry so the UI never renders empty text.
import { describe, expect, test } from "vitest";
import { EXPLANATION_KEYS, explanationFor } from "./explanations.ts";

describe("explanation lookup (S-113)", () => {
  test("explanations_cover_every_rendered_kind", () => {
    expect(EXPLANATION_KEYS.length).toBeGreaterThan(0);
    for (const key of EXPLANATION_KEYS) {
      const entry = explanationFor(key);
      expect(entry.title.length, `empty title for ${key}`).toBeGreaterThan(0);
      expect(entry.body.length, `empty body for ${key}`).toBeGreaterThan(0);
    }
  });

  test("explanations_cover_every_known_plugin", () => {
    for (const id of [
      "dev.brandklipparen.capability",
      "dev.brandklipparen.clone-match",
      "dev.brandklipparen.decompiler",
      "dev.brandklipparen.hard-to-analyze",
      "dev.brandklipparen.mint",
      "dev.brandklipparen.blacklist",
      "dev.brandklipparen.transfer-fee",
      "dev.brandklipparen.pause",
      "dev.brandklipparen.transfer-limits",
      "dev.brandklipparen.ownership",
      "dev.brandklipparen.transfer-hooks",
      "dev.brandklipparen.sell-block",
      "dev.brandklipparen.proxy-upgrade",
    ]) {
      const entry = explanationFor(`plugin:${id}`);
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.body.length).toBeGreaterThan(0);
      expect(entry.body).not.toBe(explanationFor("unknown:missing").body);
    }
  });

  test("explanations_fall_back_without_empty_text", () => {
    const entry = explanationFor("no-such-key");
    expect(entry.title.length).toBeGreaterThan(0);
    expect(entry.body.length).toBeGreaterThan(0);
  });
});
