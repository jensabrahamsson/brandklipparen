import { describe, expect, test } from "vitest";
import {
  combinedScoreLine,
  emptyGaugeReason,
  plainReason,
  powersSummaryCopy,
  signalKey,
  signalTitle,
  sortByImpact,
  strongestSignal,
} from "./signals.ts";
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
    expect(signalTitle(SIGNALS[0] as Signal)).toBe("Owner can block transfers");
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
    expect(emptyGaugeReason()).toBe("Usual rate for new tokens.");
  });

  test("w9_base_rate_wording_only_when_no_signal_at_all", () => {
    expect(emptyGaugeReason(false)).toBe("Usual rate for new tokens.");
    expect(emptyGaugeReason(true)).toBe("No pattern found for this risk.");
    expect(emptyGaugeReason(true)).not.toContain("Base rate");
  });

  test("w9_powers_summary_found_extended_and_cant_tell", () => {
    expect(powersSummaryCopy({ found: 2, extended: 0, cantTell: 0 })).toBe("2 found.");
    expect(powersSummaryCopy({ found: 2, extended: 2, cantTell: 0 })).toBe(
      "2 found. 2 more the score doesn't count yet.",
    );
    expect(powersSummaryCopy({ found: 1, extended: 1, cantTell: 1 })).toBe(
      "1 found. 1 more the score doesn't count yet. 1 can't tell.",
    );
  });

  test("w9_powers_summary_no_scored_pattern_names_extended", () => {
    expect(powersSummaryCopy({ found: 0, extended: 1, cantTell: 0 })).toBe(
      "No scored pattern. 1 owner power the score doesn't count yet.",
    );
    expect(powersSummaryCopy({ found: 0, extended: 2, cantTell: 0 })).toBe(
      "No scored pattern. 2 owner powers the score doesn't count yet.",
    );
    expect(powersSummaryCopy({ found: 0, extended: 2, cantTell: 1 })).toBe(
      "No scored pattern. 2 owner powers the score doesn't count yet. 1 check could not be fully read.",
    );
    expect(powersSummaryCopy({ found: 0, extended: 0, cantTell: 2 })).toBe(
      "No scored pattern. 2 checks could not be fully read.",
    );
    expect(powersSummaryCopy({ found: 0, extended: 0, cantTell: 0 })).toBe(
      "No owner powers found in the code we could read.",
    );
  });

  test("score4_powers_summary_counts_floor_as_found_and_renounced_as_neither", () => {
    expect(powersSummaryCopy({ found: 1, extended: 0, cantTell: 0, floor: 1 })).toBe(
      "1 found. 1 sets the minimum score.",
    );
    expect(powersSummaryCopy({ found: 0, extended: 0, cantTell: 0, renounced: 1 })).toBe(
      "No scored pattern. 1 owner power found but owner renounced.",
    );
    expect(powersSummaryCopy({ found: 2, extended: 1, cantTell: 0, floor: 1, renounced: 1 })).toBe(
      "2 found. 1 sets the minimum score. 1 more the score doesn't count yet. 1 owner renounced.",
    );
  });

  test("design_review_combined_line_relates_score_to_max_probability", () => {
    expect(combinedScoreLine(84, { "rug-pull": 0.62, honeypot: 0.91, "bot-pump": 0.34 })).toBe(
      "Combined 84 follows the strongest single risk: Honeypot at 91%.",
    );
  });
});

describe("signal identity (S-116)", () => {
  const hexId = `0x${"ab".repeat(32)}`;

  test("s116_signal_title_never_hex", () => {
    const hex: Signal = {
      kind: "capability",
      id: hexId,
      risk: "honeypot",
      direction: "raises",
      severity: "high",
      evidence: [{ selector: "0x44337ea1", offset: 2623 }],
    };
    expect(signalTitle(hex)).not.toMatch(/0x[0-9a-f]{16,}/i);
    expect(signalTitle(hex)).toBe("Honeypot risk");
    const rugHex: Signal = { ...hex, id: hexId, risk: "rug-pull", severity: "medium" };
    expect(signalTitle(rugHex)).toBe("Rug pull risk");
    expect(plainReason(hex)).not.toMatch(/0x[0-9a-f]{16,}/i);
  });

  test("s116_signal_title_uses_capability_map", () => {
    const mintable: Signal = {
      kind: "capability",
      id: "mintable",
      risk: "rug-pull",
      direction: "raises",
      severity: "high",
      evidence: [{ selector: "0x40c10f19", offset: null }],
    };
    expect(signalTitle(mintable)).toBe("Owner can mint new tokens");
    expect(signalTitle(SIGNALS[0] as Signal)).toBe("Owner can block transfers");
  });

  test("s116_signal_key_unique_per_position", () => {
    const first = signalKey(SIGNALS[0] as Signal, 0);
    const second = signalKey(SIGNALS[0] as Signal, 1);
    expect(first).not.toBe(second);
    expect(first).toContain("0");
    expect(second).toContain("1");
  });
});
