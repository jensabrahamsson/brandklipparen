import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { PluginsPanel } from "./PluginsPanel.tsx";

// Generic Plugins panel (S-046, K-031, K-507): the panel renders from the
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
    expect(html).toContain("Plugins");
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
    expect(html).toContain("2 detectors found nothing");
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

  test("deterministic order names what matters to the visitor", () => {
    const html = renderToString(
      <PluginsPanel plugins={[...PLUGINS]} results={[...RESULTS]} order={[...order]} personalized source="deterministic" />,
    );
    expect(html).toContain("Ordered by what matters to you.");
    expect(html).not.toContain("Ordered by AI");
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
    expect(html).toContain("Ordered by AI (example-model-1) from your priorities.");
  });

  test("ai order without a model id omits the parenthesis", () => {
    const html = renderToString(
      <PluginsPanel plugins={[...PLUGINS]} results={[...RESULTS]} order={[...order]} personalized source="ai" />,
    );
    expect(html).toContain("Ordered by AI from your priorities.");
    expect(html).not.toContain("Ordered by AI (");
  });

  test("missing source keeps the deterministic notice", () => {
    const html = renderToString(
      <PluginsPanel plugins={[...PLUGINS]} results={[...RESULTS]} order={[...order]} personalized />,
    );
    expect(html).toContain("Ordered by what matters to you.");
  });
});
