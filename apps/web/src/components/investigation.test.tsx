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
  });
});
