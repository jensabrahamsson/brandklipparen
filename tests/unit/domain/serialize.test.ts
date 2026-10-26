// K-102 unit and property tests for the deterministic core (S-003).
// Written first (red) per A-21; the implementation lives in
// src/domain/serialize.ts. Inputs use synthetic values only.
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import {
  canonicalBytes,
  canonicalSerialize,
  sha256Hex,
  sortedBy,
} from "../../../src/domain/serialize.ts";
import type { CanonicalValue } from "../../../src/domain/serialize.ts";

function canonicalArbitrary(): fc.Arbitrary<CanonicalValue> {
  return fc.letrec((tie) => ({
    leaf: fc.oneof(
      fc.constant(null),
      fc.boolean(),
      fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
      fc.double({ noNaN: true }).filter((n) => Number.isFinite(n)),
      fc.string({ maxLength: 24 }),
      fc.bigInt({ min: -(10n ** 40n), max: 10n ** 40n }),
      fc.uint8Array({ minLength: 0, maxLength: 24 }),
    ),
    branch: fc.oneof(
      tie("leaf"),
      fc.array(tie("leaf") as fc.Arbitrary<CanonicalValue>, { maxLength: 4 }),
      fc.dictionary(
        fc.string({ minLength: 1, maxLength: 8 }),
        tie("leaf") as fc.Arbitrary<CanonicalValue>,
        { maxKeys: 4 },
      ),
    ),
  })).branch as fc.Arbitrary<CanonicalValue>;
}

describe("k102 canonical serialization", () => {
  test("k102_canonical_sorts_object_keys_lexicographically", () => {
    expect(canonicalSerialize({ b: 1, a: 2 } as CanonicalValue)).toBe('{"a":2,"b":1}');
    expect(
      canonicalSerialize({ z: { d: 4, c: 3 }, a: [3, 2, 1] } as CanonicalValue),
    ).toBe('{"a":[3,2,1],"z":{"c":3,"d":4}}');
    // Arrays keep their stable order; only object keys are sorted.
    expect(canonicalSerialize([3, 2, 1] as CanonicalValue)).toBe("[3,2,1]");
  });

  test("k102_canonical_key_order_independent", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.integer(), { maxKeys: 20 }),
        (dict) => {
          const entries = Object.entries(dict);
          const forward: Record<string, number> = {};
          for (const [key, value] of entries) {
            forward[key] = value;
          }
          const backward: Record<string, number> = {};
          for (let i = entries.length - 1; i >= 0; i -= 1) {
            const entry = entries[i];
            if (entry !== undefined) {
              backward[entry[0] ?? ""] = entry[1] ?? 0;
            }
          }
          expect(canonicalSerialize(backward as CanonicalValue)).toBe(
            canonicalSerialize(forward as CanonicalValue),
          );
        },
      ),
      { seed: 102001, numRuns: 200 },
    );
  });

  test("k102_canonical_serialization_stable", () => {
    fc.assert(
      fc.property(canonicalArbitrary(), (value) => {
        const first = canonicalSerialize(value);
        const reparsed = JSON.parse(first) as unknown;
        // JSON.parse yields plain values (bigint stays a quoted string,
        // bytes stay a hex string), so re-serializing is byte-identical.
        expect(canonicalSerialize(reparsed as CanonicalValue)).toBe(first);
      }),
      { seed: 102002, numRuns: 200 },
    );
  });

  test("k102_canonical_bigint_as_decimal_string", () => {
    expect(canonicalSerialize(2n ** 70n as CanonicalValue)).toBe('"1180591620717411303424"');
    expect(canonicalSerialize(-42n as CanonicalValue)).toBe('"-42"');
    expect(canonicalSerialize(0n as CanonicalValue)).toBe('"0"');
    // Safe-range integers stay bare numbers.
    expect(canonicalSerialize(42 as CanonicalValue)).toBe("42");
  });

  test("k102_canonical_bytes_as_lowercase_hex", () => {
    expect(canonicalSerialize(new Uint8Array([0x60, 0x01]) as CanonicalValue)).toBe(
      '"0x6001"',
    );
    expect(canonicalSerialize(new Uint8Array([]) as CanonicalValue)).toBe('"0x"');
  });

  test("k102_canonical_rejects_unrepresentable_values", () => {
    expect(() => canonicalSerialize(Number.NaN as CanonicalValue)).toThrow(TypeError);
    expect(() => canonicalSerialize(Number.POSITIVE_INFINITY as CanonicalValue)).toThrow(
      TypeError,
    );
    expect(() => canonicalSerialize(undefined as unknown as CanonicalValue)).toThrow(TypeError);
    // Negative zero normalizes to zero so equal inputs give equal bytes.
    expect(canonicalSerialize(-0 as CanonicalValue)).toBe("0");
  });

  test("k102_canonical_fixed_probability_form", () => {
    // Probabilities are pre-rounded by Probability.ofRounded (A-32 point 6);
    // the serializer writes the stored value exactly.
    expect(canonicalSerialize(0.123457 as CanonicalValue)).toBe("0.123457");
    expect(canonicalSerialize(0.5 as CanonicalValue)).toBe("0.5");
    expect(canonicalSerialize(0 as CanonicalValue)).toBe("0");
    expect(canonicalSerialize(1 as CanonicalValue)).toBe("1");
  });

  test("k102_canonical_bytes_are_utf8", () => {
    const text = '{"note":"häst ▲"}';
    // canonicalBytes encodes the serialized form in fixed UTF-8.
    expect(canonicalBytes(text as CanonicalValue)).toEqual(
      new Uint8Array(Buffer.from(canonicalSerialize(text as CanonicalValue), "utf8")),
    );
    // A multi-byte character encodes to its fixed UTF-8 bytes.
    expect(canonicalBytes("▲" as CanonicalValue)).toEqual(new Uint8Array([0x22, 0xe2, 0x96, 0xb2, 0x22]));
  });

  test("k102_sortedBy_returns_new_sorted_array_and_keeps_input", () => {
    const input = [{ id: "sig-b" }, { id: "sig-a" }, { id: "sig-c" }] as const;
    const snapshot = JSON.stringify(input);
    const sorted = sortedBy(input, (entry) => entry.id);
    expect(sorted.map((entry) => entry.id)).toEqual(["sig-a", "sig-b", "sig-c"]);
    expect(sorted).not.toBe(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  test("k102_analysis_leaves_inputs_unchanged", () => {
    fc.assert(
      fc.property(canonicalArbitrary(), (value) => {
        const snapshot = JSON.stringify(value, (_key, entry: unknown) =>
          typeof entry === "bigint" ? `bigint:${entry.toString()}` : entry,
        );
        canonicalSerialize(value);
        canonicalBytes(value);
        expect(
          JSON.stringify(value, (_key, entry: unknown) =>
            typeof entry === "bigint" ? `bigint:${entry.toString()}` : entry,
          ),
        ).toBe(snapshot);
      }),
      { seed: 102003, numRuns: 200 },
    );
  });

  test("k102_sha256_known_vectors", () => {
    expect(sha256Hex(new Uint8Array([]))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex(new Uint8Array(Buffer.from("abc", "utf8")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
