// Brief 36: EIP-55 checksummed display plus a clean token meta wrap.
// The live list shows the checksummed form of each address, the token
// meta keeps each small item (DEX, age) on one line at 390 px with no
// horizontal scroll, and a rejected clipboard write reads "Copy failed".
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const TOKEN_A = "0x5ab1e0000000000000000000000000000000a001";
const PAIR_A = "0x5ab1e0000000000000000000000000000000a0aa";
const C_TOKEN_A = "0x5ab1E0000000000000000000000000000000a001";
const C_PAIR_A = "0x5aB1E0000000000000000000000000000000a0aa";

const HEALTH = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  costUnits: "x",
};

const ANALYZE = {
  kind: "assessed",
  target: TOKEN_A,
  tokenSymbol: "AAA",
  tokenName: "Aaa Token",
  block: 18000000,
  proxy: { kind: "none" },
  codeHash: "0xabc",
  modelVersion: "0.1.0",
  artifactChecksum: "checksum",
  indexVersion: "1.0.0",
  templateVersion: "1.0.0",
  assessedAt: 1700000000000,
  probabilities: { "rug-pull": 0.1, honeypot: 0.1, "bot-pump": 0.1 },
  score: 12,
  deepening: "ready",
  signals: [],
  explanation: { kind: "template", templateVersion: "1.0.0", claims: [] },
  cantTell: [],
  pluginResults: [],
};

function liveItems(): Record<string, unknown>[] {
  return [
    {
      tokenAddress: TOKEN_A,
      symbol: "AAA",
      name: "Aaa Token",
      pairAddress: PAIR_A,
      dex: "Uniswap V2",
      block: 21600002,
      createdAt: 1700000000000,
      blockTimestampMs: 1700000000000 - 1920 * 1000,
      ageSeconds: 1920,
      initialLiquidityWeth: "2.5",
      state: "done",
      riskBand: "Low",
      score: 12,
    },
  ];
}

async function mockRest(page: Page): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH) });
  });
  await page.route("**/v1/analyze*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "x-deepening-status": "ready" },
      body: JSON.stringify(ANALYZE),
    });
  });
  await page.route("**/v1/plugins", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plugins: [] }) });
  });
  await page.route("**/v1/personalize/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ mapping: { disabled: true } }),
    });
  });
  await page.route("**/v1/live-tokens", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ source: "etherscan", status: "live", updatedAt: 1700000000000, items: liveItems() }),
    });
  });
}

test("brief36_live_list_addresses_render_in_eip55_form", async ({ page }) => {
  await mockRest(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByText("1 new token")).toBeVisible();
  const live = page.locator('section[aria-label="New tokens"]');
  // The feed sends lowercase; the cards show the EIP-55 mixed-case form.
  await expect(live.locator('[data-testid="live-card-token-full"]').first()).toHaveText(C_TOKEN_A);
  await expect(live.locator('[data-testid="live-card-pair-full"]').first()).toHaveText(C_PAIR_A);
  await expect(live.getByText(TOKEN_A, { exact: true })).toHaveCount(0);
});

test("brief36_token_meta_wraps_between_items_without_overflow", async ({ page }) => {
  await mockRest(page);
  await page.setViewportSize({ width: 390, height: 844 });
  // Note: hash URLs build by concatenation (see token-symbol-heading).
  await page.goto("/#/token/" + TOKEN_A);
  await expect(page.locator('[data-testid="token-address-full"]').first()).toHaveText(C_TOKEN_A);

  // The age item sits on one line: a single client rect whose height is
  // one line box, so "32 min ago" never splits across lines.
  const age = page.locator('[data-testid="token-meta-age"]').first();
  await expect(age).toContainText("32 min ago");
  const rects = await age.evaluate((element) => {
    const boxes = Array.from(element.getClientRects()).map((rect) => ({
      width: rect.width,
      height: rect.height,
    }));
    const style = getComputedStyle(element);
    return { boxes, lineHeight: style.lineHeight, fontSize: style.fontSize };
  });
  expect(rects.boxes.length).toBe(1);
  expect(rects.boxes[0]?.height ?? 0).toBeLessThanOrEqual(Number.parseFloat(rects.lineHeight) + 1);

  // No horizontal scroll at 390 px.
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBe(390);
});

test("brief36_rejected_copy_reads_copy_failed", async ({ page }) => {
  await mockRest(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (): Promise<void> => {
          throw new Error("denied");
        },
      },
      configurable: true,
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  // Note: hash URLs build by concatenation (see token-symbol-heading).
  await page.goto("/#/token/" + TOKEN_A);
  const headerCopy = page.locator('[data-testid="copy-contract-address"]').first();
  await expect(headerCopy).toBeVisible();
  await headerCopy.click();
  await expect(headerCopy).toHaveAttribute("data-state", "failed");
  await expect(page.locator(".token-meta .copy-wrap [role='tooltip']").first()).toHaveText("Copy failed");
  const liveRegion = page.locator(".token-meta .copy-wrap [aria-live='polite']").first();
  await expect(liveRegion).toHaveText("Copy failed.");
});
