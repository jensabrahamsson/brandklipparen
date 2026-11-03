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
    expect(html).toContain("Can the owner cap what you hold or send? Open details.");
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
    expect(html).toContain("Found · Not yet scored");
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
    expect(html).toContain("Found · Sets floor");
    expect(html).not.toContain("Not yet scored");
    expect(html).toContain("found, high, sets score floor");
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
    expect(html).not.toContain("Sets score floor");
    expect(html).toContain("owner renounced");
    expect(html).toContain("Mint no longer counts.");
  });
});

describe("per-check status words (owner-facing)", () => {
  function tileFor(slug: string, state: "not-found" | "ran", payloads: readonly unknown[]): string {
    const copy = PLUGIN_COPY[slug];
    if (copy === undefined) {
      throw new Error(`${slug} copy is missing`);
    }
    return renderToString(
      <PluginTile
        address={ADDRESS}
        pluginId={`dev.brandklipparen.${slug}`}
        allIds={ALL_IDS}
        copy={copy}
        state={state}
        severity="low"
        payloads={payloads}
        evidenceCount={payloads.length}
        matched={false}
        index={0}
      />,
    );
  }

  test("a clean obfuscation check reads Readable with no extra body line", () => {
    const html = tileFor("hard-to-analyze", "not-found", []);
    expect(html).toContain("Obfuscated code");
    expect(html).toContain("Readable");
    expect(html).not.toContain("Not found");
    expect(html).not.toContain("tile-body");
  });

  test("an obfuscated read says Obfuscated and names the cause", () => {
    const html = tileFor("hard-to-analyze", "ran", [{ cause: "obfuscated-structure" }]);
    expect(html).toContain("Obfuscated</span>");
    expect(html).toContain("tile-body");
  });

  test("a read cut short by a timeout says Read incomplete", () => {
    const html = tileFor("hard-to-analyze", "ran", [{ cause: "timeout" }]);
    expect(html).toContain("Read incomplete");
  });

  test("a clone check with no match reads No match, and one with a match reads Match found", () => {
    expect(tileFor("clone-match", "not-found", [])).toContain("No match");
    expect(tileFor("clone-match", "ran", [{ group: "trap-a" }])).toContain("Match found");
  });
});
