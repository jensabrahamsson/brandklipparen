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
});
