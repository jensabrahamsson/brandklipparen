// Copy control gap (session 35): the screen-reader-only live region
// reserves no layout space, so the next meta item follows the copy
// button at a normal separator distance (at most 24 px) in the token
// header at 1440x900. The live region stays present, is empty when
// idle, and announces "Copied." after a keyboard copy while the
// accessible button name stays stable. Every placement reserves no
// dead space inside its wrap at desktop and phone widths.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const TOKEN_A = "0x5ab1e0000000000000000000000000000000a001";
const PAIR_A = "0x5ab1e0000000000000000000000000000000a0aa";
const TOKEN_B = "0x5ab1e0000000000000000000000000000000b002";
const PAIR_B = "0x5ab1e0000000000000000000000000000000b0bb";
const ACCOUNT = "0x5ab1e0000000000000000000000000000000c301";
// Displayed (and copied) forms are EIP-55 checksummed; mocks keep raw strings.
const C_TOKEN_A = "0x5ab1E0000000000000000000000000000000a001";
const C_ACCOUNT = "0x5AB1e0000000000000000000000000000000C301";

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
  explanation: {
    kind: "template",
    templateVersion: "1.0.0",
    claims: [
      {
        text: `The owner account ${ACCOUNT} can pause trading.`,
        signalLinks: [],
        temporality: { kind: "applies-now" },
      },
    ],
  },
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

async function mockToken(page: Page): Promise<void> {
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

// Distance from the copy button's right edge to the start of the next
// meta content after its wrap, plus the wrap's own reserved space.
async function headerGap(page: Page): Promise<{ gap: number; reserved: number }> {
  const result = await page.evaluate(() => {
    const button = document.querySelector('[data-testid="copy-contract-address"]') as HTMLElement | null;
    const wrap = button?.closest(".copy-wrap") as HTMLElement | null;
    const meta = document.querySelector(".token-meta") as HTMLElement | null;
    if (button === null || wrap === null || meta === null) {
      return null;
    }
    const buttonBox = button.getBoundingClientRect();
    const wrapBox = wrap.getBoundingClientRect();
    const range = document.createRange();
    range.setStartAfter(wrap);
    range.setEndAfter(meta);
    const rects = range.getClientRects();
    if (rects.length === 0) {
      return null;
    }
    return { gap: rects[0].left - buttonBox.right, reserved: wrapBox.width - buttonBox.width };
  });
  expect(result).not.toBeNull();
  return result as { gap: number; reserved: number };
}

test("copy_gap_header_meta_follows_button_with_live_announcement", async ({ page }) => {
  await stubClipboard(page);
  await mockToken(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  // Note: hash URLs build by concatenation (see token-symbol-heading).
  await page.goto("/#/token/" + TOKEN_A);
  await expect(page.locator('[data-testid="token-address-full"]').first()).toBeVisible();

  const headerCopy = page.locator('[data-testid="copy-contract-address"]').first();
  const liveRegion = page.locator(".token-meta .copy-wrap [aria-live='polite']").first();
  await expect(headerCopy).toBeVisible();

  // The live region is present and empty when idle.
  await expect(liveRegion).toHaveCount(1);
  await expect(liveRegion).toHaveText("");
  const statusBox = await liveRegion.evaluate((element) => {
    const rect = (element as HTMLElement).getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  expect(statusBox.width).toBeLessThanOrEqual(2);
  expect(statusBox.height).toBeLessThanOrEqual(2);

  // No reserved gap: the DEX and age meta follow the button directly.
  const before = await headerGap(page);
  expect(before.reserved).toBeLessThanOrEqual(2);
  expect(before.gap).toBeLessThanOrEqual(24);

  const widthBefore = await headerCopy.evaluate((element) => element.getBoundingClientRect().width);

  // Keyboard copy writes the exact address and announces exactly once.
  await headerCopy.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => copiedValues(page), { timeout: 5000 }).toEqual([C_TOKEN_A]);
  await expect(liveRegion).toHaveText("Copied.");
  await expect(headerCopy).toHaveText("Copied");
  await expect(headerCopy).toHaveAttribute("aria-label", "Copy contract address");

  // The confirmation moves nothing: same button width, same gap.
  const widthAfter = await headerCopy.evaluate((element) => element.getBoundingClientRect().width);
  expect(Math.abs(widthAfter - widthBefore)).toBeLessThanOrEqual(1);
  const after = await headerGap(page);
  expect(after.gap).toBeLessThanOrEqual(24);
});

test("copy_gap_no_reserved_space_in_any_placement", async ({ page }) => {
  await stubClipboard(page);
  await mockToken(page);
  await page.addInitScript(
    ({ symbolEntry, shortEntry }) => {
      sessionStorage.setItem("brandklipparen-recent", JSON.stringify([symbolEntry, shortEntry]));
    },
    {
      symbolEntry: {
        address: TOKEN_A,
        score: 12,
        word: "Low",
        probabilities: { "rug-pull": 0.1, honeypot: 0.1, "bot-pump": 0.1 },
        topSignal: "Owner can pause trading",
        symbol: "AAA",
        name: "Aaa Token",
      },
      shortEntry: {
        address: TOKEN_B,
        score: 45,
        word: "Elevated",
        probabilities: { "rug-pull": 0.4, honeypot: 0.45, "bot-pump": 0.3 },
        topSignal: null,
      },
    },
  );

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    // Token page: header meta, sidebar facts, explanation account chip.
    // Note: hash URLs build by concatenation (see token-symbol-heading).
    await page.goto("/#/token/" + TOKEN_A);
    await expect(page.locator('[data-testid="token-address-full"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="claim-account-full"]').first()).toContainText(C_ACCOUNT);
    const tokenReserved = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".copy-wrap")).map((wrap) => {
        const button = wrap.querySelector("button");
        if (button === null) {
          return -1;
        }
        return wrap.getBoundingClientRect().width - button.getBoundingClientRect().width;
      }),
    );
    expect(tokenReserved.length).toBeGreaterThanOrEqual(4);
    for (const reserved of tokenReserved) {
      expect(reserved).toBeLessThanOrEqual(2);
    }

    // Start page: live table or mobile cards plus recent rows.
    await page.goto("/#/");
    await expect(page.getByText("2 new tokens")).toBeVisible();
    const startReserved = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".copy-wrap")).map((wrap) => {
        const button = wrap.querySelector("button");
        if (button === null) {
          return -1;
        }
        return wrap.getBoundingClientRect().width - button.getBoundingClientRect().width;
      }),
    );
    expect(startReserved.length).toBeGreaterThan(0);
    for (const reserved of startReserved) {
      expect(reserved).toBeLessThanOrEqual(2);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  }
});
