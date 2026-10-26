// Shared golden-fixture loader for K-102 (test layer only).
// Fixture inputs are plain JSON with two tagged extensions:
// { "$bigint": "<decimal>" } revives to bigint and
// { "$bytes": "0x..." } revives to Uint8Array.
// Expected outputs are compared byte for byte and are never written by tests.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CanonicalValue } from "../../src/domain/serialize.ts";

export const goldenDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "golden",
);

const BIGINT_TAG = "$bigint";
const BYTES_TAG = "$bytes";

function isTaggedRecord(value: unknown, tag: string): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === tag;
}

function parseBytes(raw: unknown): Uint8Array {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]*$/.test(raw) || raw.length % 2 !== 0) {
    throw new Error(`fixture $bytes must be 0x-prefixed even-length hex: ${String(raw)}`);
  }
  const hex = raw.slice(2).toLowerCase();
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function reviveCanonical(value: unknown): CanonicalValue {
  if (isTaggedRecord(value, BIGINT_TAG)) {
    const raw = (value as Record<string, unknown>)[BIGINT_TAG];
    if (typeof raw !== "string" || !/^-?[0-9]+$/.test(raw)) {
      throw new Error(`fixture $bigint must hold decimal digits: ${String(raw)}`);
    }
    return BigInt(raw) as CanonicalValue;
  }
  if (isTaggedRecord(value, BYTES_TAG)) {
    return parseBytes((value as Record<string, unknown>)[BYTES_TAG]) as CanonicalValue;
  }
  if (Array.isArray(value)) {
    return value.map(reviveCanonical) as CanonicalValue;
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, CanonicalValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = reviveCanonical(entry);
    }
    return out as CanonicalValue;
  }
  return value as CanonicalValue;
}

export function listGoldenInputs(): string[] {
  // Scoped to the k102 envelope fixtures: other suites (for example k301)
  // keep their own frozen fixtures in the same golden directory.
  return readdirSync(goldenDir)
    .filter((name) => name.startsWith("k102-") && name.endsWith(".input.json"))
    .sort();
}

export function readGoldenInput(name: string): CanonicalValue {
  const raw = readFileSync(join(goldenDir, name), "utf8");
  return reviveCanonical(JSON.parse(raw) as unknown);
}

export function readGoldenExpected(name: string): Buffer {
  const expectedName = name.replace(/\.input\.json$/, ".expected.json");
  return readFileSync(join(goldenDir, expectedName));
}
