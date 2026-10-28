// Unit tests for deterministic stratified grouped split.
// Tiny synthetic codehashes only, no real tokens.
import { describe, expect, test } from "vitest";
import { splitStratifiedGrouped } from "../../../src/domain/stratifiedSplit.ts";

function entry(codehash: string, label: string): { codehash: string; label: string } {
  return { codehash, label };
}

describe("stratified grouped split", () => {
  test("stratifies each label and keeps groups together", () => {
    const rows = [
      entry("0x01", "legit"),
      entry("0x02", "legit"),
      entry("0x03", "legit"),
      entry("0x04", "legit"),
      entry("0x11", "rug"),
      entry("0x12", "rug"),
      entry("0x13", "rug"),
      entry("0x14", "rug"),
    ];
    const split = splitStratifiedGrouped(rows, 0.75, 42);
    const trainLegit = split.train.filter((entry) => entry.label === "legit");
    const testLegit = split.test.filter((entry) => entry.label === "legit");
    expect(trainLegit).toHaveLength(3);
    expect(testLegit).toHaveLength(1);
    const trainHashes = new Set(split.train.map((entry) => entry.codehash));
    for (const entry of split.test) {
      expect(trainHashes.has(entry.codehash)).toBe(false);
    }
  });

  test("same seed gives identical splits", () => {
    const rows = [
      entry("0x01", "legit"),
      entry("0x02", "legit"),
      entry("0x03", "rug"),
      entry("0x04", "rug"),
      entry("0x05", "honeypot"),
      entry("0x06", "honeypot"),
    ];
    const first = splitStratifiedGrouped(rows, 0.5, 7);
    const second = splitStratifiedGrouped(rows, 0.5, 7);
    expect(first).toEqual(second);
  });
});
