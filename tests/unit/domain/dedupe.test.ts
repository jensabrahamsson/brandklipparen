// Unit tests for calibration dedupe (codehash grouping).
// Tiny synthetic hashes only, no real tokens.
import { describe, expect, test } from "vitest";
import { dedupeCalibration } from "../../../src/domain/dedupe.ts";

function row(codehash: string, overrides: Record<string, string> = {}): {
  codehash: string;
  label: string;
  labelBasis?: string;
  labelNote?: string;
  labelSource?: string;
} {
  return {
    codehash,
    label: "legit",
    labelBasis: "dataset",
    ...overrides,
  };
}

describe("calibration dedupe", () => {
  test("drops holdout overlap by codehash", () => {
    const kept = dedupeCalibration(
      [row("0xaaaa", { label: "legit" }), row("0xbbbb", { label: "rug" })],
      new Set(["0xaaaa"]),
    );
    expect(kept.droppedHoldoutOverlap).toBe(1);
    expect(kept.kept.map((entry) => entry.codehash)).toEqual(["0xbbbb"]);
  });

  test("keeps strongest label within exact duplicates", () => {
    const kept = dedupeCalibration(
      [
        row("0xcccc", { label: "unknown", labelBasis: "dataset" }),
        row("0xcccc", {
          label: "rug",
          labelBasis: "incident-report",
          labelNote: "Corroborated by: rug per X",
        }),
      ],
      new Set(),
    );
    expect(kept.droppedDuplicates).toBe(1);
    expect(kept.kept).toHaveLength(1);
    expect(kept.kept[0]?.label).toBe("rug");
  });

  test("holdout match is case-insensitive", () => {
    const kept = dedupeCalibration([row("0xABCD")], new Set(["0xabcd"]));
    expect(kept.droppedHoldoutOverlap).toBe(1);
    expect(kept.kept).toHaveLength(0);
  });
});
