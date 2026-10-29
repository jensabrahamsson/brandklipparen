// Live list DEX and human age: rows show the DEX (Uniswap V2 / V3 with
// fee tier) and a human age from feed data, unknown ages read as a
// labelled "unknown" with the reason, and a repeated symbol stays
// distinguishable by fee tier and pair. Cards and table both.
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

async function mockLive(page: Page): Promise<void> {
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

  // Table (wide): DEX with fee tier, human ages, labelled unknown.
  await page.setViewportSize({ width: 1280, height: 800 });
  const table = page.locator(".live-table");
  await expect(table.getByText("Uniswap V2").first()).toBeVisible();
  expect(await table.getByText("Uniswap V2").count()).toBe(2);
  await expect(table.getByText("Uniswap V3 · 0.3%")).toBeVisible();
  await expect(table.getByText("Uniswap V3 · 1%")).toBeVisible();
  await expect(table.getByText("3 min ago")).toBeVisible();
  await expect(table.getByText("5 min ago")).toBeVisible();
  await expect(table.getByText("2 h ago")).toBeVisible();
  const unknownCell = table.getByText("unknown");
  await expect(unknownCell).toBeVisible();
  await expect(unknownCell).toHaveAttribute("title", /Pair creation time not reported/);
  expect(await table.getByText(">-<").count()).toBe(0);
  // No bare dash cell anywhere in the list.
  const dashes = await table.locator("td").getByText("-", { exact: true }).count();
  expect(dashes).toBe(0);
  // Liquidity can't-tell carries its reason.
  await expect(table.getByTitle("No WETH liquidity seen in the pair's first logs").first()).toBeVisible();
  // The repeated symbol stays distinguishable: three fee/pair variants
  // with full pair addresses (S-134).
  expect(await table.getByText("DUP").count()).toBeGreaterThanOrEqual(3);
  expect(await table.getByText("0x5ab1e0000000000000000000000000000000a0aa").count()).toBeGreaterThanOrEqual(1);

  // Cards (narrow): same DEX, age and pair information.
  await page.setViewportSize({ width: 390, height: 844 });
  const cards = page.locator(".live-cards");
  await expect(cards.getByText("Uniswap V3 · 0.3%").first()).toBeVisible();
  await expect(cards.getByText("Uniswap V3 · 1%").first()).toBeVisible();
  await expect(cards.getByText("3 min ago").first()).toBeVisible();
  await expect(cards.getByText("unknown").first()).toHaveAttribute("title", /Pair creation time not reported/);
  await expect(cards.getByText("0x5ab1e0000000000000000000000000000000b0bb").first()).toBeVisible();
});
