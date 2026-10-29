// S-134: the full token contract address (all 42 characters) shows in
// the UI instead of shortened forms: the live list (desktop table and
// mobile cards), the token page header/meta, the sidebar facts, and
// recently analyzed rows. Copy buttons sit next to each full address;
// row clicks still navigate while copy clicks do not.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const TOKEN_A = "0x5ab1e0000000000000000000000000000000a001";
const PAIR_A = "0x5ab1e0000000000000000000000000000000a0aa";
const TOKEN_B = "0x5ab1e0000000000000000000000000000000b002";
const PAIR_B = "0x5ab1e0000000000000000000000000000000b0bb";
// Displayed (and copied) forms are EIP-55 checksummed; mocks, routes and
// API calls keep the raw lowercase strings above.
const C_TOKEN_A = "0x5ab1E0000000000000000000000000000000a001";
const C_PAIR_A = "0x5aB1E0000000000000000000000000000000a0aa";
const C_TOKEN_B = "0x5AB1E0000000000000000000000000000000b002";
const C_PAIR_B = "0x5ab1E0000000000000000000000000000000b0BB";

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
      blockTimestampMs: 1700000000000 - 45 * 1000,
      ageSeconds: 45,
      initialLiquidityWeth: "2.5",
      state: "done",
      riskBand: "Low",
      score: 12,
    },
    {
      tokenAddress: TOKEN_B,
      symbol: null,
      name: null,
      pairAddress: PAIR_B,
      dex: "Uniswap V3",
      feeTier: 3000,
      block: 21600001,
      createdAt: 1700000000000,
      blockTimestampMs: 1700000000000 - 300 * 1000,
      ageSeconds: 300,
      initialLiquidityWeth: null,
      state: "done",
      riskBand: "Elevated",
      score: 45,
    },
  ];
}

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

const HEALTH_DISABLED = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  costUnits: "placeholder-cost-unit",
};

async function stubClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __copied: string[] }).__copied = [];
    const writeText = async (text: string): Promise<void> => {
      (window as unknown as { __copied: string[] }).__copied.push(text);
    };
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });
}

async function copiedValues(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __copied: string[] }).__copied ?? []);
}

async function mockStart(page: Page): Promise<void> {
  await page.route("**/v1/live-tokens", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ source: "etherscan", status: "live", updatedAt: 1700000000000, items: liveItems() }),
    });
  });
}

async function mockToken(page: Page): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH_DISABLED) });
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

async function expectNoOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
}

test("s134_live_list_shows_full_addresses_without_overflow", async ({ page }) => {
  await mockStart(page);
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.getByText("2 new tokens")).toBeVisible();
    // Full token and pair addresses render as exact text, never shortened.
    // The table serves wide screens and the cards serve narrow ones, so
    // the visible assertion follows the layout.
    const live = page.locator('section[aria-label="New tokens"]');
    if (viewport.width >= 640) {
      await expect(live.locator('[data-testid="live-token-full"]').first()).toBeVisible();
      await expect(live.locator('[data-testid="live-token-full"]').first()).toHaveText(C_TOKEN_A);
      await expect(live.locator('[data-testid="live-token-full"]').nth(1)).toHaveText(C_TOKEN_B);
      await expect(live.locator('[data-testid="live-pair-full"]').first()).toHaveText(C_PAIR_A);
      await expect(live.locator('[data-testid="live-pair-full"]').nth(1)).toHaveText(C_PAIR_B);
    } else {
      await expect(live.locator('[data-testid="live-card-token-full"]').first()).toBeVisible();
      await expect(live.locator('[data-testid="live-card-token-full"]').first()).toHaveText(C_TOKEN_A);
      await expect(live.locator('[data-testid="live-card-token-full"]').nth(1)).toHaveText(C_TOKEN_B);
      await expect(live.locator('[data-testid="live-card-pair-full"]').first()).toHaveText(C_PAIR_A);
      await expect(live.locator('[data-testid="live-card-pair-full"]').nth(1)).toHaveText(C_PAIR_B);
    }
    // Pair addresses never shorten; the token title may stay short only
    // when the symbol is missing (TOKEN_B), with the full address in the
    // row cells.
    await expect(live.getByText("0x5ab1…a0aa")).toHaveCount(0);
    await expect(live.getByText("0x5ab1…b0bb")).toHaveCount(0);
    await expect(live.getByText("0x5ab1…a001")).toHaveCount(0);
    await expectNoOverflow(page);
  }
});

test("s134_copy_buttons_are_44px_and_keyboard_copy_writes_exact_address", async ({ page }) => {
  await stubClipboard(page);
  await mockStart(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByText("2 new tokens")).toBeVisible();

  // Touch-sized hit areas that look small.
  const copyButtons = page.getByRole("button", { name: /Copy (contract|pair) address/ });
  expect(await copyButtons.count()).toBeGreaterThan(0);
  for (const box of await copyButtons.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = (element as HTMLElement).getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height) };
    }),
  )) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }

  // Keyboard copy writes the exact full address and confirms once.
  const firstCopy = page.getByRole("button", { name: "Copy contract address" }).first();
  await firstCopy.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => copiedValues(page), { timeout: 5000 }).toEqual([C_TOKEN_A]);
  await expect(page.getByText("Copied.").first()).toBeVisible();
  // Copy never navigates away from the list.
  expect(new URL(page.url()).hash).toBe("");
  await expect(page.getByText("2 new tokens")).toBeVisible();
});

test("s134_list_row_click_navigates_but_copy_click_does_not", async ({ page }) => {
  await stubClipboard(page);
  await mockStart(page);
  await mockToken(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.getByText("2 new tokens")).toBeVisible();

  // Enter on a focused row link opens the analysis.
  await page.locator(".live-table tbody tr a").first().focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain(`#/token/${TOKEN_A}`);

  // Back on the list, clicking copy writes the address without navigating.
  await page.goto("/#/");
  await expect(page.getByText("2 new tokens")).toBeVisible();
  await page.getByRole("button", { name: "Copy contract address" }).first().click();
  await expect.poll(() => copiedValues(page), { timeout: 5000 }).toEqual([C_TOKEN_A]);
  expect(new URL(page.url()).hash).toBe("#/");
});

test("s134_token_page_header_sidebar_and_recent_show_full_address", async ({ page }) => {
  await stubClipboard(page);
  await mockToken(page);
  // Note: hash URLs build by concatenation (see token-symbol-heading).
  await page.goto("/#/token/" + TOKEN_A);
  await expect(page.getByRole("img", { name: /Combined score 12 of 100, Low risk/ })).toBeVisible();

  // Header meta carries the exact full address with a copy control.
  await expect(page.locator('[data-testid="token-address-full"]').first()).toHaveText(C_TOKEN_A);
  await expect(page.getByRole("button", { name: "Copy contract address" }).first()).toBeVisible();

  // Sidebar facts carry the full address and pair with copy controls.
  const facts = page.locator('aside[aria-label="Contract facts"]');
  await expect(facts).toContainText(C_TOKEN_A);
  await expect(facts).toContainText(C_PAIR_A);
  await expect(facts).not.toContainText("0x5ab1…");

  // Keyboard copy from the header writes the exact address.
  await page.locator('[data-testid="copy-contract-address"]').first().focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => copiedValues(page), { timeout: 5000 }).toContain(C_TOKEN_A);

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expectNoOverflow(page);
  }

  // Recently analyzed rows keep a short title but show the full address
  // in the row meta with a copy control that is never nested in a button.
  // The token visit above recorded this address; back on the start page
  // the recent row carries it in full.
  await page.goto("/#/");
  const recent = page.locator("section[aria-label='Recently analyzed']");
  await expect(recent).toBeVisible();
  await expect(recent).toContainText(C_TOKEN_A);
  const nested = await recent.evaluate((root) =>
    root.querySelectorAll("button button, a button, button a").length,
  );
  expect(nested).toBe(0);
});
