// S-124: calm, accurate live list. While the reader is scrolled or focused
// inside the list, polls buffer behind an "N new tokens · Show" pill and
// the focused row never moves; the whole row is the target; filters name
// what they mean; the count grammar is correct; and a filter that empties
// the list explains itself. Rows are the shared FeedRow at every width.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

function entry(
  tokenAddress: string,
  symbol: string,
  riskBand: string,
  score: number,
  ageSeconds: number | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    tokenAddress,
    symbol,
    name: `${symbol} Token`,
    pairAddress: tokenAddress.replace(/..$/, "ee"),
    dex: "Uniswap V2",
    block: 21600002,
    createdAt: 1700000000000,
    blockTimestampMs: 1700000000000 - (ageSeconds ?? 0) * 1000,
    ageSeconds,
    initialLiquidityWeth: "2.5",
    state: "done",
    riskBand,
    score,
    ...extra,
  };
}

const AAA = entry("0x5ab1e0000000000000000000000000000000a001", "AAA", "Elevated", 45, 300);
const BBB = entry("0x5ab1e0000000000000000000000000000000b002", "BBB", "Low", 12, 900, {
  initialLiquidityWeth: null,
});
const CCC = entry("0x5ab1e0000000000000000000000000000000c003", "CCC", "Elevated", 55, 30, {
  dex: "Uniswap V3",
  feeTier: 3000,
  initialLiquidityWeth: "0.8",
});
const DDD = entry("0x5ab1e0000000000000000000000000000000d004", "DDD", "High", 80, 120);

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

const HEALTH_NO_MARKET = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  costUnits: "placeholder-cost-unit",
};

async function mockStart(page: Page, getItems: () => Record<string, unknown>[]): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH_NO_MARKET) });
  });
  await page.route("**/v1/live-tokens", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ source: "etherscan", status: "live", updatedAt: 1700000000000, items: getItems() }),
    });
  });
  await page.route("**/v1/analyze*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ANALYZE_FIXTURE) });
  });
}

test("s124_live_list_buffers_inserts_and_labels", async ({ page, browser }) => {
  page.setViewportSize({ width: 1280, height: 600 });
  let secondPoll = false;
  await mockStart(page, () => (secondPoll ? [CCC, AAA, BBB] : [AAA, BBB]));
  await page.goto("/#/");
  const live = page.locator('section[aria-label="New tokens"]');
  await expect(live.getByText("2 new tokens")).toBeVisible();
  // The mocked feed timestamp is long past, so the header honestly reads
  // as paused instead of ticking up seconds (S-132).
  await expect(live.getByText(/Paused\. Updated .* ago\./)).toBeVisible();

  // Honest labels: the middle filter names both bands it includes.
  await expect(page.getByRole("button", { name: "Elevated+" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Low" })).toBeVisible();
  expect(await page.getByRole("button", { name: "High risk" }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "Low risk" }).count()).toBe(0);

  // Scroll and focus a row, then let a poll bring a new entry.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  const firstLink = live.locator(".feed-row a").first();
  await firstLink.focus();
  const row = live.locator(".feed-row").first();
  const before = await row.boundingBox();
  secondPoll = true;
  const pill = page.getByRole("button", { name: /1 new token · Show/ });
  await expect(pill).toBeVisible({ timeout: 20000 });

  // The feed holds still: same rows, same position.
  expect(await live.locator(".feed-row").count()).toBe(2);
  const after = await row.boundingBox();
  expect(before).not.toBeNull();
  expect(after?.y).toBe(before?.y);

  // Showing the buffer reveals the row and fixes the count grammar.
  await pill.click();
  await expect(live.locator(".feed-row")).toHaveCount(3);
  await expect(live.getByText("3 new tokens")).toBeVisible();

  // Enter on a focused row opens the analysis: the whole row is a target.
  await live.locator(".feed-row a").first().focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain("#/token/");

  // The row focus ring keeps a 3:1 boundary.
  await page.goto("/#/");
  await expect(live.getByText("3 new tokens")).toBeVisible();
  await live.locator(".feed-row a").first().focus();
  const ringRatio = await page.evaluate(() => {
    const parse = (value: string): readonly [number, number, number] => {
      const match = value.match(/[\d.]+/g) ?? [];
      return [Number(match[0] ?? 0), Number(match[1] ?? 0), Number(match[2] ?? 0)];
    };
    const luminance = (rgb: readonly [number, number, number]): number => {
      const linear = rgb.map((channel) => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
    };
    const focused = document.activeElement?.closest(".feed-row");
    if (focused === null || focused === undefined) {
      return 0;
    }
    const outline = luminance(parse(getComputedStyle(focused).outlineColor));
    const surface = luminance(parse(getComputedStyle(focused).backgroundColor));
    return (Math.max(outline, surface) + 0.05) / (Math.min(outline, surface) + 0.05);
  });
  expect(ringRatio).toBeGreaterThanOrEqual(3);

  // A filter that empties the list explains itself with a way back.
  secondPoll = false;
  await page.route("**/v1/live-tokens", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ source: "etherscan", status: "live", updatedAt: 1700000000000, items: [DDD] }),
    });
  });
  await page.reload();
  await expect(live.getByText("1 new token")).toBeVisible();
  await page.getByRole("button", { name: "Low", exact: true }).click();
  await expect(page.getByText("No matches.")).toBeVisible();
  await page.getByRole("button", { name: "Show all" }).click();
  await expect(live.getByText("1 new token")).toBeVisible();
  await expect(live.locator(".feed-row")).toHaveCount(1);

  // Under reduced motion, newly revealed rows appear instantly: switching
  // filters back and forth leaves no running animation.
  const reduced = await browser.newContext({ reducedMotion: "reduce" });
  const reducedPage = await reduced.newPage();
  let reducedSecond = false;
  await mockStart(reducedPage, () => (reducedSecond ? [CCC, AAA, BBB] : [AAA, BBB]));
  await reducedPage.goto("/#/");
  const reducedLive = reducedPage.locator('section[aria-label="New tokens"]');
  await expect(reducedLive.getByText("2 new tokens")).toBeVisible();
  await reducedPage.getByRole("button", { name: "Low", exact: true }).click();
  await expect(reducedLive.getByText("1 new token")).toBeVisible();
  await reducedPage.getByRole("button", { name: "All" }).click();
  await expect(reducedLive.getByText("2 new tokens")).toBeVisible();
  reducedSecond = true;
  expect(await reducedPage.evaluate(() => document.getAnimations().length)).toBe(0);
  await reduced.close();
});
