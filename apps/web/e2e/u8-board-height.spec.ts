// U-8 board height budget (R3 D-9, R2-10): at 390 px the grouped board
// stays compact. PEPE shape (2 extended + 7 can't tell) renders 2 owner
// tiles plus one disclosure; USDT shape (3 found + 3 extended + 3
// can't tell) renders 6 plus one disclosure. Behavior only: visible
// text plus measured bounding boxes, with synthetic fixtures.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { appendFileSync } from "node:fs";

const USDT_ADDRESS = "0xdeaDbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const PEPE_ADDRESS = "0xfeeDbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function registryEntry(id: string, displayName: string): Record<string, unknown> {
  return { id, version: "1.0.0", displayName, description: `Reports ${id}.` };
}

const OWNER_SLUGS = [
  "ownership",
  "pause",
  "blacklist",
  "mint",
  "transfer-fee",
  "transfer-limits",
  "sell-block",
  "transfer-hooks",
  "proxy-upgrade",
];

const PLUGINS_FIXTURE = {
  plugins: [
    ...OWNER_SLUGS.map((slug) => registryEntry(`dev.brandklipparen.${slug}`, `${slug} detector`)),
    registryEntry("dev.brandklipparen.capability", "Capability detector"),
    registryEntry("dev.brandklipparen.decompiler", "Decompiler detector"),
    registryEntry("dev.brandklipparen.clone-match", "Clone-match detector"),
    registryEntry("dev.brandklipparen.hard-to-analyze", "Hard-to-read detector"),
  ],
};

const HEALTH_DISABLED = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  costUnits: "placeholder-cost-unit",
};

function finding(id: string, title: string, payload: Record<string, unknown>, offsets: number[]) {
  return {
    id,
    title,
    payload,
    evidence: offsets.map((offset) => ({ selector: "0x44337ea1", offset })),
  };
}

function okEmpty(pluginId: string) {
  return { pluginId, pluginVersion: "1.0.0", outcome: "ok", findings: [] };
}

const TOOLS_RESULTS = [
  {
    pluginId: "dev.brandklipparen.capability",
    pluginVersion: "1.0.0",
    outcome: "ok",
    findings: [finding("dev.brandklipparen.capability:call", "Calls out", { capability: "call" }, [26])],
  },
  {
    pluginId: "dev.brandklipparen.decompiler",
    pluginVersion: "1.0.0",
    outcome: "ok",
    findings: [
      {
        id: "dev.brandklipparen.decompiler:0x70a08231",
        title: "Decompiled function balanceOf (0x70a08231)",
        payload: { selector: "0x70a08231", name: "balanceOf", cause: null },
        evidence: [{ selector: "0x70a08231", offset: 26 }],
      },
    ],
  },
  okEmpty("dev.brandklipparen.clone-match"),
  {
    pluginId: "dev.brandklipparen.hard-to-analyze",
    pluginVersion: "1.0.0",
    outcome: "ok",
    findings: [
      {
        id: "dev.brandklipparen.hard-to-analyze:timeout",
        title: "Slow read",
        payload: { cause: "timeout" },
        // The view layer drops findings with no evidence pointers, so
        // the hard read carries its (offset-less) evidence entry like
        // the real backend emits.
        evidence: [{ selector: "0x12345678", offset: null }],
      },
    ],
  },
];

// USDT shape: 3 scored findings, 3 extended findings, 3 quiet owner
// checks that read can't tell because the hard read fired.
const USDT_RESULTS = [
  {
    pluginId: "dev.brandklipparen.ownership",
    pluginVersion: "1.0.0",
    outcome: "ok",
    findings: [
      finding("dev.brandklipparen.ownership:owner", "Owner account", { feature: "ownership", privilegedFunctions: 11 }, [10, 20]),
    ],
  },
  {
    pluginId: "dev.brandklipparen.pause",
    pluginVersion: "1.0.0",
    outcome: "ok",
    findings: [
      finding("dev.brandklipparen.pause:pause", "Pause switch", { feature: "pause", mode: "pause" }, [30, 40]),
    ],
  },
  {
    pluginId: "dev.brandklipparen.blacklist",
    pluginVersion: "1.0.0",
    outcome: "ok",
    findings: [
      finding("dev.brandklipparen.blacklist:block", "Blocked wallets", { feature: "blacklist" }, [50, 60]),
    ],
  },
  {
    pluginId: "dev.brandklipparen.mint",
    pluginVersion: "1.0.0",
    outcome: "ok",
    findings: [
      finding("dev.brandklipparen.mint:mint", "Mint, extended", { fact: "mint", proof: "extended", capped: true }, [70]),
    ],
  },
  {
    pluginId: "dev.brandklipparen.transfer-fee",
    pluginVersion: "1.0.0",
    outcome: "ok",
    findings: [
      finding("dev.brandklipparen.transfer-fee:fee", "Fee, extended", { fact: "fee", proof: "extended" }, [80]),
    ],
  },
  {
    pluginId: "dev.brandklipparen.transfer-limits",
    pluginVersion: "1.0.0",
    outcome: "ok",
    findings: [
      finding(
        "dev.brandklipparen.transfer-limits:limits",
        "Limits, extended",
        { fact: "limits", proof: "extended", limitKind: "max-wallet" },
        [90],
      ),
    ],
  },
  okEmpty("dev.brandklipparen.sell-block"),
  okEmpty("dev.brandklipparen.transfer-hooks"),
  okEmpty("dev.brandklipparen.proxy-upgrade"),
  ...TOOLS_RESULTS,
];

// PEPE shape: 2 extended findings, 7 quiet owner checks that read
// can't tell because the hard read fired.
const PEPE_RESULTS = [
  okEmpty("dev.brandklipparen.ownership"),
  okEmpty("dev.brandklipparen.pause"),
  {
    pluginId: "dev.brandklipparen.blacklist",
    pluginVersion: "1.0.0",
    outcome: "ok",
    findings: [
      finding("dev.brandklipparen.blacklist:block", "Blocked wallets", { fact: "blacklist", proof: "extended" }, [50]),
    ],
  },
  okEmpty("dev.brandklipparen.mint"),
  okEmpty("dev.brandklipparen.transfer-fee"),
  {
    pluginId: "dev.brandklipparen.transfer-limits",
    pluginVersion: "1.0.0",
    outcome: "ok",
    findings: [
      finding(
        "dev.brandklipparen.transfer-limits:limits",
        "Limits, extended",
        { fact: "limits", proof: "extended" },
        [90],
      ),
    ],
  },
  okEmpty("dev.brandklipparen.sell-block"),
  okEmpty("dev.brandklipparen.transfer-hooks"),
  okEmpty("dev.brandklipparen.proxy-upgrade"),
  ...TOOLS_RESULTS,
];

function analyzeFixture(target: string, pluginResults: unknown[]) {
  return {
    kind: "assessed",
    target,
    block: 18000000,
    proxy: { kind: "none" },
    codeHash: "0xabc",
    modelVersion: "0.1.0",
    artifactChecksum: "checksum",
    indexVersion: "1.0.0",
    templateVersion: "1.0.0",
    assessedAt: 1700000000000,
    probabilities: { "rug-pull": 0.1, honeypot: 0.1, "bot-pump": 0.05 },
    score: 12,
    signals: [],
    explanation: { kind: "template", templateVersion: "1.0.0", claims: [] },
    cantTell: [],
    pluginResults,
  };
}

async function mockBoard(page: Page, target: string, pluginResults: unknown[]): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH_DISABLED) });
  });
  await page.route("**/v1/analyze*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(analyzeFixture(target, pluginResults)),
    });
  });
  await page.route("**/v1/plugins", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PLUGINS_FIXTURE) });
  });
  await page.route("**/v1/personalize/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ mapping: { disabled: true } }),
    });
  });
  await page.route("**/v1/live-tokens*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ source: "none", status: "live", updatedAt: 0, items: [] }),
    });
  });
}

async function boardHeight(page: Page, target: string, pluginResults: unknown[]): Promise<number> {
  await mockBoard(page, target, pluginResults);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/token/${target}`);
  const board = page.getByTestId("plugin-board");
  await expect(board.getByRole("heading", { name: "What we checked" })).toBeVisible();
  await expect(board.getByTestId("plugin-board-summary")).toContainText("owner powers checked");
  // Let one-shot tile and count-up motion settle so the box is final.
  await page.waitForTimeout(1500);
  const box = await board.boundingBox();
  if (box === null) {
    throw new Error("plugin board has no bounding box");
  }
  const breakdown = await board.evaluate((section) => {
    const px = (value: string): number => Number.parseFloat(value) || 0;
    const rows: Record<string, number> = {};
    for (const tile of section.querySelectorAll("a[data-tile-slug]")) {
      const slug = tile.getAttribute("data-tile-slug") ?? "?";
      rows[`tile:${slug}`] = tile.getBoundingClientRect().height;
    }
    const toggle = section.querySelector(".canttell-toggle");
    const style = getComputedStyle(section);
    const summary = section.querySelector(".board-summary");
    const groups = [...section.querySelectorAll(".board-group")].map(
      (heading) => heading.getBoundingClientRect().height,
    );
    return {
      board: section.getBoundingClientRect().height,
      padding: px(style.paddingTop) + px(style.paddingBottom),
      summary: summary === null ? 0 : summary.getBoundingClientRect().height,
      groups,
      tiles: rows,
      toggle: toggle === null ? 0 : toggle.getBoundingClientRect().height,
    };
  });
  console.log(`HEIGHTS ${target.slice(0, 6)} ${JSON.stringify(breakdown)}`);
  appendFileSync("/tmp/u8-heights.jsonl", `${JSON.stringify({ target, ...breakdown })}\n`);
  const viewport = page.viewportSize();
  if (viewport === null) {
    throw new Error("viewport is missing");
  }
  // No horizontal scroll at 390: the board fits the viewport width.
  expect(box.width).toBeLessThanOrEqual(viewport.width);
  return box.height;
}

test("u8_pepe_board_fits_1300px_at_390", async ({ page }) => {
  const height = await boardHeight(page, PEPE_ADDRESS, PEPE_RESULTS);
  expect(height).toBeLessThanOrEqual(1300);
});

test("u8_usdt_board_fits_1900px_at_390", async ({ page }) => {
  const height = await boardHeight(page, USDT_ADDRESS, USDT_RESULTS);
  expect(height).toBeLessThanOrEqual(1900);
});
