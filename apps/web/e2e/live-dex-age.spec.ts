// Live list DEX and compact age: rows show the DEX (Uniswap V2 / V3 with
// fee tier) and a compact age from feed data, unknown ages read as a
// labelled "unknown" with the reason, and a repeated symbol stays
// distinguishable by fee tier. The shared FeedRow serves every width.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

function entry(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    symbol: null,
    name: null,
    dex: "Uniswap V2",
    block: 21600002,
    createdAt: 1700000000000,
    blockTimestampMs: null,
    ageSeconds: null,
    initialLiquidityWeth: null,
    state: "done",
    ...partial,
  };
}

const V2 = entry({
  tokenAddress: "0x5ab1e0000000000000000000000000000000a001",
  symbol: "DUP",
  name: "Dup Token",
  pairAddress: "0x5ab1e0000000000000000000000000000000a0aa",
  block: 21600010,
  blockTimestampMs: 1700000000000 - 180 * 1000,
  ageSeconds: 180,
  initialLiquidityWeth: "1.5",
  riskBand: "Low",
  score: 12,
});

const V3LOW = entry({
  tokenAddress: "0x5ab1e0000000000000000000000000000000a001",
  symbol: "DUP",
  name: "Dup Token",
  pairAddress: "0x5ab1e0000000000000000000000000000000b0bb",
  dex: "Uniswap V3",
  feeTier: 3000,
  block: 21600008,
  blockTimestampMs: 1700000000000 - 300 * 1000,
  ageSeconds: 300,
  riskBand: "Elevated",
  score: 45,
});

const V3HIGH = entry({
  tokenAddress: "0x5ab1e0000000000000000000000000000000a001",
  symbol: "DUP",
  name: "Dup Token",
  pairAddress: "0x5ab1e0000000000000000000000000000000c0cc",
  dex: "Uniswap V3",
  feeTier: 10000,
  block: 21600006,
  blockTimestampMs: 1700000000000 - 7200 * 1000,
  ageSeconds: 7200,
  riskBand: "High",
  score: 80,
});

const UNKNOWN = entry({
  tokenAddress: "0x5ab1e0000000000000000000000000000000d004",
  pairAddress: "0x5ab1e0000000000000000000000000000000d0dd",
  block: 21600001,
  state: "cant-tell",
  reason: "no contract code at the pinned block",
});

const HEALTH_NO_MARKET = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  costUnits: "placeholder-cost-unit",
};

async function mockLive(page: Page): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH_NO_MARKET) });
  });
  await page.route("**/v1/live-tokens", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        source: "etherscan",
        status: "live",
        updatedAt: 1700000000000,
        items: [V2, V3LOW, V3HIGH, UNKNOWN],
      }),
    });
  });
}

test("live_list_dex_and_human_age", async ({ page }) => {
  await mockLive(page);
  await page.goto("/#/");

  const feed = page.locator('section[aria-label="New tokens"]');
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    // Rows: DEX with fee tier, compact ages, labelled unknown.
    await expect(feed.getByText("Uniswap V2").first()).toBeVisible();
    expect(await feed.getByText("Uniswap V2").count()).toBe(2);
    await expect(feed.getByText("Uniswap V3 · 0.3%")).toBeVisible();
    await expect(feed.getByText("Uniswap V3 · 1%")).toBeVisible();
    await expect(feed.getByText("3m").first()).toBeVisible();
    await expect(feed.getByText("5m").first()).toBeVisible();
    await expect(feed.getByText("2h").first()).toBeVisible();
    const unknownCell = feed.getByText("unknown");
    await expect(unknownCell).toBeVisible();
    await expect(unknownCell).toHaveAttribute("title", /Pair creation time not reported/);
    // No bare dash anywhere in the list.
    expect(await feed.getByText("-", { exact: true }).count()).toBe(0);
    // Liquidity can't-tell carries its reason.
    await expect(feed.getByTitle("No WETH liquidity seen in the pair's first logs").first()).toBeVisible();
    // The repeated symbol stays distinguishable: three fee variants with
    // the full token address in each row. The block number is tooltip
    // provenance on the age stamp now (U-12), never row text.
    expect(await feed.getByText("DUP").count()).toBeGreaterThanOrEqual(3);
    expect(await feed.getByText("block 21600010").count()).toBe(0);
    expect(await feed.getByText("block 21600008").count()).toBe(0);
    expect(await feed.getByText("block 21600006").count()).toBe(0);
    await expect(feed.locator('[title="Block 21600010"]').first()).toBeVisible();
    await expect(feed.locator('[title="Block 21600008"]').first()).toBeVisible();
    await expect(feed.locator('[title="Block 21600006"]').first()).toBeVisible();
  }
});
