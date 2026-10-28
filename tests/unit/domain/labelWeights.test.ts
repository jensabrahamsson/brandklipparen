// Unit tests for sample weights by label strength (real calibration).
// Tiny synthetic rows only, no real tokens.
import { describe, expect, test } from "vitest";
import {
  SAMPLE_WEIGHT_DEFAULTS,
  isCorroborated,
  isDoNotRugPrimary,
  parseSampleWeights,
  sampleWeightOf,
} from "../../../src/domain/labelWeights.ts";

describe("label strength weights", () => {
  test("defaults order corroborated and incident above dataset above do-not-rug", () => {
    expect(SAMPLE_WEIGHT_DEFAULTS.corroborated).toBeGreaterThanOrEqual(SAMPLE_WEIGHT_DEFAULTS.incidentReport);
    expect(SAMPLE_WEIGHT_DEFAULTS.incidentReport).toBeGreaterThan(SAMPLE_WEIGHT_DEFAULTS.dataset);
    expect(SAMPLE_WEIGHT_DEFAULTS.dataset).toBeGreaterThan(SAMPLE_WEIGHT_DEFAULTS.doNotRug);
    expect(SAMPLE_WEIGHT_DEFAULTS.tokenListLegit).toBe(SAMPLE_WEIGHT_DEFAULTS.dataset);
  });

  test("detects corroborated and do-not-rug primary sources", () => {
    expect(isCorroborated({ labelNote: "Corroborated by: rug per X" })).toBe(true);
    expect(isCorroborated({ labelNote: "Heuristic label" })).toBe(false);
    expect(
      isDoNotRugPrimary({ labelSource: "Do not rug on me labeled_list.csv: label=0" }),
    ).toBe(true);
    expect(isDoNotRugPrimary({ labelSource: "Trapdoor list" })).toBe(false);
  });

  test("weakest set gets the smallest weight and unknown gets zero", () => {
    const weak = sampleWeightOf({
      label: "scam",
      labelBasis: "dataset",
      labelSource: "Do not rug on me labeled_list.csv: label=0",
      labelNote: "Heuristic label",
    });
    const strong = sampleWeightOf({
      label: "rug",
      labelBasis: "incident-report",
      labelSource: "CertiK Alert",
      labelNote: "Corroborated by: rug per X",
    });
    const legit = sampleWeightOf({
      label: "legit",
      labelBasis: "token-list",
      labelSource: "Uniswap list",
    });
    expect(weak).toBeLessThan(strong);
    expect(legit).toBe(SAMPLE_WEIGHT_DEFAULTS.dataset);
    expect(sampleWeightOf({ label: "unknown", labelBasis: "dataset" })).toBe(0);
  });

  test("partial overrides fill from defaults and bad weights fail", () => {
    const parsed = parseSampleWeights({ dataset: 5 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("expected ok");
    }
    expect(parsed.value.dataset).toBe(5);
    expect(parsed.value.doNotRug).toBe(SAMPLE_WEIGHT_DEFAULTS.doNotRug);
    expect(parseSampleWeights({ dataset: 0 }).ok).toBe(false);
    expect(parseSampleWeights({ unknown: 1 }).ok).toBe(false);
  });
});
