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

  test("a zero weight reads as weight 0, never in score", () => {
    expect(detailProvenance("found-scored", 0, "1.0.1")).toBe("In score: no (weight 0 in model 1.0.1)");
    expect(detail("found-scored", 0)).toContain("In score: no (weight 0 in model 1.0.1)");
    expect(detail("found-scored", 0)).toContain("Check v1.0.0");
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

describe("plugin detail header (D-7)", () => {
  function toolDetail(): string {
    return renderToString(
      <PluginDetailView
        address={ADDRESS}
        apiKey=""
        symbol="TST"
        slug="capability"
        tile={{
          pluginId: "dev.brandklipparen.capability",
          slug: "capability",
          copy: PLUGIN_COPY["capability"] as BoardTile["copy"],
          state: "ran",
          severity: "medium",
          payloads: [{ capability: "call" }],
          evidenceCount: 1,
          orderIndex: 9,
        }}
        entry={entry(0)}
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

  test("the extended header names the question and says Not in score once", () => {
    const html = detail("extended");
    expect(html).toContain("Can the owner block wallets?");
    expect(html.match(/Not in score/g) ?? []).toHaveLength(1);
  });

  test("owner checks offer the on-chain owner read with its own temporality line", () => {
    const html = detail("found-scored", 3);
    expect(html).toContain("Controlled by:");
    expect(html).toContain("not read yet");
    expect(html).toContain("Read owner on-chain");
    expect(html).toContain('class="detail-temporality">Applies now');
  });

  test("tool checks render no owner row", () => {
    const html = toolDetail();
    expect(html).not.toContain("detail-owner");
    expect(html).not.toContain("Read owner on-chain");
    expect(html).not.toContain("not read yet");
  });

  test("r3_ran_tools_read_neutrally_with_no_score_claim", () => {
    const html = toolDetail();
    expect(html).toContain("Ran");
    expect(html).not.toContain("Found ·");
    expect(html).not.toContain("Applies now");
    expect(html).toContain("In score: no (analysis tool)");
    expect(detailProvenance("ran", 0, "1.0.1")).toBe("In score: no (analysis tool)");
    expect(html).toContain("Calls other contracts");
  });

  test("the breadcrumb links the token and the board, and the back link returns to the token", () => {
    const html = detail("found-scored", 3);
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("← Back to token");
    expect(html).toContain("What we checked");
    expect(html).not.toContain("All plugins");
  });

  test("simple mode hides the plugin id from the provenance line", () => {
    const html = detail("found-scored", 3);
    expect(html).not.toContain("dev.brandklipparen.blacklist");
    expect(html).toContain("Check v1.0.0");
  });

  test("the desktop body splits evidence from an about aside", () => {
    const html = detail("found-scored", 3);
    expect(html).toContain("detail-cols");
    expect(html).toContain("detail-main");
    expect(html).toContain('aria-label="About this check"');
    expect(html).toContain("About this check");
  });

  test("the decompiler detail keeps the code panes at full width with the about aside below", () => {
    const html = renderToString(
      <PluginDetailView
        address={ADDRESS}
        apiKey=""
        symbol="TST"
        slug="decompiler"
        tile={{
          pluginId: "dev.brandklipparen.decompiler",
          slug: "decompiler",
          copy: PLUGIN_COPY["decompiler"] as BoardTile["copy"],
          state: "ran",
          severity: "medium",
          payloads: [],
          evidenceCount: 1,
          orderIndex: 10,
        }}
        entry={entry(0)}
        findings={[]}
        names={new Map()}
        modelVersion="1.0.1"
        mode="simple"
        onModeChange={() => undefined}
        prev={null}
        next={null}
      />,
    );
    expect(html).toContain("detail-cols--code");
    expect(html).toContain('aria-label="About this check"');
  });

  test("other checks keep the capped two-column body", () => {
    const html = detail("found-scored", 3);
    expect(html).toContain("detail-cols");
    expect(html).not.toContain("detail-cols--code");
  });

  test("an unavailable on-chain read names it with no button and no request", () => {
    const html = renderToString(
      <PluginDetailView
        address={ADDRESS}
        apiKey=""
        symbol="TST"
        slug="blacklist"
        tile={tile("found-scored")}
        entry={entry(3)}
        findings={FINDINGS}
        names={new Map()}
        modelVersion="1.0.1"
        mode="simple"
        onModeChange={() => undefined}
        prev={null}
        next={null}
        availability={{ investigation: "unavailable", explain: "unavailable", chat: "unavailable", rug: "unavailable", explainCode: "unavailable", onchain: "unavailable" }}
      />,
    );
    expect(html).toContain("not read yet");
    expect(html).toContain("On-chain reads are not configured on this server.");
    expect(html).not.toContain("Read owner on-chain");
  });
});
