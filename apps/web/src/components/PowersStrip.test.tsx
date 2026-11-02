// Owner-powers strip unit test (UI v2 §1.1, W-9): chips per
// found, extended and can't-tell detector, each a link to the detail
// view; the summary count with the extended "not in score" label.
// Behavior based: rendered text, roles and accessible names only,
// with synthetic fixtures (no mainnet addresses).
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { Explain } from "./Explain.tsx";
import { PowersStrip } from "./PowersStrip.tsx";
import { explanationFor } from "../lib/explanations.ts";
import { buildBoardModel, PluginBoard } from "./plugins/PluginBoard.tsx";
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
  test("floor, renounced and clean blacklist statuses agree between strip and grid", () => {
    const floor = { rule: "owner-can-block-holders" as const, minimum: 60, label: "floor: owner can block holders (blacklist)", facts: ["blacklist"] };
    const ownerState = { status: "renounced" as const, getter: "owner()" as const, address: "0x0000000000000000000000000000000000000000", block: 24000000, reason: "owner renounced" };
    const proven = [...quietResults().filter((result) => result.pluginId !== "dev.brandklipparen.blacklist"), ok("dev.brandklipparen.blacklist", [{ id: "blacklist", title: "Blacklist", payload: { fact: "blacklist", proof: "extended" }, evidence: [] }])];
    for (const scenario of [
      { results: quietResults(), scoreFloor: floor, ownerState: undefined, chip: "Blacklist: found, high, sets the minimum score", tile: "Blacklist: found, high, sets the minimum score" },
      { results: proven, scoreFloor: undefined, ownerState, chip: "Blacklist: owner renounced", tile: "Blacklist: owner renounced" },
      { results: quietResults(), scoreFloor: undefined, ownerState: undefined, chip: null, tile: "Blacklist: not found" },
    ]) {
      const context = { scoreFloor: scenario.scoreFloor, ownerState: scenario.ownerState };
      const board = buildBoardModel(PLUGINS, scenario.results, context);
      const strip = renderToString(<PowersStrip address={ADDRESS} allIds={PLUGINS.map((plugin) => plugin.id)} tiles={board.ownerTiles} {...context} />);
      const grid = renderToString(<PluginBoard address={ADDRESS} plugins={PLUGINS} results={scenario.results} {...context} />);
      if (scenario.chip === null) expect(strip).not.toContain("power-chip-blacklist");
      else expect(strip).toContain(scenario.chip);
      expect(grid).toContain(scenario.tile);
    }
  });
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
    expect(html).toContain("1 found. 1 more the score doesn&#x27;t count yet.");
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
    // With no found or extended finding there is nothing to collapse
    // into: no single link, the chips and the summary stay.
    expect(html).not.toContain("powers-more");
  });

  test("cant_tell_collapses_into_one_link_when_findings_exist", () => {
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
    const board = buildBoardModel(PLUGINS, [
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
      hard,
    ]);
    const ids = PLUGINS.map((plugin) => plugin.id);
    const html = renderToString(<PowersStrip address={ADDRESS} allIds={ids} tiles={board.ownerTiles} />);
    // Found and extended chips stay; every can't-tell chip collapses
    // into the one link at every width (renderToString is desktop).
    expect(html).toContain("power-chip-blacklist");
    expect(html).toContain("power-chip-mint");
    expect(html).toContain("+7 can&#x27;t tell ›");
    expect(html).toContain("/plugins");
    expect(html).not.toContain("state-cant-tell");
    // The chips plus the link already carry every count, so the summary
    // is dropped. The counts stay in the chips' accessible names.
    expect(html).not.toContain("powers-summary");
    expect(html).toContain("Blacklist: found, high. Can the owner block wallets? Open details.");
  });

  test("empty_board_renders_nothing", () => {
    const html = renderToString(<PowersStrip address={ADDRESS} allIds={[]} tiles={[]} />);
    expect(html).toBe("");
  });

  test("null_plugins_renders_loading_line", () => {
    const html = renderToString(<PowersStrip address={ADDRESS} allIds={[]} tiles={[]} plugins={null} />);
    expect(html).toContain("Owner powers are loading…");
    expect(html).not.toContain("power-chip-");
  });

  test("found_chips_carry_the_tile_severity_class_for_the_lamp", () => {
    const html = htmlFor([
      ...quietResults().filter((result) => result.pluginId !== "dev.brandklipparen.blacklist"),
      ok("dev.brandklipparen.blacklist", [
        {
          id: "dev.brandklipparen.blacklist:blacklist",
          title: "Blocked wallets",
          payload: { feature: "blacklist" },
          evidence: [{ selector: "0x44337ea1", offset: 200 }],
        },
      ]),
    ]);
    // The blacklist detector reports max high, so the chip carries the
    // high severity class the lamp colour follows (R2-11).
    expect(html).toContain("power-chip state-found-scored sev-high");
  });

  test("cant_tell_chips_carry_a_visible_cant_tell_tag", () => {
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
    // With no finding the can't-tell chips stay visible, each with a
    // quiet tag instead of relying on the lamp alone (R2-11).
    expect(html).toContain("power-chip state-cant-tell");
    expect(html).toContain("Can&#x27;t tell</span>");
  });

  test("strip_help_trigger_explains_extended_analysis", () => {
    const html = htmlFor(quietResults());
    expect(html).toContain('data-testid="explain-powers:extended"');
    expect(explanationFor("powers:extended").body).toContain("sets a minimum score");
    const open = renderToString(<Explain explainKey="powers:extended" label="Extended analysis" defaultOpen />);
    expect(open).toContain("sets a minimum score");
  });

  test("score4_floor_fact_renders_found_with_sets_minimum_score", () => {
    const results: PluginResultView[] = [
      ...quietResults().filter((result) => result.pluginId !== "dev.brandklipparen.blacklist"),
      ok("dev.brandklipparen.blacklist", [
        {
          id: "dev.brandklipparen.blacklist:blacklist-extended",
          title: "Blocked wallets, extended",
          payload: { fact: "blacklist", proof: "extended" },
          evidence: [{ selector: "0x44337ea1", offset: 200 }],
        },
      ]),
    ];
    const board = buildBoardModel(PLUGINS, results, {
      scoreFloor: { rule: "owner-can-block-holders", minimum: 60, label: "floor: owner can block holders (blacklist)", facts: ["blacklist"] },
    });
    const ids = PLUGINS.map((plugin) => plugin.id);
    const html = renderToString(
      <PowersStrip
        address={ADDRESS}
        allIds={ids}
        tiles={board.ownerTiles}
        scoreFloor={{ rule: "owner-can-block-holders", minimum: 60, label: "floor: owner can block holders (blacklist)", facts: ["blacklist"] }}
      />,
    );
    expect(html).toContain("power-chip state-found-scored sev-high");
    expect(html).toContain("Sets minimum score");
    expect(html).not.toContain("Not in score");
    expect(html).toContain("Blacklist: found, high, sets the minimum score. Can the owner block wallets? Open details.");
    expect(html).toContain("1 found. 1 sets the minimum score.");
  });

  test("score4_renounced_lifted_fact_renders_owner_renounced_not_found", () => {
    const results: PluginResultView[] = [
      ...quietResults().filter((result) => result.pluginId !== "dev.brandklipparen.blacklist"),
      ok("dev.brandklipparen.blacklist", [
        {
          id: "dev.brandklipparen.blacklist:blacklist-extended",
          title: "Blocked wallets, extended",
          payload: { fact: "blacklist", proof: "extended" },
          evidence: [{ selector: "0x44337ea1", offset: 200 }],
        },
      ]),
    ];
    const ownerState = {
      status: "renounced" as const,
      getter: "owner()" as const,
      address: "0x0000000000000000000000000000000000000000",
      block: 24000000,
      reason: "the owner getter returns the zero or dead address",
    };
    const board = buildBoardModel(PLUGINS, results, { ownerState });
    const ids = PLUGINS.map((plugin) => plugin.id);
    const html = renderToString(
      <PowersStrip address={ADDRESS} allIds={ids} tiles={board.ownerTiles} ownerState={ownerState} />,
    );
    expect(html).toContain("state-renounced");
    expect(html).toContain("Owner renounced");
    expect(html).not.toContain("Sets minimum score");
    expect(html).toContain("Blacklist: owner renounced. Can the owner block wallets? Open details.");
    expect(html).toContain("2 owner powers found but owner renounced.");
  });

  test("renounced_owner_line_names_getter_address_and_block", () => {
    const board = buildBoardModel(PLUGINS, quietResults());
    const ids = PLUGINS.map((plugin) => plugin.id);
    const html = renderToString(
      <PowersStrip
        address={ADDRESS}
        allIds={ids}
        tiles={board.ownerTiles}
        ownerState={{
          status: "renounced",
          getter: "owner()",
          address: "0x0000000000000000000000000000000000000000",
          block: 24000000,
          reason: "the owner getter returns the zero or dead address",
        }}
      />,
    );
    expect(html).toContain("Owner renounced");
    expect(html).toContain("owner()");
    expect(html).toContain("0x0000000000000000000000000000000000000000");
    expect(html).toContain("24000000");
    expect(html).toContain("so these setters can no longer be called.");
    expect(html).toContain('aria-label="Copy owner address"');
  });

  test("empty_then_populated_rerender_does_not_throw", () => {
    const ids = PLUGINS.map((plugin) => plugin.id);
    const populated = buildBoardModel(PLUGINS, [
      ok("dev.brandklipparen.ownership", [
        {
          id: "dev.brandklipparen.ownership:ownership",
          title: "Owned",
          payload: { feature: "ownership" },
          evidence: [{ selector: "0x8da5cb5b", offset: 10 }],
        },
      ]),
      ok("dev.brandklipparen.pause", [
        {
          id: "dev.brandklipparen.pause:pause",
          title: "Pausable",
          payload: { feature: "pause" },
          evidence: [{ selector: "0x8456cb59", offset: 20 }],
        },
      ]),
      ok("dev.brandklipparen.blacklist", [
        {
          id: "dev.brandklipparen.blacklist:blacklist",
          title: "Blocked wallets",
          payload: { feature: "blacklist" },
          evidence: [{ selector: "0x44337ea1", offset: 30 }],
        },
      ]),
      ok("dev.brandklipparen.mint", [
        {
          id: "dev.brandklipparen.mint:mint-extended",
          title: "Mint, extended",
          payload: { fact: "mint", proof: "extended" },
          evidence: [{ selector: "0x40c10f19", offset: 40 }],
        },
      ]),
      ok("dev.brandklipparen.transfer-fee", [
        {
          id: "dev.brandklipparen.transfer-fee:fee-extended",
          title: "Transfer fee, extended",
          payload: { fact: "transfer-fee", proof: "extended" },
          evidence: [{ selector: "0x44337ea1", offset: 50 }],
        },
      ]),
      ok("dev.brandklipparen.transfer-limits", [
        {
          id: "dev.brandklipparen.transfer-limits:limits-extended",
          title: "Transfer limits, extended",
          payload: { fact: "transfer-limits", proof: "extended" },
          evidence: [{ selector: "0x44337ea1", offset: 60 }],
        },
      ]),
    ]);
    // D-2: the pending-plugins fetch lands after the analysis, so the
    // strip renders empty first and populated next. Every hook runs
    // before the early return, so the second render adds no hooks.
    let first = "";
    let second = "";
    expect(() => {
      first = renderToString(<PowersStrip address={ADDRESS} allIds={ids} tiles={[]} plugins={[]} />);
      second = renderToString(
        <PowersStrip address={ADDRESS} allIds={ids} tiles={populated.ownerTiles} plugins={PLUGINS} />,
      );
    }).not.toThrow();
    expect(first).toBe("");
    for (const slug of ["ownership", "pause", "blacklist", "mint", "transfer-fee", "transfer-limits"]) {
      expect(second).toContain(`power-chip-${slug}`);
    }
  });
});
