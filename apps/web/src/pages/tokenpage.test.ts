import { describe, expect, test } from "vitest";
import { ApiError } from "../lib/api.ts";
import { errorCopy, mergeDeepeningResult } from "./TokenPage.tsx";
import type { AnalyzeResult } from "../types.ts";

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

describe("error copy (design review P1-14)", () => {
  test("design_review_maps_401_429_5xx_to_useful_text", () => {
    expect(errorCopy(new ApiError("auth", 401, "Unauthorized")).title).toContain("API key");
    expect(errorCopy(new ApiError("rate", 429, "Too many")).title).toContain("Rate limited");
    expect(errorCopy(new ApiError("boom", 503, "Down")).title).toContain("down");
    expect(errorCopy(new ApiError("validation-error", 400, "Invalid address: nope."))).toMatchObject({
      title: "Analysis failed.",
    });
  });
});
