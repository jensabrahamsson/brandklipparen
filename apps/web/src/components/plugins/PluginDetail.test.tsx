// Plugin detail unit test (UI v2 §5.2, §5.3): provenance from the
// /v1/plugins weight, the non-wrapping "Not in score" chip, the honest
// limits section, and the full status sentence in the accessibility
// tree. Behavior only: rendered text, roles and order.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { PluginDetailView, detailProvenance } from "./PluginDetail.tsx";
import { PLUGIN_COPY } from "../../lib/pluginCopy.ts";
import { syntheticAddress } from "../../lib/syntheticAddresses.ts";
import type { BoardTile } from "./PluginBoard.tsx";
import type { PluginFindingView, PluginListEntry } from "../PluginsPanel.tsx";

const ADDRESS = syntheticAddress(3);

function tile(state: BoardTile["state"]): BoardTile {
  return {
    pluginId: "dev.brandklipparen.blacklist",
    slug: "blacklist",
    copy: PLUGIN_COPY["blacklist"] as BoardTile["copy"],
    state,
    severity: "high",
    payloads: [{ feature: "blacklist" }],
    evidenceCount: 2,
    orderIndex: 2,
  };
}

function entry(weight?: number): PluginListEntry {
  return {
    id: "dev.brandklipparen.blacklist",
    version: "1.0.0",
    displayName: "Blacklist",
    description: "Reports block lists.",
    ...(weight === undefined ? {} : { weight }),
  };
}

const FINDINGS: PluginFindingView[] = [
  {
    id: "dev.brandklipparen.blacklist:blacklist",
    title: "Blocked wallets",
    payload: { feature: "blacklist" },
    evidence: [
      { selector: "0x44337ea1", offset: 200 },
      { selector: "0x44337ea1", offset: 400 },
    ],
  },
];

function detail(state: BoardTile["state"], weight?: number): string {
  return renderToString(
    <PluginDetailView
      address={ADDRESS}
      apiKey=""
      symbol="TST"
      slug="blacklist"
      tile={tile(state)}
      entry={entry(weight)}
      findings={FINDINGS}
      names={new Map()}
      modelVersion="1.0.1"
      mode="simple"
      onModeChange={() => undefined}
      prev={null}
      next={null}
    />,
  );
}

describe("plugin detail provenance", () => {
  test("a weighted check reads in score with the model version", () => {
    expect(detailProvenance("found-scored", 3, "1.0.1")).toBe("In score: yes (model 1.0.1)");
    expect(detail("found-scored", 3)).toContain("In score: yes (model 1.0.1)");
  });

  test("a zero weight reads as extended analysis, never in score", () => {
    expect(detailProvenance("found-scored", 0, "1.0.1")).toBe("No: extended analysis");
    expect(detail("found-scored", 0)).toContain("No: extended analysis");
    expect(detail("found-scored", 0)).not.toContain("In score");
  });

  test("the extended finding shows Not in score in one non-wrapping chip", () => {
    const html = detail("extended");
    expect(html).toContain("Not in score");
    expect(html).toContain("detail-not-in-score");
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "styles.css"), "utf8");
    const block = css.slice(css.indexOf(".extended-chip"));
    expect(block).toMatch(/white-space:\s*nowrap/);
  });

  test("the limits section states what the check cannot tell", () => {
    const html = detail("found-scored", 3);
    expect(html).toContain("What this check can");
    expect(html).toContain("not which wallets are listed");
  });

  test("the status sentence stays whole in the accessibility tree", () => {
    const html = detail("found-scored", 3);
    expect(html).toContain("The owner can stop chosen wallets from sending tokens.");
  });
});
