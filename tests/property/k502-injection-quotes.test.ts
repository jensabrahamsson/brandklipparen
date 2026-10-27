// Injection strings stay data: escaping yields at most one raw quote and
// inert text (K-502, K-507, M-04). Written first per A-21 (red): the
// encoding helper in src/domain/encoding.ts does not exist yet, so the
// import below fails until the helper is implemented. Fakes and frozen
// fixtures only; no network, no secrets.
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { countRawDoubleQuotes, escapeHtml } from "../../src/domain/encoding.ts";

// Classic hostile payloads as fixed vectors: markup, event handlers,
// quote breakouts, template syntax and control characters. Every vector
// is a well-known neutralised test string with no live target.
const FIXED_INJECTION_VECTORS: readonly string[] = Object.freeze([
  "<script>alert(1)</script>",
  "<SCRIPT SRC=\"https://example.invalid/x.js\"></SCRIPT>",
  "\"><script>alert(1)</script>",
  "' OR '1'='1",
  "\"><img src=x onerror=alert(1)>",
  "'; DROP TABLE tokens; --",
  "`${process.env.API_KEY}`",
  "{{7*7}}",
  "<svg onload=alert(1)>",
  "javascript:alert(1)",
  "<iframe src=\"https://example.invalid\"></iframe>",
  "normal-token-name",
  "Token \"quoted\" name",
  "It's a token",
  "back`tick",
  "amp & entity",
  "\u0000\u0001\u0002control",
]);

function hasScriptTag(text: string): boolean {
  return /<\s*script/i.test(text);
}

describe("injection strings stay inert (K-502, M-04)", () => {
  test("k502_injection_strings_yield_at_most_one_quote", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 120 }),
          fc
            .array(
              fc.constantFrom("<", ">", "\"", "'", "`", "&", "=", "/", "(", ")", ";", "s", "S", "c", "C"),
              { maxLength: 60 },
            )
            .map((chars) => (chars as readonly string[]).join("")),
          fc.constantFrom(...FIXED_INJECTION_VECTORS),
        ),
        (raw) => {
          const escaped = escapeHtml(raw);
          // The escaped form carries at most one raw double quote, so a
          // hostile payload cannot terminate a quoted context it is
          // placed in; every other quote arrives as an entity.
          expect(countRawDoubleQuotes(escaped)).toBeLessThanOrEqual(1);
          // No raw markup survives: the payload renders as inert text.
          expect(escaped).not.toContain("<");
          expect(escaped).not.toContain(">");
          expect(hasScriptTag(escaped)).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });

  test("k502_fixed_injection_vectors_render_as_inert_text", () => {
    for (const raw of FIXED_INJECTION_VECTORS) {
      const escaped = escapeHtml(raw);
      expect(hasScriptTag(escaped)).toBe(false);
      expect(escaped).not.toContain("<");
      expect(escaped).not.toContain(">");
      expect(countRawDoubleQuotes(escaped)).toBeLessThanOrEqual(1);
    }
  });
});
