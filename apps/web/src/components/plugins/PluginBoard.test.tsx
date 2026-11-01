// Plugin board unit test (UI v2 §5.1): 9 owner-power tiles plus 4 tool
// tiles, each with a status word, grouped and sorted with a summary.
// Behavior based: rendered text and order only, with synthetic fixtures.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { PluginBoard } from "./PluginBoard.tsx";
import { syntheticAddress } from "../../lib/syntheticAddresses.ts";
import type { PluginListEntry, PluginResultView } from "../PluginsPanel.tsx";

const ADDRESS = syntheticAddress(3);

function entry(id: string, max: "low" | "medium" | "high"): PluginListEntry {
  const short = id.split(".").pop() ?? id;
  return {
    id,
    version: "1.0.0",
    displayName: `${short} detector`,
    description: `Reports ${short}.`,
    frontmatter: { tags: ["holder"], audience: ["holder"], severity: { min: "low", max: max } },
  };
}

const PLUGINS: PluginListEntry[] = [
  entry("dev.brandklipparen.ownership", "high"),
  entry("dev.brandklipparen.pause", "high"),
  entry("dev.brandklipparen.blacklist", "high"),
  entry("dev.brandklipparen.mint", "high"),
  entry("dev.brandklipparen.transfer-fee", "high"),
  entry("dev.brandklipparen.transfer-limits", "high"),
  entry("dev.brandklipparen.sell-block", "high"),
  entry("dev.brandklipparen.transfer-hooks", "high"),
  entry("dev.brandklipparen.proxy-upgrade", "high"),
  entry("dev.brandklipparen.capability", "high"),
  entry("dev.brandklipparen.decompiler", "medium"),
  entry("dev.brandklipparen.clone-match", "high"),
  entry("dev.brandklipparen.hard-to-analyze", "high"),
];

function ok(id: string, findings: PluginResultView["findings"] = []): PluginResultView {
  return { pluginId: id, pluginVersion: "1.0.0", outcome: "ok", findings };
}

const RESULTS: PluginResultView[] = [
  { pluginId: "dev.brandklipparen.ownership", pluginVersion: "1.0.0", outcome: "threw", findings: [] },
  ok("dev.brandklipparen.pause"),
  ok("dev.brandklipparen.blacklist", [
    {
      id: "dev.brandklipparen.blacklist:blacklist",
      title: "Blocked wallets",
      payload: { feature: "blacklist" },
      evidence: [
        { selector: "0x44337ea1", offset: 200 },
        { selector: "0x44337ea1", offset: 400 },
      ],
    },
  ]),
  ok("dev.brandklipparen.mint", [
    {
      id: "dev.brandklipparen.mint:mint-extended",
      title: "Mint, extended",
      payload: { fact: "mint", proof: "extended", capped: true },
      evidence: [{ selector: "0x40c10f19", offset: 100 }],
    },
  ]),
  { pluginId: "dev.brandklipparen.transfer-fee", pluginVersion: "1.0.0", outcome: "input-unavailable", findings: [] },
  ok("dev.brandklipparen.transfer-limits"),
  ok("dev.brandklipparen.sell-block"),
  ok("dev.brandklipparen.transfer-hooks"),
  ok("dev.brandklipparen.proxy-upgrade"),
  ok("dev.brandklipparen.capability", [
    {
      id: "dev.brandklipparen.capability:call",
      title: "Calls out",
      payload: { capability: "call" },
      evidence: [{ selector: "0x12345678", offset: 26 }],
    },
  ]),
  ok("dev.brandklipparen.decompiler", [
    {
      id: "dev.brandklipparen.decompiler:0x70a08231",
      title: "balanceOf",
      payload: { selector: "0x70a08231", name: "balanceOf", cause: null },
      evidence: [{ selector: "0x70a08231", offset: 26 }],
    },
  ]),
  ok("dev.brandklipparen.clone-match"),
  ok("dev.brandklipparen.hard-to-analyze"),
];

describe("plugin board (UI v2 §5.1)", () => {
  test("renders nine owner tiles and four tool tiles with status words", () => {
    const html = renderToString(<PluginBoard address={ADDRESS} plugins={PLUGINS} results={RESULTS} />);
    const tiles = html.match(/data-testid="plugin-tile-/g) ?? [];
    expect(tiles).toHaveLength(13);
    expect(html).toContain("What we checked");
    expect(html).toContain("Owner powers");
    expect(html).toContain("Analysis tools");
    for (const word of ["Found · High", "Found", "Error", "Not run", "Not found"]) {
      expect(html).toContain(word);
    }
    expect(html).toContain("Extended analysis");
  });

  test("a hard read turns quiet tiles into can't tell", () => {
    const hard = RESULTS.map((result) =>
      result.pluginId === "dev.brandklipparen.hard-to-analyze"
        ? ok("dev.brandklipparen.hard-to-analyze", [
            {
              id: "dev.brandklipparen.hard-to-analyze:timeout",
              title: "Slow read",
              payload: { cause: "timeout" },
              evidence: [{ selector: "0x12345678", offset: null }],
            },
          ])
        : result,
    );
    const html = renderToString(<PluginBoard address={ADDRESS} plugins={PLUGINS} results={hard} />);
    expect(html).toContain("Can&#x27;t tell");
  });

  test("found tiles sort before quiet ones inside the owner group", () => {
    const html = renderToString(<PluginBoard address={ADDRESS} plugins={PLUGINS} results={RESULTS} />);
    const blacklist = html.indexOf("plugin-tile-blacklist");
    const pause = html.indexOf("plugin-tile-pause");
    expect(blacklist).toBeGreaterThan(-1);
    expect(pause).toBeGreaterThan(-1);
    expect(blacklist).toBeLessThan(pause);
  });

  test("summary names the owner-power counts", () => {
    const html = renderToString(<PluginBoard address={ADDRESS} plugins={PLUGINS} results={RESULTS} />);
    expect(html).toContain("owner powers checked");
    expect(html).toContain("not in score");
  });

  test("tiles link to the plugin detail route", () => {
    const html = renderToString(<PluginBoard address={ADDRESS} plugins={PLUGINS} results={RESULTS} />);
    expect(html).toContain(`/plugins/blacklist`);
  });

  test("r3_tools_run_neutrally_with_no_severity_rail_or_fill", () => {
    const html = renderToString(<PluginBoard address={ADDRESS} plugins={PLUGINS} results={RESULTS} />);
    expect(html).toContain("Ran · 1 function");
    for (const slug of ["capability", "decompiler", "clone-match", "hard-to-analyze"]) {
      const start = html.indexOf(`data-testid="plugin-tile-${slug}"`);
      expect(start).toBeGreaterThan(-1);
      expect(html.slice(start, html.indexOf("</a>", start))).not.toContain("tile-rail");
    }
    // The Ran state carries the tool glyph in a neutral lamp: no
    // severity lamp or rail inside a ran tile anchor.
    const cap = html.indexOf('data-testid="plugin-tile-capability"');
    const capTile = html.slice(cap, html.indexOf("</a>", cap));
    expect(capTile).toContain("lamp is-ran");
    expect(capTile).not.toContain("tile-rail");
    expect(capTile).not.toContain("is-found");
  });

  test("r3_a_transfer_no_plain_return_alone_creates_no_cant_tell_tiles", () => {
    const quiet = ok("dev.brandklipparen.decompiler", [
      {
        id: "dev.brandklipparen.decompiler:0xa9059cbb",
        title: "Decompiled function transfer (0xa9059cbb)",
        payload: { selector: "0xa9059cbb", name: "transfer", cause: "no-plain-return", unresolvedJumps: 0 },
        evidence: [{ selector: "0xa9059cbb", offset: 45 }],
      },
    ]);
    const results = PLUGINS.map((entry) =>
      entry.id === "dev.brandklipparen.decompiler"
        ? quiet
        : ok(entry.id),
    );
    const html = renderToString(<PluginBoard address={ADDRESS} plugins={PLUGINS} results={results} />);
    expect(html).not.toContain("Can&#x27;t tell");
    expect(html).toContain("Ran · 1 function");
  });

  test("r3_only_unexpected_control_flow_on_transfer_reads_partly", () => {
    const partial = ok("dev.brandklipparen.decompiler", [
      {
        id: "dev.brandklipparen.decompiler:0xa9059cbb",
        title: "Decompiled function transfer (0xa9059cbb)",
        payload: {
          selector: "0xa9059cbb",
          name: "transfer",
          cause: "unexpected-control-flow",
          unresolvedJumps: 4,
        },
        evidence: [{ selector: "0xa9059cbb", offset: 45 }],
      },
    ]);
    const results = PLUGINS.map((entry) =>
      entry.id === "dev.brandklipparen.decompiler"
        ? partial
        : ok(entry.id),
    );
    const html = renderToString(<PluginBoard address={ADDRESS} plugins={PLUGINS} results={results} />);
    expect(html).toContain("Can&#x27;t tell");
  });
});
