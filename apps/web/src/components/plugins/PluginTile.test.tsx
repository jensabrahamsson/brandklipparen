// Plugin tile compact row (R2-10): below 480 px quiet and neutral
// tiles render as one 48 px row with the full accessible name intact.
// Behavior only: rendered text and classes, with synthetic fixtures.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { PluginTile } from "./PluginTile.tsx";
import { PLUGIN_COPY } from "../../lib/pluginCopy.ts";
import { syntheticAddress } from "../../lib/syntheticAddresses.ts";

const ADDRESS = syntheticAddress(3);
const ALL_IDS = ["dev.brandklipparen.transfer-limits", "dev.brandklipparen.mint"];

describe("plugin tile compact row (R2-10)", () => {
  test("a quiet tile compacts to one glyph plus title-status row", () => {
    const copy = PLUGIN_COPY["transfer-limits"];
    if (copy === undefined) {
      throw new Error("transfer-limits copy is missing");
    }
    const html = renderToString(
      <PluginTile
        address={ADDRESS}
        pluginId="dev.brandklipparen.transfer-limits"
        allIds={ALL_IDS}
        copy={copy}
        state="not-found"
        severity="medium"
        payloads={[]}
        evidenceCount={0}
        matched={false}
        index={0}
        compact={true}
      />,
    );
    expect(html).toContain("is-compact");
    expect(html).toContain("tile-compact-label");
    expect(html).toContain("Transfer limits");
    expect(html).toContain("Not found");
    expect(html).not.toContain("tile-question");
    expect(html).not.toContain("tile-body");
    expect(html).toContain("Can the owner limit what you hold or send? Open details.");
  });

  test("found tiles ignore the compact flag", () => {
    const copy = PLUGIN_COPY["mint"];
    if (copy === undefined) {
      throw new Error("mint copy is missing");
    }
    const html = renderToString(
      <PluginTile
        address={ADDRESS}
        pluginId="dev.brandklipparen.mint"
        allIds={ALL_IDS}
        copy={copy}
        state="extended"
        severity="medium"
        payloads={[{ fact: "mint", proof: "extended", capped: true }]}
        evidenceCount={1}
        matched={false}
        index={0}
        compact={false}
      />,
    );
    expect(html).not.toContain("is-compact");
    expect(html).toContain("Found · Not in score");
  });

  test("score4_floor_tile_reads_found_sets_minimum_score", () => {
    const copy = PLUGIN_COPY["mint"];
    if (copy === undefined) {
      throw new Error("mint copy is missing");
    }
    const html = renderToString(
      <PluginTile
        address={ADDRESS}
        pluginId="dev.brandklipparen.mint"
        allIds={ALL_IDS}
        copy={copy}
        state="extended"
        floorMark="floor"
        severity="high"
        payloads={[{ fact: "mint", proof: "extended", capped: true }]}
        evidenceCount={1}
        matched={false}
        index={0}
      />,
    );
    expect(html).toContain("state-found-scored");
    expect(html).toContain("Found · Sets minimum score");
    expect(html).not.toContain("Not in score");
    expect(html).toContain("found, high, sets the minimum score");
  });

  test("score4_renounced_tile_reads_owner_renounced", () => {
    const copy = PLUGIN_COPY["mint"];
    if (copy === undefined) {
      throw new Error("mint copy is missing");
    }
    const html = renderToString(
      <PluginTile
        address={ADDRESS}
        pluginId="dev.brandklipparen.mint"
        allIds={ALL_IDS}
        copy={copy}
        state="extended"
        floorMark="renounced"
        severity="high"
        payloads={[{ fact: "mint", proof: "extended", capped: true }]}
        evidenceCount={1}
        matched={false}
        index={0}
      />,
    );
    expect(html).toContain("Owner renounced");
    expect(html).not.toContain("Sets minimum score");
    expect(html).toContain("owner renounced");
  });
});
