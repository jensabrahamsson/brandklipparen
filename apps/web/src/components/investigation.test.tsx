import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { InvestigationPanel } from "./InvestigationPanel.tsx";

// Provider badge for a completed Meta investigation (M-2): the display
// label and model id from the response, rendered as text only.
describe("investigation panel provider badge", () => {
  test("done_state_shows_meta_display_label_and_model", () => {
    const html = renderToString(
      <InvestigationPanel
        state={{
          status: "done",
          steps: [],
          narrative: "The frozen evidence shows the transfer guard.",
          droppedClaims: 0,
          provider: "meta-model-api",
          modelId: "muse-spark-1.3",
          forcedConclusion: false,
        }}
        score={84}
        signals={[]}
        address="0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
        allIds={[]}
        onSignalLink={() => undefined}
        onRequest={() => undefined}
      />,
    );
    expect(html).toContain("Muse Spark 1.3 · Meta");
    expect(html).not.toContain("Meta Model API");
    expect(html).toContain("The frozen evidence shows the transfer guard.");
    expect(html).not.toContain("Step limit reached.");
  });

  test("forced_conclusion_shows_one_step_limit_line", () => {
    const html = renderToString(
      <InvestigationPanel
        state={{
          status: "done",
          steps: [],
          narrative: "The frozen evidence shows the transfer guard.",
          droppedClaims: 0,
          provider: "meta-model-api",
          modelId: "muse-spark-1.3",
          forcedConclusion: true,
        }}
        score={84}
        signals={[]}
        address="0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
        allIds={[]}
        onSignalLink={() => undefined}
        onRequest={() => undefined}
      />,
    );
    expect(html).toContain("Step limit reached.");
  });

  test("empty_narrative_names_the_missing_citation_with_reason_counts", () => {
    const html = renderToString(
      <InvestigationPanel
        state={{
          status: "done",
          steps: [],
          narrative: "",
          droppedClaims: 2,
          dropReasons: { uncited: 1, unknownId: 1 },
          provider: "meta-model-api",
          modelId: "muse-spark-1.3",
          forcedConclusion: false,
        }}
        score={84}
        signals={[]}
        address="0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
        allIds={[]}
        onSignalLink={() => undefined}
        onRequest={() => undefined}
      />,
    );
    expect(html).toContain("did not cite collected evidence, so it is not shown");
    expect(html).toContain("<summary>Details</summary>");
    expect(html).toContain("2 sentences removed: 1 cited nothing, 1 cited an unknown id.");
  });

  test("idle_starts_the_run_with_no_second_button", () => {
    const html = renderToString(
      <InvestigationPanel
        state={{ status: "idle" }}
        score={84}
        signals={[]}
        address="0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
        allIds={[]}
        onSignalLink={() => undefined}
        onRequest={() => undefined}
      />,
    );
    expect(html).toContain("Investigating");
    expect(html).not.toContain("Request investigation");
  });
});
