// API key comparison keeps constant time over generated inputs (K-510,
// M-10). The store compares every stored hash with timingSafeEqual and
// never exits early; the property below proves verification correctness
// and order-independence over generated key sets, plus a bounded timing
// check that a match in first position costs the same as a match in last
// position. Placeholder key shapes for the test only; no real key material.
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { createApiKeyStore } from "../../src/interfaces/rest/apiKeys.ts";
import { SecretString } from "../../src/ports/config.ts";

const PEPPER = "test-pepper-for-constant-time-suite-only";

const KEY_CHAR = "abcdefghijklmnopqrstuvwxyz0123456789-_.";
const KEY_ARB = fc
  .array(fc.constantFrom(...KEY_CHAR.split("")), { minLength: 8, maxLength: 40 })
  .map((chars) => (chars as readonly string[]).join(""));

const KEY_SET_ARB = fc
  .array(KEY_ARB, { minLength: 1, maxLength: 8 })
  .map((keys) => [...new Set(keys as readonly string[])]);

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

describe("key comparison keeps constant time (K-510, M-10)", () => {
  test("k510_key_comparison_is_constant_time", () => {
    fc.assert(
      fc.property(KEY_SET_ARB, KEY_ARB, (keys, candidate) => {
        const store = createApiKeyStore({
          keys: (keys as readonly string[]).map((key) => new SecretString(key)),
          pepper: new SecretString(PEPPER),
        });
        const expected = (keys as readonly string[]).includes(candidate as string);
        // Verification is correct over generated inputs: members verify
        // and strangers do not.
        expect(store.verify(candidate as string)).toBe(expected);
        // The key identifier is stable and non-secret: members map to a
        // fixed id, strangers map to null, and the id never leaks the key.
        const id = store.keyId(candidate as string);
        if (expected) {
          expect(typeof id).toBe("string");
          expect((id as string).length).toBeGreaterThan(0);
          expect(candidate as string).not.toContain(id as string);
          expect(store.keyId(candidate as string)).toBe(id);
        } else {
          expect(id).toBe(null);
        }
        // Order-independence: shuffling the stored keys changes neither
        // the verdict nor the identifier, so no position is privileged.
        const shuffled = [...(keys as readonly string[])].reverse();
        const reordered = createApiKeyStore({
          keys: shuffled.map((key) => new SecretString(key)),
          pepper: new SecretString(PEPPER),
        });
        expect(reordered.verify(candidate as string)).toBe(expected);
        expect(reordered.keyId(candidate as string)).toBe(id);
      }),
      { numRuns: 200 },
    );
    // Timing bound: a match in first position costs the same as a match
    // in last position. Samples interleave in blocks so machine drift
    // affects both sides equally; the bound is generous (4x) because the
    // loop is structurally identical either way (full scan, no early exit).
    const keys = Array.from({ length: 16 }, (_, index) => `constant-time-key-${index}-placeholder`);
    const store = createApiKeyStore({
      keys: keys.map((key) => new SecretString(key)),
      pepper: new SecretString(PEPPER),
    });
    const first = keys[0] ?? "";
    const last = keys[keys.length - 1] ?? "";
    expect(store.verify(first)).toBe(true);
    expect(store.verify(last)).toBe(true);
    const firstSamples: number[] = [];
    const lastSamples: number[] = [];
    for (let round = 0; round < 40; round += 1) {
      for (let i = 0; i < 100; i += 1) {
        const start = performance.now();
        store.verify(first);
        firstSamples.push(performance.now() - start);
      }
      for (let i = 0; i < 100; i += 1) {
        const start = performance.now();
        store.verify(last);
        lastSamples.push(performance.now() - start);
      }
    }
    const firstMedian = median(firstSamples);
    const lastMedian = median(lastSamples);
    expect(firstMedian).toBeGreaterThan(0);
    expect(lastMedian).toBeGreaterThan(0);
    expect(Math.max(firstMedian, lastMedian) / Math.min(firstMedian, lastMedian)).toBeLessThan(4);
  });
});
