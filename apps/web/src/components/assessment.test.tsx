import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { AssessmentPanel } from "./AssessmentPanel.tsx";
import { RiskBadge } from "./RiskBadge.tsx";
import type { ProviderInfo } from "../types.ts";

const READY_PROVIDER: ProviderInfo = { status: "ready", provider: "hosted-open-weights", modelId: "meta-models/muse-spark-open-1026" };
const DISABLED_PROVIDER: ProviderInfo = { status: "disabled" };
const LOADING_PROVIDER: ProviderInfo = { status: "loading" };

describe("assessment panel separation", () => {
  test("design_review_idle_shows_real_provider_from_health", () => {
    const html = renderToString(
      <AssessmentPanel state={{ status: "idle" }} score={84} provider={READY_PROVIDER} onRequest={() => undefined} />,
    );
    expect(html).toContain("hosted-open-weights");
    expect(html).toContain("meta-models/muse-spark-open-1026");
  });

  test("design_review_idle_shows_disabled_when_health_reports_none", () => {
    const html = renderToString(
      <AssessmentPanel state={{ status: "idle" }} score={84} provider={DISABLED_PROVIDER} onRequest={() => undefined} />,
    );
    expect(html).toContain("not configured");
    expect(html).not.toContain("hosted-open-weights");
  });

  test("design_review_idle_shows_checking_while_health_loads", () => {
    const html = renderToString(
      <AssessmentPanel state={{ status: "idle" }} score={84} provider={LOADING_PROVIDER} onRequest={() => undefined} />,
    );
    expect(html).toContain("Checking assessment provider");
  });

  test("design_review_ready_shows_response_label", () => {
    const html = renderToString(
      <AssessmentPanel
        state={{
          status: "ready",
          text: "The owner can pause trading.",
          provider: "meta-model-api",
          modelId: "review-model-7",
        }}
        score={84}
        provider={READY_PROVIDER}
        onRequest={() => undefined}
      />,
    );
    expect(html).toContain("Meta Model API");
    expect(html).toContain("review-model-7");
  });

  test("design_review_ready_shows_meta_display_label", () => {
    const html = renderToString(
      <AssessmentPanel
        state={{ status: "idle" }}
        score={84}
        provider={{ status: "ready", provider: "meta-model-api", modelId: "muse-spark-1.3" }}
        onRequest={() => undefined}
      />,
    );
    expect(html).toContain("Meta Model API");
    expect(html).toContain("muse-spark-1.3");
  });

  test("design_review_not_configured_state_preserved", () => {
    const html = renderToString(
      <AssessmentPanel state={{ status: "not-configured" }} score={84} provider={DISABLED_PROVIDER} onRequest={() => undefined} />,
    );
    expect(html).toContain("not configured");
  });

  test("design_review_assessment_does_not_alter_score", () => {
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
        provider={READY_PROVIDER}
        onRequest={() => undefined}
      />,
    );
    const after = renderToString(<RiskBadge score={84} />);
    expect(after).toBe(before);
    expect(after).toContain("84");
    expect(after).toContain("High");
  });

  test("design_review_risk_badge_shows_number_and_word", () => {
    expect(renderToString(<RiskBadge score={12} />)).toContain("12");
    expect(renderToString(<RiskBadge score={12} />)).toContain("Low");
    expect(renderToString(<RiskBadge score={45} />)).toContain("Elevated");
  });
});
