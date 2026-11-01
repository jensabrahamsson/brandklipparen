// Owner-powers strip unit test (UI v2 §1.1, W-9): chips per
// found, extended and can't-tell detector, each a link to the detail
// view; the summary count with the extended "not in score" label.
// Behavior based: rendered text, roles and accessible names only,
// with synthetic fixtures (no mainnet addresses).
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { PowersStrip } from "./PowersStrip.tsx";
import { buildBoardModel } from "./plugins/PluginBoard.tsx";
import { syntheticAddress } from "../lib/syntheticAddresses.ts";
import type { PluginListEntry, PluginResultView } from "./PluginsPanel.tsx";

const ADDRESS = syntheticAddress(7);

function entry(id: string, max: "low" | "medium" | "high"): PluginListEntry {
  const short = id.split(".").pop() ?? id;
  return {
    id,
    version: "1.0.0",
    displayName: `${short} detector`,
    description: `Reports ${short}.`,
    frontmatter: { tags: ["holder"], audience: ["holder"], severity: { min: "low", max } },
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
];

function ok(id: string, findings: PluginResultView["findings"] = []): PluginResultView {
  return { pluginId: id, pluginVersion: "1.0.0", outcome: "ok", findings };
}

function quietResults(): PluginResultView[] {
  return PLUGINS.map((plugin) => ok(plugin.id));
}

function htmlFor(results: PluginResultView[]): string {
  const board = buildBoardModel(PLUGINS, results);
  const ids = PLUGINS.map((plugin) => plugin.id);
  return renderToString(<PowersStrip address={ADDRESS} allIds={ids} tiles={board.ownerTiles} />);
}

describe("owner-powers strip (UI v2 §1.1)", () => {
  test("powers_found_chips_link_to_detail_with_not_in_score_tag", () => {
    const html = htmlFor([
      ...quietResults().filter(
        (result) => result.pluginId !== "dev.brandklipparen.blacklist" && result.pluginId !== "dev.brandklipparen.mint",
      ),
      ok("dev.brandklipparen.blacklist", [
        {
          id: "dev.brandklipparen.blacklist:blacklist",
          title: "Blocked wallets",
          payload: { feature: "blacklist" },
          evidence: [{ selector: "0x44337ea1", offset: 200 }],
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
    ]);
    // One chip per non-quiet detector, each a link to the detail view.
    expect(html).toContain("power-chip-blacklist");
    expect(html).toContain("power-chip-mint");
    expect(html).toContain("/plugins/blacklist");
    expect(html).toContain("/plugins/mint");
    expect(html).toContain("Blacklist: found, high. Can the owner block wallets? Open details.");
    // The extended chip carries its label, and so does the summary count.
    expect(html).toContain("Not in score");
    expect(html).toContain("1 found. 1 more found by extended analysis (not in score).");
    // Quiet detectors get no chip.
    expect(html).not.toContain("power-chip-pause");
  });

  test("none_found_names_no_pattern", () => {
    const html = htmlFor(quietResults());
    expect(html).not.toContain("power-chip-");
    expect(html).toContain("No owner powers found in the code we could read.");
  });

  test("cant_tell_names_unread_checks_with_chips", () => {
    const hard: PluginResultView = {
      pluginId: "dev.brandklipparen.hard-to-analyze",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [
        {
          id: "dev.brandklipparen.hard-to-analyze:timeout",
          title: "Slow read",
          payload: { cause: "timeout" },
          evidence: [{ selector: "0x12345678", offset: null }],
        },
      ],
    };
    const board = buildBoardModel(PLUGINS, [...quietResults(), hard]);
    const ids = PLUGINS.map((plugin) => plugin.id);
    const html = renderToString(<PowersStrip address={ADDRESS} allIds={ids} tiles={board.ownerTiles} />);
    expect(html).toContain("No scored pattern. 9 checks could not be fully read.");
    expect(html).toContain("power-chip-blacklist");
    expect(html).toContain("can&#x27;t tell");
  });

  test("empty_board_renders_nothing", () => {
    const html = renderToString(<PowersStrip address={ADDRESS} allIds={[]} tiles={[]} />);
    expect(html).toBe("");
  });
});
