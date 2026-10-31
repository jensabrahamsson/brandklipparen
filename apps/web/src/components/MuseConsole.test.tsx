// Muse console placement and unavailable states (UI v2 §1.2, W-3).
// The console sits under the hero with one Explain button, an optional
// Ask form and an optional Investigate button. With nothing configured
// it collapses to one line with no buttons at all, enabled or disabled.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { MuseConsole } from "./MuseConsole.tsx";
import type { AiFeatureAvailability } from "../lib/capabilities.ts";
import type { AssessmentState, HealthState, InvestigationState, ProviderInfo } from "../types.ts";

const DISABLED = { disabled: true } as const;

const NOTHING_HEALTH: HealthState = {
  assessment: DISABLED,
  investigation: DISABLED,
  explain: DISABLED,
  chat: DISABLED,
  rug: DISABLED,
  onchain: { disabled: true },
};

const NOTHING: AiFeatureAvailability = {
  investigation: "unavailable",
  explain: "unavailable",
  chat: "unavailable",
  rug: "unavailable",
  onchain: "unavailable",
};

const EXPLAIN_HEALTH: HealthState = {
  assessment: DISABLED,
  investigation: DISABLED,
  explain: { provider: "meta-model-api", modelId: "muse-spark-1.3" },
  chat: DISABLED,
  rug: DISABLED,
  onchain: { disabled: true },
};

const EXPLAIN_ONLY: AiFeatureAvailability = { ...NOTHING, explain: "available" };

const READY_PROVIDER: ProviderInfo = {
  status: "ready",
  provider: "meta-model-api",
  modelId: "muse-spark-1.3",
};

const IDLE_ASSESSMENT: AssessmentState = { status: "idle" };
const IDLE_INVESTIGATION: InvestigationState = { status: "idle" };

function consoleHtml(health: HealthState, availability: AiFeatureAvailability): string {
  return renderToString(
    <MuseConsole
      address="0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
      apiKey=""
      health={health}
      availability={availability}
      score={84}
      assessment={IDLE_ASSESSMENT}
      provider={READY_PROVIDER}
      onRequestAssessment={() => undefined}
      investigation={IDLE_INVESTIGATION}
      onRunInvestigation={() => undefined}
      signals={[]}
      onSignalLink={() => undefined}
    />,
  );
}

describe("muse console (W-3)", () => {
  test("nothing_configured_shows_one_line_with_no_buttons", () => {
    const html = consoleHtml(NOTHING_HEALTH, NOTHING);
    expect(html).toContain("Muse is not connected on this server.");
    expect(html).toContain("Everything above is computed without it.");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("disabled");
  });

  test("explain_only_shows_explain_without_ask_or_investigate", () => {
    const html = consoleHtml(EXPLAIN_HEALTH, EXPLAIN_ONLY);
    expect(html).toContain("Explain this result");
    expect(html).toContain("Muse reads the evidence above. It never changes the score.");
    expect(html).not.toContain("Ask about this token");
    expect(html).not.toContain("Investigate");
    expect(html).not.toContain("disabled");
  });

  test("console_labels_itself_and_stays_sentence_case", () => {
    const html = consoleHtml(EXPLAIN_HEALTH, EXPLAIN_ONLY);
    expect(html).toContain('aria-label="Muse console"');
    expect(html).toContain("Muse · advisory");
  });

  test("ask_form_names_the_configured_model_and_limits_length", () => {
    const html = renderToString(
      <MuseConsole
        address="0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
        apiKey=""
        health={{
          ...NOTHING_HEALTH,
          chat: { provider: "meta-model-api", modelId: "muse-spark-1.3" },
        }}
        availability={{ ...NOTHING, chat: "available" }}
        score={84}
        assessment={IDLE_ASSESSMENT}
        provider={READY_PROVIDER}
        onRequestAssessment={() => undefined}
        investigation={IDLE_INVESTIGATION}
        onRunInvestigation={() => undefined}
        signals={[]}
        onSignalLink={() => undefined}
      />,
    );
    expect(html).toContain("Ask about this token");
    expect(html).toContain("Sends your question to");
    expect(html).toContain("muse-spark-1.3");
    expect(html).toContain("Not the address.");
    expect(html).toContain('maxLength="500"');
  });
});
