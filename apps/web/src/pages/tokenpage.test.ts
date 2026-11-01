import { describe, expect, test } from "vitest";
import { ApiError } from "../lib/api.ts";
import { errorCopy, meaningSentence, mergeDeepeningResult, verdictBandColor } from "./TokenPage.tsx";
import type { BoardTile } from "../components/plugins/PluginBoard.tsx";
import type { AnalyzeResult, Signal } from "../types.ts";

function assessed(overrides: Partial<Extract<AnalyzeResult, { kind: "assessed" }>> = {}): AnalyzeResult {
  return {
    kind: "assessed",
    target: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    block: 18000000,
    proxy: { kind: "none" },
    codeHash: "0xabc",
    modelVersion: "0.1.0",
    artifactChecksum: "checksum",
    indexVersion: "1.0.0",
    templateVersion: "1.0.0",
    assessedAt: 1700000000000,
    probabilities: { "rug-pull": 0.62, honeypot: 0.91, "bot-pump": 0.34 },
    score: 84,
    signals: [],
    explanation: { kind: "template", templateVersion: "1.0.0", claims: [] },
    cantTell: [],
    deepening: "pending",
    ...overrides,
  };
}

describe("deepening merge (design review P0-6)", () => {
  test("design_review_ready_flip_keeps_score_and_probabilities", () => {
    const merged = mergeDeepeningResult(assessed(), assessed({ deepening: "ready" }), false);
    expect(merged.kind).toBe("assessed");
    if (merged.kind !== "assessed") {
      return;
    }
    expect(merged.deepening).toBe("ready");
    expect(merged.score).toBe(84);
    expect(merged.probabilities["honeypot"]).toBeCloseTo(0.91);
  });

  test("design_review_mismatched_refresh_is_dropped", () => {
    const merged = mergeDeepeningResult(assessed(), assessed({ deepening: "ready", score: 12 }), false);
    expect(merged).toEqual(assessed());
  });

  test("design_review_exhausted_polls_hide_the_promise", () => {
    const merged = mergeDeepeningResult(assessed(), assessed({ deepening: "pending" }), true);
    expect(merged.kind).toBe("assessed");
    if (merged.kind !== "assessed") {
      return;
    }
    expect(merged.deepening).toBe("unavailable");
  });
});

function ownerTile(
  slug: string,
  title: string,
  state: BoardTile["state"],
  payloads: readonly unknown[] = [],
): BoardTile {
  return {
    pluginId: `dev.brandklipparen.${slug}`,
    slug,
    copy: {
      slug,
      title,
      question: `Can the owner ${slug}?`,
      pictogram: "owner",
      group: "owner",
      foundLine: () => title,
      limits: "Test limit.",
    },
    state,
    severity: "medium",
    payloads,
    evidenceCount: 0,
    orderIndex: 0,
  };
}

function capability(id: string, risk: "rug-pull" | "honeypot" | "bot-pump", severity: "low" | "medium" | "high"): Signal {
  return {
    kind: "capability",
    id,
    risk,
    direction: "raises",
    severity,
    evidence: [{ selector: "0x44337ea1", offset: 2623 }],
  };
}

describe("verdict sentence (UI v2 §1.1, W-9)", () => {
  test("w9_verdict_band_matches_ring_at_24_30_60", () => {
    const honeypotHigh = capability("owner-blacklist", "honeypot", "high");
    const byScore: Array<{ score: number; word: string }> = [
      { score: 24, word: "Low" },
      { score: 30, word: "Elevated" },
      { score: 60, word: "High" },
    ];
    for (const { score, word } of byScore) {
      const result = assessed({
        score,
        probabilities: { "rug-pull": 0.62, honeypot: 0.35, "bot-pump": 0.1 },
        signals: [capability("mintable", "rug-pull", "high"), honeypotHigh],
      });
      if (result.kind !== "assessed") {
        throw new Error("fixture must assess");
      }
      expect(meaningSentence(result).startsWith(`${word} risk.`)).toBe(true);
    }
  });

  test("w9_verdict_clause_names_found_owner_powers", () => {
    const result = assessed({
      score: 84,
      probabilities: { "rug-pull": 0.62, honeypot: 0.91, "bot-pump": 0.34 },
      signals: [capability("owner-blacklist", "honeypot", "high")],
    });
    if (result.kind !== "assessed") {
      throw new Error("fixture must assess");
    }
    const tiles = [ownerTile("blacklist", "Blacklist", "found-scored")];
    expect(meaningSentence(result, tiles)).toBe("High risk. The owner controls blacklist.");
  });

  test("w9_verdict_names_two_powers_in_board_order", () => {
    const result = assessed({
      score: 45,
      probabilities: { "rug-pull": 0.4, honeypot: 0.45, "bot-pump": 0.1 },
      signals: [capability("mintable", "rug-pull", "medium"), capability("owner-blacklist", "honeypot", "high")],
    });
    if (result.kind !== "assessed") {
      throw new Error("fixture must assess");
    }
    const tiles = [
      ownerTile("blacklist", "Blacklist", "found-scored"),
      ownerTile("transfer-hooks", "Transfer hooks", "found-scored"),
    ];
    expect(meaningSentence(result, tiles)).toBe("Elevated risk. The owner controls blacklist and transfer hooks.");
  });

  test("w9_verdict_names_no_pattern_when_quiet", () => {
    const result = assessed({
      score: 19,
      probabilities: { "rug-pull": 0.26, honeypot: 0.2, "bot-pump": 0.12 },
      signals: [],
    });
    if (result.kind !== "assessed") {
      throw new Error("fixture must assess");
    }
    expect(meaningSentence(result)).toBe(
      "Low risk. No owner power found in the code we could read. That is not the same as safe.",
    );
  });

  test("w9_verdict_never_repeats_the_risk_name_or_a_percent", () => {
    const risks = ["rug-pull", "honeypot", "bot-pump"] as const;
    const labels = ["rug pull", "honeypot", "bot-pump"] as const;
    for (let index = 0; index < risks.length; index += 1) {
      const hex: Signal = {
        kind: "capability",
        id: `0x${"ab".repeat(32)}`,
        risk: risks[index] as Signal["risk"],
        direction: "raises",
        severity: "high",
        evidence: [{ selector: "0x44337ea1", offset: 2623 }],
      };
      const result = assessed({
        score: 84,
        probabilities: { "rug-pull": 0.62, honeypot: 0.91, "bot-pump": 0.34 },
        signals: [hex],
      });
      if (result.kind !== "assessed") {
        throw new Error("fixture must assess");
      }
      const sentence = meaningSentence(result);
      expect(sentence).not.toContain("%");
      expect(sentence).not.toMatch(/\((low|medium|high)\)/i);
      const label = labels[index] as string;
      const repeats = sentence.toLowerCase().split(label).length - 1;
      expect(repeats).toBeLessThanOrEqual(1);
    }
  });
});

describe("honest verdict sentence (R2-3, D-4)", () => {
  test("r23_usdt_like_names_owner_powers_without_pattern", () => {
    const result = assessed({
      score: 29,
      probabilities: { "rug-pull": 0.35, honeypot: 0.25, "bot-pump": 0.22 },
      signals: [capability("owner-blacklist", "honeypot", "medium")],
    });
    if (result.kind !== "assessed") {
      throw new Error("fixture must assess");
    }
    const tiles = [
      ownerTile("ownership", "Ownership", "found-scored", [{ privilegedFunctions: 11 }]),
      ownerTile("blacklist", "Blacklist", "found-scored"),
      ownerTile("transfer-hooks", "Transfer hooks", "found-scored"),
    ];
    const sentence = meaningSentence(result, tiles);
    expect(sentence).toContain("blacklist");
    expect(sentence.toLowerCase()).not.toContain("pattern");
    expect(sentence).not.toContain("%");
  });

  test("r23_pepe_like_extended_names_two_unscored_powers", () => {
    const result = assessed({
      score: 19,
      probabilities: { "rug-pull": 0.26, honeypot: 0.2, "bot-pump": 0.12 },
      signals: [],
    });
    if (result.kind !== "assessed") {
      throw new Error("fixture must assess");
    }
    const tiles = [
      ownerTile("blacklist", "Blacklist", "extended", [{ fact: "blacklist", proof: "extended" }]),
      ownerTile("transfer-limits", "Transfer limits", "extended", [{ fact: "limits", proof: "extended" }]),
    ];
    const sentence = meaningSentence(result, tiles);
    expect(sentence).toContain("Extended analysis found 2");
    expect(sentence).not.toContain("%");
  });

  test("r23_sentence_never_contains_percent", () => {
    const quiet = assessed({ score: 19, signals: [] });
    const extended = assessed({ score: 19, signals: [] });
    const found = assessed({ score: 29, signals: [] });
    if (quiet.kind !== "assessed" || extended.kind !== "assessed" || found.kind !== "assessed") {
      throw new Error("fixture must assess");
    }
    const sentences = [
      meaningSentence(quiet, []),
      meaningSentence(extended, [ownerTile("mint", "Mint", "extended", [{ fact: "mint", proof: "extended" }])]),
      meaningSentence(found, [ownerTile("pause", "Pause", "found-scored")]),
    ];
    for (const sentence of sentences) {
      expect(sentence).not.toContain("%");
      expect(sentence.toLowerCase()).not.toContain("pattern");
    }
  });
});

describe("verdict caret takes the risk colour (S-132)", () => {
  test("s132_verdict_band_token_matches_badge_band", () => {
    // Same riskBand source as RiskBadge: low scores read phosphor,
    // elevated amber, high red, so the caret and badge always agree.
    expect(verdictBandColor(0)).toBe("var(--low)");
    expect(verdictBandColor(24)).toBe("var(--low)");
    expect(verdictBandColor(30)).toBe("var(--elevated)");
    expect(verdictBandColor(45)).toBe("var(--elevated)");
    expect(verdictBandColor(60)).toBe("var(--high)");
    expect(verdictBandColor(84)).toBe("var(--high)");
  });
});

describe("error copy (design review P1-14)", () => {
  test("design_review_maps_401_429_5xx_to_useful_text", () => {
    expect(errorCopy(new ApiError("auth", 401, "Unauthorized")).title).toContain("API key");
    expect(errorCopy(new ApiError("rate", 429, "Too many")).title).toContain("Rate limited");
    expect(errorCopy(new ApiError("boom", 503, "Down")).title).toContain("down");
    expect(errorCopy(new ApiError("validation-error", 400, "Invalid address: nope."))).toMatchObject({
      title: "Analysis failed.",
    });
  });

  test("s131_error_details_carry_no_implementation_strings", () => {
    for (const reason of [
      new ApiError("auth", 401, "Unauthorized"),
      new ApiError("boom", 503, "Down"),
    ]) {
      const detail = errorCopy(reason).detail;
      expect(detail).not.toContain("REST");
      expect(detail).not.toContain("contract gap");
    }
  });
});
