// Unit tests for band threshold selection on TRAIN scores.
// Tiny synthetic scores only.
import { describe, expect, test } from "vitest";
import { DEFAULT_BAND_THRESHOLDS, bandOfScore, chooseBandThresholds } from "../../../src/domain/thresholds.ts";

describe("band threshold selection", () => {
  test("high precision rule picks a high cutoff and elevated keeps recall", () => {
    const scores = [
      { score: 5, bad: false },
      { score: 15, bad: false },
      { score: 35, bad: true },
      { score: 55, bad: true },
      { score: 75, bad: true },
      { score: 95, bad: true },
    ];
    const chosen = chooseBandThresholds(scores, 0.8, 0.8);
    expect(chosen.high).toBeGreaterThanOrEqual(chosen.elevated);
    expect(bandOfScore(95, chosen)).toBe("High");
    expect(bandOfScore(0, chosen)).toBe("Low");
  });

  test("empty input falls back to the documented defaults", () => {
    const chosen = chooseBandThresholds([], 0.8, 0.8);
    expect(chosen).toEqual({ elevated: 30, high: 60 });
  });

  test("product bands stay 30/60 across every surface", () => {
    expect(DEFAULT_BAND_THRESHOLDS).toEqual({ elevated: 30, high: 60 });
    expect(bandOfScore(0)).toBe("Low");
    expect(bandOfScore(29)).toBe("Low");
    expect(bandOfScore(30)).toBe("Elevated");
    expect(bandOfScore(59)).toBe("Elevated");
    expect(bandOfScore(60)).toBe("High");
    expect(bandOfScore(100)).toBe("High");
  });
});
