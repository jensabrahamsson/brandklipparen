// Token page overview after W-8 (Option A): sections always render in
// the deterministic plan order however the Ask field reads; the question
// only highlights matching tiles and orders the third-party fallback
// through the local matcher, with zero network. Behavior based: rendered
// text, roles, order of sections and test ids only, with synthetic
// fixtures; fetch stays mocked so no test reaches the network.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { OverviewSections } from "./TokenPage.tsx";
import { syntheticAddress } from "../lib/syntheticAddresses.ts";
import { planLayout } from "../lib/layout.ts";
import type { PluginListEntry } from "../components/PluginsPanel.tsx";
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

const PLUGINS: PluginListEntry[] = [
  {
    id: "dev.brandklipparen.capability",
    version: "1.0.0",
    displayName: "Capability detector",
    description: "Reports structural bytecode capabilities.",
    outputSchema: { type: "array" },
    frontmatter: {
      tags: ["owner-powers", "upgradeability"],
      audience: ["holder"],
      severity: { min: "low", max: "high" },
    },
  },
  {
    id: "dev.brandklipparen.clone-match",
    version: "1.0.0",
    displayName: "Clone-match detector",
    description: "Matches known trap templates.",
    outputSchema: { type: "array" },
    frontmatter: {
      tags: ["honeypot"],
      audience: ["holder"],
      severity: { min: "medium", max: "high" },
    },
  },
  {
    id: "dev.example.custom-check",
    version: "1.0.0",
    displayName: "Custom check",
    description: "A third-party check.",
    frontmatter: {
      tags: ["honeypot"],
      audience: ["holder"],
      severity: { min: "low", max: "high" },
    },
  },
];

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
    pluginResults: [
      {
        pluginId: "dev.brandklipparen.capability",
        pluginVersion: "1.0.0",
        outcome: "ok",
        findings: [
          {
            id: "dev.brandklipparen.capability:call",
            title: "Contract can forward calls",
            payload: { capability: "call" },
            evidence: [{ selector: "0x12345678", offset: 26 }],
          },
        ],
      },
      {
        pluginId: "dev.brandklipparen.clone-match",
        pluginVersion: "1.0.0",
        outcome: "ok",
        findings: [
          {
            id: "dev.brandklipparen.clone-match:drain-template",
            title: "Bytecode matches a known trap template",
            payload: { similarity: 0.9, group: "drain-template", priorCount: 3 },
            evidence: [{ selector: "0x44337ea1", offset: 2623 }],
          },
        ],
      },
    ],
  };
}

function renderOverview(question: string, mode: "simple" | "expert" = "simple"): string {
  const result = assessedResult();
  return renderToString(
    <OverviewSections
      result={result}
      plugins={PLUGINS}
      address={syntheticAddress(7)}
      mode={mode}
      question={question}
      sorted={result.signals}
      liveEntry={null}
      apiKey=""
      onchainAvailability="available"
    />,
  );
}

function sectionOrder(html: string): string[] {
  return [...html.matchAll(/data-section="([^"]+)"/g)].map((match) => match[1] ?? "");
}

function expectedPlan(): readonly string[] {
  const result = assessedResult();
  // R2-2: the hero always owns the gauges, so the overview never renders
  // the score section even though the deterministic plan still emits it.
  // R2-6: the signals position maps onto the merged "Why this score"
  // card, rendered once at the earliest spot.
  return planLayout({
    score: result.score,
    signalCount: result.signals.length,
    severeSignalCount: result.signals.filter((signal) => signal.severity === "high").length,
    pluginFindingCount: 2,
    cantTellCount: result.cantTell.length,
  })
    .filter((sectionId) => sectionId !== "score")
    .map((sectionId) => (sectionId === "signals" ? "explanation" : sectionId))
    .filter((sectionId, index, all) => all.indexOf(sectionId) === index);
}

describe("deterministic section order (W-8 option A)", () => {
  test("the ask text never reorders the sections", () => {
    const plan = [...expectedPlan()];
    expect(sectionOrder(renderOverview(""))).toEqual(plan);
    expect(sectionOrder(renderOverview("Can the owner stop me selling?"))).toEqual(plan);
    expect(sectionOrder(renderOverview("What a nice day for a walk"))).toEqual(plan);
  });

  test("no ai reorder, emphasis or collapse markers render", () => {
    for (const html of [renderOverview(""), renderOverview("Can the owner stop me selling?")]) {
      expect(html).not.toContain("ai-moved");
      expect(html).not.toContain("ai-emphasis");
      expect(html).not.toContain("ai-expand-");
      expect(html).not.toContain("ai-personalize");
      expect(html).not.toContain("data-emphasis");
      expect(html).not.toContain("data-collapsed");
    }
  });
});

describe("local question match highlights tiles (K-035)", () => {
  test("matching question tags the plugin tiles and orders the fallback", () => {
    const html = renderOverview("Can the owner stop me selling?");
    expect(html).toContain("Matches your question");
    expect(html).toContain('data-testid="matched-dev.brandklipparen.clone-match"');
    expect(html).toContain("Ordered by what matters to you.");
    expect(html).toContain("Show standard order");
  });

  test("unrelated question leaves tiles and order untouched", () => {
    const html = renderOverview("What a nice day for a walk");
    expect(html).not.toContain("Matches your question");
    expect(html).not.toContain("matched-dev.brandklipparen.clone-match");
    expect(html).not.toContain("Ordered by what matters to you.");
  });

  test("clearing the question removes every tag", () => {
    expect(renderOverview("")).not.toContain("Matches your question");
  });
});

describe("token grid areas (R2-7 D-8)", () => {
  test("board_and_cant_span_full_width_with_facts_beside_main", () => {
    const html = renderOverview("");
    // Each overview section maps onto its grid area.
    expect(html).toContain('data-section="explanation"');
    expect(html).toContain("token-main");
    expect(html).toContain('data-section="plugin-findings"');
    expect(html).toContain("token-board");
    expect(html).toContain('data-section="cant-tell"');
    expect(html).toContain("token-cant");
    // The board hosts container queries for its tiles.
    expect(html).toContain("plugin-board");
    // Facts sit beside main at desktop and below the board under 1100 px,
    // so the facts aside renders after the board in DOM order.
    const boardAt = html.indexOf('data-testid="plugin-board"');
    const factsAt = html.indexOf("Contract facts");
    expect(boardAt).toBeGreaterThanOrEqual(0);
    expect(factsAt).toBeGreaterThan(boardAt);
    expect(html).toContain("token-facts");
  });
});

describe("expert mode detail (K-034)", () => {
  test("expert_renders_the_expert_detail_section", () => {
    const html = renderOverview("", "expert");
    expect(html).toContain('data-testid="expert-detail"');
    expect(html).toContain("Raw response data as inert text.");
  });

  test("simple_mode_hides_the_expert_detail_section", () => {
    expect(renderOverview("", "simple")).not.toContain('data-testid="expert-detail"');
  });
});

describe("desktop grid balance (R3 D-13)", () => {
  test("signals_choose_the_side_grid_and_empty_signals_choose_the_flat_grid", () => {
    const withSignals = renderOverview("");
    expect(withSignals).toContain("token-grid--side");
    expect(withSignals).not.toContain("token-grid--flat");
    const empty = assessedResult();
    const noSignals = { ...empty, signals: [] };
    const flat = renderToString(
      <OverviewSections
        result={noSignals}
        plugins={PLUGINS}
        address={syntheticAddress(7)}
        mode="simple"
        question=""
        sorted={[]}
        liveEntry={null}
        apiKey=""
        onchainAvailability="available"
      />,
    );
    expect(flat).toContain("token-grid--flat");
    expect(flat).not.toContain("token-grid--side");
  });
});
