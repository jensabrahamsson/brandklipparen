import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { PluginsPanel } from "./PluginsPanel.tsx";

// Generic Checks panel (S-046, K-031, K-507): the panel renders from the
// registry list and the analysis pluginResults with no per-plugin UI code,
// and every plugin string renders as escaped text under the strict CSP.
const PLUGINS = [
  {
    id: "dev.brandklipparen.capability",
    version: "1.0.0",
    displayName: "Capability detector",
    description: "Reports raw capability keys.",
  },
] as const;

const RESULTS = [
  {
    pluginId: "dev.brandklipparen.capability",
    pluginVersion: "1.0.0",
    outcome: "ok",
    findings: [
      {
        id: "dev.brandklipparen.capability:selfdestruct",
        title: "Contract can self-destruct",
        evidence: [{ selector: "0xff000000", offset: null as number | null }],
      },
    ],
  },
] as const;

describe("generic plugins panel (S-046)", () => {
  test("lists registered plugins with their findings and no per-plugin code", () => {
    const html = renderToString(<PluginsPanel plugins={[...PLUGINS]} results={[...RESULTS]} />);
    expect(html).toContain("Checks");
    expect(html).toContain("Capability detector");
    expect(html).toContain("Contract can self-destruct");
    expect(html).toContain("0xff000000");
  });

  test("plugin strings render as inert escaped text", () => {
    const hostile = renderToString(
      <PluginsPanel
        plugins={[
          {
            id: "dev.brandklipparen.evil",
            version: "1.0.0",
            displayName: "<script>alert(1)</script>",
            description: "<img src=x onerror=alert(2)>",
          },
        ]}
        results={[
          {
            pluginId: "dev.brandklipparen.evil",
            pluginVersion: "1.0.0",
            outcome: "ok",
            findings: [
              {
                id: "dev.brandklipparen.evil:x",
                title: "<b>bold</b> & \"quoted\"",
                evidence: [{ selector: "<0x00>", offset: null as number | null }],
              },
            ],
          },
        ]}
      />,
    );
    expect(hostile).not.toContain("<script>");
    expect(hostile).not.toContain("<img");
    expect(hostile).not.toContain("<b>");
    expect(hostile).toContain("&lt;script&gt;");
    expect(hostile).toContain("&lt;img");
    expect(hostile).toContain("&lt;b&gt;");
  });

  test("renders results without registry metadata when the list is unavailable", () => {
    const html = renderToString(<PluginsPanel plugins={null} results={[...RESULTS]} />);
    expect(html).toContain("dev.brandklipparen.capability");
    expect(html).toContain("Contract can self-destruct");
  });

  test("extended fact findings carry the not-in-score badge and scored findings do not", () => {
    const html = renderToString(
      <PluginsPanel
        plugins={[
          ...PLUGINS,
          { id: "dev.brandklipparen.pause", version: "1.0.0", displayName: "Pause detector", description: "Quiet." },
        ]}
        results={[
          ...RESULTS,
          {
            pluginId: "dev.brandklipparen.pause",
            pluginVersion: "1.0.0",
            outcome: "ok",
            findings: [
              {
                id: "dev.brandklipparen.pause:pause-extended",
                title: "Owner can freeze transfers. Found by extended analysis; not counted in the score.",
                payload: { fact: "pause", slot: 0, mode: "pause", proof: "extended" },
                evidence: [{ selector: "0x0a9c6c1e", offset: 123 }],
              },
            ],
          },
        ]}
      />,
    );
    expect(html).toContain("Not yet scored");
    expect(html).toContain("Owner can freeze transfers.");
    // The badge renders once: the scored capability finding above carries
    // a `feature`-less capability payload, so it stays unbadged.
    const badges = html.match(/Not yet scored/g) ?? [];
    expect(badges).toHaveLength(1);
  });

  test("s120_quiet_plugins_collapse_to_one_line_with_one_explain_per_finding", () => {
    const html = renderToString(
      <PluginsPanel
        plugins={[
          ...PLUGINS,
          { id: "dev.brandklipparen.mint", version: "1.0.0", displayName: "Mint", description: "Quiet." },
          { id: "dev.brandklipparen.pause", version: "1.0.0", displayName: "Pause", description: "Quiet." },
        ]}
        results={[...RESULTS]}
      />,
    );
    expect(html).toContain("2 checks found nothing");
    expect(html).toContain("Mint, Pause");
    expect(html).not.toContain("Mint detector");
    const triggers = html.match(/explain-trigger/g) ?? [];
    // One for the plugin header and one for the finding group, none per
    // PC row: the single evidence pointer carries no trigger.
    expect(triggers).toHaveLength(2);
  });
});

describe("personalized order source (P2-18)", () => {
  const order = ["dev.brandklipparen.capability"] as const;

  test("deterministic order says the checks were sorted for the visitor", () => {
    const html = renderToString(
      <PluginsPanel plugins={[...PLUGINS]} results={[...RESULTS]} order={[...order]} personalized source="deterministic" />,
    );
    expect(html).toContain("Sorted for you.");
    expect(html).not.toContain("Sorted for you by AI");
  });

  test("ai order names the model and the visitor priorities", () => {
    const html = renderToString(
      <PluginsPanel
        plugins={[...PLUGINS]}
        results={[...RESULTS]}
        order={[...order]}
        personalized
        source="ai"
        aiModelId="example-model-1"
      />,
    );
    expect(html).toContain("Sorted for you by AI (example-model-1).");
  });

  test("ai order without a model id omits the parenthesis", () => {
    const html = renderToString(
      <PluginsPanel plugins={[...PLUGINS]} results={[...RESULTS]} order={[...order]} personalized source="ai" />,
    );
    expect(html).toContain("Sorted for you by AI.");
    expect(html).not.toContain("Sorted for you by AI (");
  });

  test("missing source keeps the deterministic notice", () => {
    const html = renderToString(
      <PluginsPanel plugins={[...PLUGINS]} results={[...RESULTS]} order={[...order]} personalized />,
    );
    expect(html).toContain("Sorted for you.");
  });
});

describe("top-ranked checks copy (N-14)", () => {
  const plugins = [
    { id: "a.sell-block", version: "1.0.0", displayName: "Sell-block", description: "Quiet." },
    { id: "a.ownership", version: "1.0.0", displayName: "Ownership", description: "Quiet." },
    { id: "a.pause", version: "1.0.0", displayName: "Pause", description: "Quiet." },
    { id: "a.mint", version: "1.0.0", displayName: "Mint", description: "Quiet." },
    { id: "a.fee", version: "1.0.0", displayName: "Fee", description: "Quiet." },
  ] as const;
  const emptyResults = [
    {
      pluginId: "a.sell-block",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [],
    },
  ] as const;

  test("names up to three top-ranked checks that found nothing", () => {
    const html = renderToString(
      <PluginsPanel
        plugins={[...plugins]}
        results={[...emptyResults]}
        order={["a.sell-block", "a.ownership", "a.pause"]}
        personalized
        source="ai"
        aiModelId="example-model-1"
      />,
    );
    expect(html).toContain("Nothing in Sell-block, Ownership, Pause.");
    expect(html).not.toContain("Checked first for you");
  });

  test("caps the top-ranked list at three names", () => {
    const html = renderToString(
      <PluginsPanel
        plugins={[...plugins]}
        results={[...emptyResults]}
        order={["a.sell-block", "a.ownership", "a.pause", "a.mint", "a.fee"]}
        personalized
        source="ai"
        aiModelId="example-model-1"
      />,
    );
    expect(html).toContain("Nothing in Sell-block, Ownership, Pause.");
    expect(html).not.toContain("Sell-block, Ownership, Pause, Mint");
  });
});
