// S-060 risk-adaptive deterministic layout (K-034, P-19). Pure: the same
// frozen analysis always yields the same section plan, DOM order equals
// visual order, and no section is hidden in any band. Only order and
// emphasis change; scores, evidence and finding text never move.
import { describe, expect, test } from "vitest";
import { SECTION_ORDER_STANDARD, planLayout } from "./layout.ts";
import type { LayoutInput } from "./layout.ts";

function frozenInput(score: number, overrides: Partial<LayoutInput> = {}): LayoutInput {
  return {
    score,
    signalCount: 2,
    severeSignalCount: 1,
    pluginFindingCount: 1,
    cantTellCount: 1,
    ...overrides,
  };
}

describe("k034_high_risk_orders_severe_evidence_first", () => {
  test("high risk pins the score summary and pulls severe evidence under it", () => {
    const plan = planLayout(frozenInput(84));
    // The sticky summary strip keys off the ring's viewport visibility,
    // so the score card stays first; severe sections come next.
    expect(plan[0]).toBe("score");
    expect(plan.indexOf("signals")).toBeLessThan(plan.indexOf("explanation"));
    expect(plan.indexOf("plugin-findings")).toBeLessThan(plan.indexOf("explanation"));
    expect(plan.indexOf("signals")).toBeLessThan(plan.indexOf("cant-tell"));
  });
});

describe("k034_low_risk_shows_calm_summary_first", () => {
  test("low risk opens with the calm score summary", () => {
    const plan = planLayout(frozenInput(12));
    expect(plan[0]).toBe("score");
  });

  test("middle band keeps the standard order", () => {
    expect(planLayout(frozenInput(45))).toEqual(SECTION_ORDER_STANDARD);
  });
});

describe("k034_same_analysis_same_layout_across_runs", () => {
  test("identical inputs give identical plans", () => {
    const first = planLayout(frozenInput(84));
    const second = planLayout(frozenInput(84));
    expect(second).toEqual(first);
  });

  test("every band keeps every section exactly once", () => {
    for (const score of [0, 12, 29, 30, 45, 59, 60, 84, 100]) {
      const plan = planLayout(frozenInput(score));
      expect([...plan].sort()).toEqual([...SECTION_ORDER_STANDARD].sort());
      expect(new Set(plan).size).toBe(plan.length);
    }
  });

  test("scores clamp to the 0-100 range without changing membership", () => {
    expect(planLayout(frozenInput(-5))[0]).toBe("score");
    expect(planLayout(frozenInput(120))[0]).toBe("score");
    expect(planLayout(frozenInput(120))).toContain("signals");
  });
});
