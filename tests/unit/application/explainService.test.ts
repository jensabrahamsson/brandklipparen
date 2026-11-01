// S-094 explain service unit tests (K-302): citation checking, the
// opt-in gate and whole-output validation. Written first per A-21 (red).
import { describe, expect, test } from "vitest";
import {
  checkExplainCitations,
  createExplainService,
  isExplainCoverageId,
} from "../../../src/application/explainService.ts";
import { ExplainInput } from "../../../src/ports/explainModel.ts";
import type { ExplainInput as ExplainInputType } from "../../../src/ports/explainModel.ts";
import { FakeExplainModelAdapter } from "../../fakes/fakeExplainModel.ts";

function testInput(): ExplainInputType {
  const created = ExplainInput.create({
    codeHash: "code-hash-for-unit-suite",
    evidenceIds: ["signal:first", "signal:second"],
    promptVersion: "explain-1",
  });
  if (created === null) {
    throw new Error("expected valid explain input");
  }
  return created;
}

describe("explain service (S-094)", () => {
  test("s094_checker_keeps_only_cited_collected_sentences", () => {
    const checked = checkExplainCitations(
      [
        { text: "Cited and collected.", citations: ["signal:first"] },
        { text: "Cites an uncollected id.", citations: ["signal:absent"] },
        { text: "Uncited factual sentence.", citations: [] },
      ],
      new Set(["signal:first", "signal:second"]),
    );
    expect(checked.narrative).toEqual(["Cited and collected."]);
    expect(checked.droppedClaims).toBe(2);
  });

  test("s094_checker_empty_survivors_yields_empty_narrative", () => {
    const checked = checkExplainCitations(
      [{ text: "Cites an uncollected id.", citations: ["signal:absent"] }],
      new Set(["signal:first"]),
    );
    expect(checked.narrative).toEqual([]);
    expect(checked.droppedClaims).toBe(1);
  });

  test("s094_disabled_service_reports_not_configured", async () => {
    const service = createExplainService(null);
    expect(service.enabled).toBe(false);
    expect(await service.explain(testInput())).toEqual({ kind: "not-configured" });
  });

  test("s094_invalid_output_discards_whole_overlay", async () => {
    const service = createExplainService(new FakeExplainModelAdapter("invalid-output"));
    expect(await service.explain(testInput())).toEqual({ kind: "invalid-output" });
  });

  test("s094_mixed_output_counts_drops", async () => {
    const fake = new FakeExplainModelAdapter("mixed");
    const service = createExplainService(fake);
    const outcome = await service.explain(testInput());
    expect(fake.calls.length).toBe(1);
    if (outcome.kind !== "ok") {
      throw new Error(`expected ok, got ${outcome.kind}`);
    }
    expect(outcome.narrative).toEqual(["The analysis reports a capability."]);
    expect(outcome.droppedClaims).toBe(2);
  });

  test("s094_coverage_checker_accepts_exactly_the_known_coverage_shapes", () => {
    expect(isExplainCoverageId("analysis:summary")).toBe(true);
    expect(isExplainCoverageId("cant-tell:liquidity-locks")).toBe(true);
    expect(isExplainCoverageId("check:dev.brandklipparen.pause:not-found")).toBe(true);
    expect(isExplainCoverageId("check:dev.brandklipparen.pause:could-not-check")).toBe(true);
    expect(isExplainCoverageId("signal:first")).toBe(false);
    expect(isExplainCoverageId("cant-tell:made-up-question")).toBe(false);
    expect(isExplainCoverageId("cant-tell:")).toBe(false);
    expect(isExplainCoverageId("check:pause:found")).toBe(false);
    expect(isExplainCoverageId("check::not-found")).toBe(false);
    const collected = new Set(["cant-tell:code-intent", "analysis:summary", "signal:first"]);
    const checked = checkExplainCitations(
      [
        { text: "Checked code intent, which bytecode cannot tell.", citations: ["cant-tell:code-intent"] },
        { text: "Coverage summary holds.", citations: ["analysis:summary"] },
        { text: "A claim cites an unknown question.", citations: ["cant-tell:made-up-question"] },
      ],
      collected,
    );
    expect(checked.narrative).toEqual([
      "Checked code intent, which bytecode cannot tell.",
      "Coverage summary holds.",
    ]);
    expect(checked.droppedClaims).toBe(1);
  });

  test("s094_coverage_answers_survive_with_zero_findings", async () => {
    const created = ExplainInput.create({
      codeHash: "code-hash-for-unit-suite",
      evidenceIds: [
        "cant-tell:liquidity-locks",
        "cant-tell:code-intent",
        "check:dev.brandklipparen.pause:not-found",
        "analysis:summary",
      ],
      promptVersion: "explain-3",
    });
    if (created === null) {
      throw new Error("expected valid explain input");
    }
    const service = createExplainService(new FakeExplainModelAdapter("coverage"));
    const outcome = await service.explain(created);
    if (outcome.kind !== "ok") {
      throw new Error(`expected ok, got ${outcome.kind}`);
    }
    expect(outcome.narrative.length).toBe(3);
    expect(outcome.droppedClaims).toBe(0);
  });
});
