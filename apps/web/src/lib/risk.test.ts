import { describe, expect, test } from "vitest";
import { riskBand, riskWord } from "./risk.ts";

describe("risk word mapping (K-103)", () => {
  test("k103_risk_badge_shows_number_and_word", () => {
    expect(riskWord(84)).toBe("High");
    expect(riskWord(0)).toBe("Low");
    expect(riskBand(84)).toEqual({ word: "High", min: 60, max: 100 });
  });

  test("k103_risk_bands_follow_design_thresholds", () => {
    expect(riskWord(0)).toBe("Low");
    expect(riskWord(29)).toBe("Low");
    expect(riskWord(30)).toBe("Elevated");
    expect(riskWord(59)).toBe("Elevated");
    expect(riskWord(60)).toBe("High");
    expect(riskWord(100)).toBe("High");
  });

  test("k103_out_of_range_scores_clamp_to_bands", () => {
    expect(riskWord(-5)).toBe("Low");
    expect(riskWord(140)).toBe("High");
  });
});
