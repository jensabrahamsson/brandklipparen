import { describe, expect, test } from "vitest";
import { combinedScoreLine, emptyGaugeReason, plainReason, signalTitle, sortByImpact, strongestSignal } from "./signals.ts";
import type { Signal } from "../types.ts";

const SIGNALS: readonly Signal[] = [
  {
    kind: "capability",
    id: "owner-blacklist",
    risk: "honeypot",
    direction: "raises",
    severity: "high",
    evidence: [{ selector: "0x44337ea1", offset: 2623 }],
  },
  {
    kind: "capability",
    id: "mintable",
    risk: "rug-pull",
    direction: "raises",
    severity: "low",
    evidence: [{ selector: "0x40c10f19", offset: null }],
  },
];

describe("signal descriptions (K-021)", () => {
  test("k021_strongest_signal_picks_highest_severity", () => {
    expect(strongestSignal(SIGNALS, "rug-pull")?.id).toBe("mintable");
    expect(strongestSignal(SIGNALS, "honeypot")?.id).toBe("owner-blacklist");
    expect(strongestSignal(SIGNALS, "bot-pump")).toBeUndefined();
  });

  test("k021_signal_title_is_plain_text", () => {
    expect(signalTitle(SIGNALS[0] as Signal)).toBe("Owner Blacklist");
  });

  test("design_review_sort_by_impact_raises_first_then_severity", () => {
    const lowersHigh: Signal = {
      kind: "capability",
      id: "audited-standard",
      risk: "rug-pull",
      direction: "lowers",
      severity: "high",
      evidence: [{ selector: "0x40c10f19", offset: null }],
    };
    const raisesLow: Signal = {
      kind: "capability",
      id: "mintable",
      risk: "rug-pull",
      direction: "raises",
      severity: "low",
      evidence: [{ selector: "0x40c10f19", offset: null }],
    };
    const raisesHigh: Signal = {
      kind: "capability",
      id: "owner-blacklist",
      risk: "honeypot",
      direction: "raises",
      severity: "high",
      evidence: [{ selector: "0x44337ea1", offset: 2623 }],
    };
    const sorted = sortByImpact([lowersHigh, raisesLow, raisesHigh]).map((signal) => signal.id);
    expect(sorted).toEqual(["owner-blacklist", "mintable", "audited-standard"]);
  });

  test("design_review_plain_reason_maps_known_and_empty_gauge", () => {
    expect(plainReason(SIGNALS[0] as Signal)).toBe("The owner can stop you from selling.");
    expect(plainReason(SIGNALS[1] as Signal)).toBe("The owner can create new tokens and dilute you.");
    expect(emptyGaugeReason()).toBe("Base rate for new tokens; no specific pattern found.");
  });

  test("design_review_combined_line_relates_score_to_max_probability", () => {
    expect(combinedScoreLine(84, { "rug-pull": 0.62, honeypot: 0.91, "bot-pump": 0.34 })).toBe(
      "Combined 84 follows the strongest single risk: Honeypot at 91%.",
    );
  });
});
