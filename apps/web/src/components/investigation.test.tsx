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
        availability="available"
        signals={[]}
        onSignalLink={() => undefined}
        onRequest={() => undefined}
      />,
    );
    expect(html).toContain("Meta Model API");
    expect(html).toContain("muse-spark-1.3");
    expect(html).toContain("The frozen evidence shows the transfer guard.");
    expect(html).not.toContain("Muse concluded at the step limit.");
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
        availability="available"
        signals={[]}
        onSignalLink={() => undefined}
        onRequest={() => undefined}
      />,
    );
    expect(html).toContain("Muse concluded at the step limit.");
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
        availability="available"
        signals={[]}
        onSignalLink={() => undefined}
        onRequest={() => undefined}
      />,
    );
    expect(html).toContain("did not cite collected evidence, so it is not shown");
    expect(html).toContain("2 claims dropped by citation checking (1 uncited, 1 with unknown ids).");
  });
});
