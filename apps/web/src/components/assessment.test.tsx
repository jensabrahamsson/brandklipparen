import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { AssessmentPanel } from "./AssessmentPanel.tsx";
import { RiskBadge } from "./RiskBadge.tsx";

describe("assessment panel separation (K-305)", () => {
  test("k305_assessment_panel_shows_not_configured", () => {
    const html = renderToString(
      <AssessmentPanel state={{ status: "not-configured" }} score={84} onRequest={() => undefined} />,
    );
    expect(html).toContain("not configured");
    expect(html).toContain("open weights");
  });

  test("k305_assessment_text_mentions_open_weights_provider", () => {
    const html = renderToString(
      <AssessmentPanel
        state={{
          status: "ready",
          text: "The owner can pause trading.",
          provider: "hosted-open-weights",
          modelId: "meta-models/muse-spark-open-1026",
        }}
        score={84}
        onRequest={() => undefined}
      />,
    );
    expect(html).toContain("hosted-open-weights");
    expect(html).toContain("meta-models/muse-spark-open-1026");
    expect(html).toContain("Muse");
  });

  test("k305_assessment_does_not_alter_score_props", () => {
    const before = renderToString(<RiskBadge score={84} />);
    renderToString(
      <AssessmentPanel
        state={{
          status: "ready",
          text: "A hostile takeover narrative.",
          provider: "hosted-open-weights",
          modelId: "meta-models/muse-spark-open-1026",
        }}
        score={84}
        onRequest={() => undefined}
      />,
    );
    const after = renderToString(<RiskBadge score={84} />);
    expect(after).toBe(before);
    expect(after).toContain("84");
    expect(after).toContain("High");
  });

  test("k103_risk_badge_shows_number_and_word", () => {
    expect(renderToString(<RiskBadge score={12} />)).toContain("12");
    expect(renderToString(<RiskBadge score={12} />)).toContain("Low");
    expect(renderToString(<RiskBadge score={45} />)).toContain("Elevated");
  });
});
