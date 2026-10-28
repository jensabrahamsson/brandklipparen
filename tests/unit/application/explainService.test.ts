// S-094 explain service unit tests (K-302): citation checking, the
// opt-in gate and whole-output validation. Written first per A-21 (red).
import { describe, expect, test } from "vitest";
import { checkExplainCitations, createExplainService } from "../../../src/application/explainService.ts";
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
});
