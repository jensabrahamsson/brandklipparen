// N-15 component tests for the Customize view (chip, Apply, Reset,
// Jump, moved sections) and the grouped token address. Behavior based:
// rendered text, roles, accessible names and heading order only. Uses the
// existing renderToString pattern and synthetic fixtures; fetch stays
// mocked so no test reaches the network.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { CustomizeView, OverviewSections } from "./TokenPage.tsx";
import { TokenHeader, groupAddressChunks } from "../components/TokenHeader.tsx";
import { PICKABLE_SECTIONS } from "../components/FieldPicker.tsx";
import { toChecksumAddress } from "../lib/checksumAddress.ts";
import { syntheticAddress } from "../lib/syntheticAddresses.ts";
import { planLayout } from "../lib/layout.ts";
import { applyAiSectionOrder } from "../lib/personalize.ts";
import type { AiPersonalizeSpec } from "../lib/personalize.ts";
import type { AnalyzeResult } from "../types.ts";

vi.mock("../components/CopyButton.tsx", async () => {
  const React = await import("react");
  return {
    CopyButton: ({ value, label }: { readonly value: string; readonly label: string }) =>
      React.createElement(
        "button",
        { type: "button", "aria-label": label, "data-copy-value": value },
        "Copy",
      ),
  };
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("no network in component tests")),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const PROVIDER = {
  provider: "Meta",
  modelId: "meta-models/muse-spark-open-1026",
};

function visibleAll(): ReadonlySet<string> {
  return new Set(["score", ...PICKABLE_SECTIONS.map((section) => section.id)]);
}

function renderCustomize(overrides: {
  readonly aiOn?: boolean;
  readonly aiApplied?: boolean;
  readonly aiPending?: boolean;
  readonly priorities?: string;
  readonly aiNotice?: { readonly text: string; readonly kind: "applied" | "failed" | "info" } | null;
}): string {
  const aiOn = overrides.aiOn ?? true;
  const aiApplied = overrides.aiApplied ?? false;
  const aiPending = overrides.aiPending ?? false;
  const priorities = overrides.priorities ?? "";
  const aiNotice = overrides.aiNotice ?? null;
  return renderToString(
    <CustomizeView
      mode="simple"
      onModeChange={() => undefined}
      aiOn={aiOn}
      onToggleAi={() => undefined}
      aiProvider={PROVIDER}
      aiPending={aiPending}
      onApplyAiOrder={() => undefined}
      aiNotice={aiNotice}
      aiApplied={aiApplied}
      onResetAiOrder={() => undefined}
      visibleSections={visibleAll()}
      onToggleSection={() => undefined}
      priorities={priorities}
      onPrioritiesChange={() => undefined}
      onPrioritiesClear={() => undefined}
    />,
  );
}

function assessedResult(): Extract<AnalyzeResult, { kind: "assessed" }> {
  const target = syntheticAddress(7);
  return {
    kind: "assessed",
    target,
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
    signals: [
      {
        kind: "capability",
        id: "owner-blacklist",
        risk: "honeypot",
        direction: "raises",
        severity: "high",
        evidence: [{ selector: "0x44337ea1", offset: 2623 }],
      },
    ],
    explanation: {
      kind: "template",
      templateVersion: "1.0.0",
      claims: [
        {
          text: "The owner can stop you from selling.",
          signalLinks: ["owner-blacklist"],
          temporality: { kind: "can-change" },
        },
      ],
    },
    cantTell: [{ question: "Who holds the liquidity?", dataSource: "liquidity locks" }],
    deepening: "ready",
    pluginResults: [],
  };
}

function aiSpecMoving(): AiPersonalizeSpec {
  return {
    pluginRanking: [],
    placements: [
      { sectionId: "signals", emphasis: "high", collapsed: false },
      { sectionId: "score", emphasis: "normal", collapsed: false },
      { sectionId: "explanation", emphasis: "normal", collapsed: false },
    ],
  };
}

function renderOverview(aiSpec: AiPersonalizeSpec | null): string {
  const result = assessedResult();
  return renderToString(
    <OverviewSections
      result={result}
      heroBreakdown={false}
      plugins={[]}
      mode="simple"
      aiSpec={aiSpec}
      aiModelId={PROVIDER.modelId}
      priorities="Can the owner stop me selling?"
      standardOrder={false}
      onShowStandardOrder={() => undefined}
      sorted={result.signals}
      templateLine={() => "The owner can stop you from selling."}
      openSignals={new Set<string>()}
      onToggleSignal={() => undefined}
      onSignalLink={() => undefined}
      visibleSections={visibleAll()}
      liveEntry={null}
    />,
  );
}

function sectionOrder(html: string): string[] {
  return [...html.matchAll(/data-section="([^"]+)"/g)].map((match) => match[1] ?? "");
}

function headingTexts(html: string): string[] {
  const text = html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]+>/g, "|")
    .replace(/\|+/g, "|");
  return text
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

describe("customize chip opens the panel", () => {
  test("chip carries an accessible name and targets the customize panel", () => {
    const html = renderCustomize({ aiOn: true, priorities: "Can the owner stop me selling?" });
    expect(html).toContain('data-testid="ai-order-bar"');
    expect(html).toContain('aria-controls="customize-panel"');
    expect(html).toContain('aria-label="Edit AI priorities (AI order on,');
    expect(html).toContain('id="customize-panel"');
    expect(html).toContain("Customize view");
  });

  test("empty AI-on draft renders the panel open", () => {
    const html = renderCustomize({ aiOn: true, priorities: "" });
    expect(html).toContain('id="customize-panel"');
    expect(html).toMatch(/<details[^>]*id="customize-panel"[^>]*open/);
  });
});

describe("apply disabled state", () => {
  test("empty priorities expose aria-disabled and the enabling hint", () => {
    const html = renderCustomize({ aiOn: true, priorities: "" });
    expect(html).toContain('data-testid="ai-personalize-apply"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Type what matters to you above to enable.");
  });

  test("filled priorities clear the disabled flag and hide the hint", () => {
    const html = renderCustomize({ aiOn: true, priorities: "Can the owner stop me selling?" });
    expect(html).toContain('aria-disabled="false"');
    expect(html).toContain("ai-apply-hint");
    expect(html).toContain("visibility:hidden");
  });
});

describe("reset restores the standard order", () => {
  test("reset appears only after a successful apply", () => {
    const before = renderCustomize({ aiOn: true, aiApplied: false, priorities: "x" });
    const beforeReset = before.match(/<button[^>]*data-testid="ai-personalize-reset"[^>]*>/)?.[0] ?? "";
    expect(before).toContain("Reset to standard order");
    expect(beforeReset).toContain("visibility:hidden");
    const after = renderCustomize({
      aiOn: true,
      aiApplied: true,
      priorities: "x",
      aiNotice: { text: "AI order applied. Scores, evidence and text are unchanged.", kind: "applied" },
    });
    const afterReset = after.match(/<button[^>]*data-testid="ai-personalize-reset"[^>]*>/)?.[0] ?? "";
    expect(after).toContain("Reset to standard order");
    expect(afterReset).not.toContain("visibility:hidden");
    expect(afterReset).not.toContain("aria-hidden");
  });

  test("clearing the spec restores the deterministic plan order", () => {
    const result = assessedResult();
    const plan = planLayout({
      score: result.score,
      signalCount: result.signals.length,
      severeSignalCount: result.signals.filter((signal) => signal.severity === "high").length,
      pluginFindingCount: 0,
      cantTellCount: result.cantTell.length,
    });
    const applied = applyAiSectionOrder(plan, aiSpecMoving(), ["score", "explanation", "signals"]);
    expect(applied).not.toEqual(plan);
    const standardHtml = renderOverview(null);
    const appliedHtml = renderOverview(aiSpecMoving());
    expect(sectionOrder(standardHtml)).toEqual([...plan]);
    expect(sectionOrder(appliedHtml)).toEqual([...applied]);
    expect(sectionOrder(appliedHtml)[0]).toBe("score");
    expect(sectionOrder(appliedHtml)[1]).toBe("explanation");
  });
});

describe("jump to results visibility", () => {
  test("jump shows only when AI is on and applied", () => {
    expect(renderCustomize({ aiOn: false, aiApplied: false })).not.toContain("ai-jump-results");
    expect(renderCustomize({ aiOn: true, aiApplied: false })).not.toContain("ai-jump-results");
    const html = renderCustomize({ aiOn: true, aiApplied: true, priorities: "x" });
    expect(html).toContain('data-testid="ai-jump-results"');
    expect(html).toContain("Jump to results");
  });
});

describe("moved sections carry the marker", () => {
  test("applied order marks moved sections without moving scores or evidence", () => {
    const html = renderOverview(aiSpecMoving());
    expect(html).toContain("ai-moved");
    expect(html).toContain("AI PRIORITY");
    expect(html).toContain('data-testid="ai-emphasis-signals"');
    const headings = headingTexts(html);
    const risk = headings.findIndex((text) => text.includes("Risk breakdown"));
    const why = headings.findIndex((text) => text.includes("Why this score"));
    expect(risk).toBeGreaterThanOrEqual(0);
    expect(why).toBeGreaterThan(risk);
    // The score card and "Why this score" stay the first two sections.
    expect(sectionOrder(html).slice(0, 2)).toEqual(["score", "explanation"]);
  });
});

describe("grouped token address keeps the exact value", () => {
  test("chunks join to the full EIP-55 string with no spaces in copy or accessible text", () => {
    const raw = syntheticAddress(11);
    const checksummed = toChecksumAddress(raw);
    const chunks = groupAddressChunks(checksummed);
    expect(chunks.join("")).toBe(checksummed);
    for (const chunk of chunks) {
      expect(chunk).not.toContain(" ");
      expect(chunk.length).toBeLessThanOrEqual(4);
    }
    const html = renderToString(
      <TokenHeader address={raw} identity={{ symbol: null, name: null }} liveEntry={null} />,
    );
    expect(html).toContain(`data-copy-value="${checksummed}"`);
    expect(html).toContain("addr-chunk");
    const stripped = html.replace(/<[^>]*>/g, "");
    expect(stripped).toContain(checksummed);
    const copied = html.match(/data-copy-value="([^"]+)"/)?.[1] ?? "";
    expect(copied).toBe(checksummed);
    expect(copied).not.toContain(" ");
  });
});
