// UI-7 page entry and header. A token opened from any start-page list
// (live feed, recent, promoted) lands at the top of its page with the
// heading focused, instead of keeping the scroll position of the list.
// The header shows the knight mark only, with no "BK" badge. Every REST
// response is route-mocked and every address is synthetic (0x5ab1e…).
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const HEALTH_NO_MARKET = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  costUnits: "placeholder-cost-unit",
};

const HEALTH_WITH_MARKET = {
  ...HEALTH_NO_MARKET,
  market: { provider: "dexscreener" },
};

const ANALYZE_FIXTURE = {
  kind: "assessed",
  target: "0x5ab1e0000000000000000000000000000000a001",
  block: 18000000,
  proxy: { kind: "none" },
  codeHash: "0xabc",
  modelVersion: "0.1.0",
  artifactChecksum: "checksum",
  indexVersion: "1.0.0",
  templateVersion: "1.0.0",
  assessedAt: 1700000000000,
  probabilities: { "rug-pull": 0.45, honeypot: 0.2, "bot-pump": 0.1 },
  score: 45,
  signals: [],
  explanation: { kind: "template", templateVersion: "1.0.0", claims: [] },
  cantTell: [],
};

// Synthetic addresses: 0x5ab1e followed by 35 hex digits.
function tokenAt(index: number): string {
  return `0x5ab1e${index.toString(16).padStart(35, "0")}`;
}

function liveItems(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    tokenAddress: tokenAt(100 + index),
    symbol: `LIVE${index}`,
    name: `Live token ${index}`,
    pairAddress: tokenAt(200 + index),
    dex: "Uniswap V2",
    block: 21600002,
    createdAt: 1700000000000,
    blockTimestampMs: 1700000000000 - 300 * 1000,
    ageSeconds: 300,
    initialLiquidityWeth: "2.5",
    state: "done",
    riskBand: "Low",
    score: 12,
  }));
}

function marketItems(count: number): Record<string, unknown>[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, index) => ({
    tokenAddress: tokenAt(300 + index),
    symbol: `MKT${index}`,
    name: `Promoted token ${index}`,
    pairAddress: tokenAt(400 + index),
    dex: "uniswap",
    createdAt: now - (index + 1) * 5 * 60 * 1000,
    liquidityUsd: 48200,
    volume1hUsd: 12400,
    volume24hUsd: 96000,
    priceChange24hPct: 3.25,
  }));
}

async function mockRest(
  page: Page,
  health: Record<string, unknown>,
  live: Record<string, unknown>[],
  market: Record<string, unknown>[],
): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(health) });
  });
  await page.route("**/v1/live-tokens*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ source: "etherscan", status: "live", updatedAt: 1700000000000, items: live }),
    });
  });
  await page.route("**/v1/market-new*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: market, updatedAt: Date.now() }),
    });
  });
  await page.route("**/v1/analyze*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ANALYZE_FIXTURE) });
  });
  await page.route("**/v1/plugins*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plugins: [] }) });
  });
  await page.route("**/v1/personalize/status*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ mapping: { disabled: true } }),
    });
  });
}

async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
}

async function expectTokenPageAtTopWithHeadingFocused(page: Page): Promise<void> {
  await expect(page).toHaveURL(/#\/token\/0x5ab1e/);
  // The heading takes focus once the analysis renders it.
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
}

test("ui7_live_feed_row_lands_at_the_top_with_the_heading_focused", async ({ page }) => {
  await mockRest(page, HEALTH_NO_MARKET, liveItems(10), []);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/");
  const feed = page.locator('section[aria-label="New tokens"]');
  await expect(feed.locator(".feed-row").first()).toBeVisible();
  await scrollToBottom(page);
  await feed.locator(".feed-link").nth(3).click();
  await expectTokenPageAtTopWithHeadingFocused(page);
});

test("ui7_recent_row_lands_at_the_top_with_the_heading_focused", async ({ page }) => {
  const recent = JSON.stringify([
    {
      address: tokenAt(900),
      score: 12,
      word: "Low",
      probabilities: { "rug-pull": 0.1, honeypot: 0.1, "bot-pump": 0.1 },
      topSignal: null,
      symbol: "RCT",
      name: "Recent token",
    },
  ]);
  await page.addInitScript((value: string) => {
    if (sessionStorage.getItem("brandklipparen-recent") === null) {
      sessionStorage.setItem("brandklipparen-recent", value);
    }
  }, recent);
  await mockRest(page, HEALTH_NO_MARKET, liveItems(10), []);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/");
  await expect(page.locator(".recent-row").first()).toBeVisible();
  await scrollToBottom(page);
  await page.locator(".recent-row").first().click();
  await expectTokenPageAtTopWithHeadingFocused(page);
});

test("ui7_promoted_row_lands_at_the_top_with_the_heading_focused", async ({ page }) => {
  await mockRest(page, HEALTH_WITH_MARKET, liveItems(8), marketItems(6));
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.goto("/#/");
  const promoted = page.locator('section[aria-label="Paid promotions"]');
  const row = promoted.locator("a[href^='#/token/']").first();
  await expect(row).toBeVisible();
  await scrollToBottom(page);
  await row.click();
  await expectTokenPageAtTopWithHeadingFocused(page);
});

test("ui7_header_shows_the_knight_mark_and_no_badge", async ({ page }) => {
  await mockRest(page, HEALTH_NO_MARKET, [], []);
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#/");
    const brand = page.locator(".topbar .brand");
    await expect(brand).toContainText("brandklipparen");
    // The "BK" badge is gone; the knight is the only mark.
    await expect(brand.locator("b")).toHaveCount(0);
    await expect(brand.locator("img")).toBeVisible();
  }
});
