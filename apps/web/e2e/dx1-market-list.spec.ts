// DX-1: DexScreener list beside New pairs. At 1280 px and above the two
// lists sit side by side with equal tops and no tablist; below 1280 px a
// tablist with 2 tabs switches the visible list and remembers the choice
// across reload. With no market feed there is no tablist and New pairs
// takes the full width. A market fetch error shows a retry card while
// New pairs still renders. Every REST response is route-mocked.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { assertLayout } from "./helpers/layoutContract.ts";

const HEALTH_WITH_MARKET = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  market: { provider: "dexscreener" },
  costUnits: "placeholder-cost-unit",
};

const HEALTH_NO_MARKET = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  costUnits: "placeholder-cost-unit",
};

function liveEntry(tokenAddress: string, symbol: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tokenAddress,
    symbol,
    name: `${symbol} Token`,
    pairAddress: tokenAddress.replace(/..$/, "ee"),
    dex: "Uniswap V2",
    block: 21600002,
    createdAt: 1700000000000,
    blockTimestampMs: 1700000000000 - 300 * 1000,
    ageSeconds: 300,
    initialLiquidityWeth: "2.5",
    state: "done",
    riskBand: "Low",
    score: 12,
    ...extra,
  };
}

function marketEntry(token: string, createdAt: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tokenAddress: token,
    symbol: "SYN",
    name: "Synthetic Token",
    pairAddress: token.replace(/..$/, "dd"),
    dex: "uniswap",
    createdAt,
    liquidityUsd: 48200,
    volume1hUsd: 12400,
    volume24hUsd: 96000,
    priceChange24hPct: 3.25,
    ...extra,
  };
}

const LIVE_A = "0x5ab1e0000000000000000000000000000000a001";
const LIVE_B = "0x5ab1e0000000000000000000000000000000b002";
const MKT_A = "0x5ab1e0000000000000000000000000000000c101";
const MKT_B = "0x5ab1e0000000000000000000000000000000c102";

async function mockFeeds(
  page: Page,
  options: {
    health?: unknown;
    live?: () => Record<string, unknown>[];
    market?: () => unknown;
    marketStatus?: number;
  } = {},
): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(options.health ?? HEALTH_WITH_MARKET),
    });
  });
  await page.route("**/v1/live-tokens", async (route) => {
    const items = options.live === undefined ? [liveEntry(LIVE_A, "AAA"), liveEntry(LIVE_B, "BBB")] : options.live();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ source: "etherscan", status: "live", updatedAt: 1700000000000, items }),
    });
  });
  await page.route("**/v1/market-new*", async (route) => {
    const status = options.marketStatus ?? 200;
    if (status !== 200) {
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({ code: "upstream-unavailable", message: "Down." }),
      });
      return;
    }
    const now = Date.now();
    const items =
      options.market === undefined
        ? [
            marketEntry(MKT_A, now - 12 * 60 * 1000, {
              analysis: { score: 45, powersFound: 3, powersExtended: 1 },
            }),
            marketEntry(MKT_B, now - 26 * 60 * 60 * 1000),
          ]
        : options.market();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items, updatedAt: now }),
    });
  });
}

test("opening a feed token returns to the top", async ({ page }) => {
  await mockFeeds(page);
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto("/#/");
  const row = page.locator('section[aria-label="New tokens"] a[href^="#/token/"]').first();
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await row.click();
  await expect(page).toHaveURL(/#\/token\//);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test("dx1_two_columns_with_equal_tops_and_no_tablist_at_1280", async ({ page }) => {
  await mockFeeds(page);
  for (const width of [1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#/");
    const live = page.locator('section[aria-label="New tokens"]');
    const market = page.locator('section[aria-label="Paid promotions"]');
    await expect(live.getByText("2 new tokens")).toBeVisible();
    await expect(market.getByText("2 new tokens")).toBeVisible();
    expect(await page.getByRole("tablist").count()).toBe(0);
    const liveBox = await live.boundingBox();
    const marketBox = await market.boundingBox();
    expect(liveBox).not.toBeNull();
    expect(marketBox).not.toBeNull();
    expect(Math.abs((liveBox?.y ?? 0) - (marketBox?.y ?? 0))).toBeLessThanOrEqual(1);
  }
});

test("dx1_tabs_below_1280_switch_with_arrows_and_persist", async ({ page }) => {
  await mockFeeds(page);
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto("/#/");
  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveCount(2);
  await expect(page.getByRole("tab", { name: /New pairs/ })).toHaveAttribute("aria-selected", "true");
  const live = page.locator('section[aria-label="New tokens"]');
  const market = page.locator('section[aria-label="Paid promotions"]');
  await expect(live).toBeVisible();
  await expect(market).toBeHidden();

  // ArrowRight moves and switches in one step.
  await page.getByRole("tab", { name: /New pairs/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /DexScreener/ })).toHaveAttribute("aria-selected", "true");
  await expect(market).toBeVisible();
  await expect(live).toBeHidden();

  // The choice survives a reload.
  await page.reload();
  await expect(page.getByRole("tab", { name: /DexScreener/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('section[aria-label="Paid promotions"]')).toBeVisible();
  await expect(page.locator('section[aria-label="New tokens"]')).toBeHidden();
});

test("dx1_no_market_feed_means_no_tabs_and_full_width_pairs", async ({ page }) => {
  await mockFeeds(page, { health: HEALTH_NO_MARKET });
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto("/#/");
  expect(await page.getByRole("tablist").count()).toBe(0);
  expect(await page.getByRole("tab").count()).toBe(0);
  const live = page.locator('section[aria-label="New tokens"]');
  await expect(live.getByText("2 new tokens")).toBeVisible();
  expect(await page.locator('section[aria-label="Paid promotions"]').count()).toBe(0);
  // New pairs takes the full content width.
  const box = await live.boundingBox();
  expect(box).not.toBeNull();
  expect((box?.width ?? 0)).toBeGreaterThan(700);
});

test("dx1_market_error_shows_retry_while_pairs_still_render", async ({ page }) => {
  await mockFeeds(page, { marketStatus: 502 });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/#/");
  const market = page.locator('section[aria-label="Paid promotions"]');
  await expect(market.getByText("DexScreener didn't answer. On-chain pairs still work.")).toBeVisible();
  await expect(market.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.locator('section[aria-label="New tokens"]').getByText("2 new tokens")).toBeVisible();
});

test("dx1_market_copy_and_labelling", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __copied: string[] }).__copied = [];
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string): Promise<void> => {
          (window as unknown as { __copied: string[] }).__copied.push(text);
        },
      },
      configurable: true,
    });
  });
  await mockFeeds(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/#/");
  const market = page.locator('section[aria-label="Paid promotions"]');
  // W-13 labelling: promoted line plus the DexScreener disclaimer.
  await expect(market.getByText("Tokens that paid DexScreener for visibility — scan before you swap.")).toBeVisible();
  // Owner-power chip follows the attached analysis; unscanned otherwise.
  // U-12 (P9): the short chip replaces the score, with the extended
  // meaning in its tooltip.
  await expect(market.getByText("3 powers +1")).toBeVisible();
  await expect(market.getByText("Not scanned")).toBeVisible();
  // Every row shows a 42-character address with a 44 px copy button.
  const addresses = market.locator('[data-testid="market-token-full"]');
  expect(await addresses.count()).toBe(2);
  const shown = await addresses.evaluateAll((elements) =>
    elements.map((element) => (element as HTMLElement).textContent ?? ""),
  );
  expect(shown).toHaveLength(2);
  for (const text of shown) {
    expect(text.startsWith("0x")).toBe(true);
    expect(text).toHaveLength(42);
  }
  for (const box of await market
    .getByRole("button", { name: "Copy contract address" })
    .evaluateAll((elements) =>
      elements.map((element) => {
        const rect = (element as HTMLElement).getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height) };
      }),
    )) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  // Copy writes the exact shown address and never navigates.
  await market.getByRole("button", { name: "Copy contract address" }).first().click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied ?? []), { timeout: 5000 })
    .toEqual([shown[0]]);
  expect(new URL(page.url()).hash).toBe("#/");
});

test("dx1_market_buffered_inserts_move_nothing_until_shown", async ({ page }) => {
  // The market list polls every 30 s: drive the timers with the fake
  // clock so the test never waits on a real poll interval.
  await page.clock.install();
  await page.setViewportSize({ width: 1280, height: 700 });
  let secondPoll = false;
  const now = Date.now();
  const first = [marketEntry(MKT_A, now - 12 * 60 * 1000), marketEntry(MKT_B, now - 26 * 60 * 60 * 1000)];
  await mockFeeds(page, {
    market: () =>
      secondPoll
        ? [
            marketEntry("0x5ab1e0000000000000000000000000000000c103", now - 60 * 1000),
            marketEntry("0x5ab1e0000000000000000000000000000000c104", now - 120 * 1000),
            marketEntry("0x5ab1e0000000000000000000000000000000c105", now - 180 * 1000),
            ...first,
          ]
        : first,
  });
  await page.goto("/#/");
  const market = page.locator('section[aria-label="Paid promotions"]');
  await expect(market.getByText("2 new tokens")).toBeVisible();

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await market.locator(".feed-row a").first().focus();
  const rows = market.locator(".feed-row");
  const before = await rows.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = (element as HTMLElement).getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y) };
    }),
  );
  secondPoll = true;
  // Advance past the 30 s market poll without waiting in real time (the
  // 10 s live poll fires too, but it returns identical rows).
  await page.clock.fastForward(30_000);
  const pill = market.getByRole("button", { name: /3 new tokens · Show/ });
  await expect(pill).toBeVisible({ timeout: 5000 });
  // Nothing moved: same rows, same boxes.
  const after = await rows.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = (element as HTMLElement).getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y) };
    }),
  );
  expect(after).toEqual(before);
  await pill.click();
  await expect(market.locator(".feed-row")).toHaveCount(5);
  await expect(market.getByText("5 new tokens")).toBeVisible();
});

test("u12_feed_tabs_and_rows", async ({ page }) => {
  await mockFeeds(page);

  // Tabs: one line at 320 and unclipped at 768.
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/#/");
  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveCount(2);
  for (const box of await tabs.evaluateAll((elements) =>
    elements.map((element) => {
      const node = element as HTMLElement;
      return {
        height: Math.round(node.getBoundingClientRect().height),
        clipped: node.scrollWidth > node.clientWidth + 1,
      };
    }),
  )) {
    expect(box.height).toBeLessThanOrEqual(52);
    expect(box.clipped).toBe(false);
  }
  await page.setViewportSize({ width: 768, height: 900 });
  for (const box of await tabs.evaluateAll((elements) =>
    elements.map((element) => {
      const node = element as HTMLElement;
      return { clipped: node.scrollWidth > node.clientWidth + 1 };
    }),
  )) {
    expect(box.clipped).toBe(false);
  }

  // Rows: compact, aligned, and free of feed noise.
  async function expectRows(section: string, maxRow: number): Promise<void> {
    const rows = page.locator(`${section} .feed-row`);
    await expect(rows.first()).toBeVisible();
    for (const height of await rows.evaluateAll((elements) =>
      elements.map((element) => Math.round((element as HTMLElement).getBoundingClientRect().height)),
    )) {
      expect(height).toBeLessThanOrEqual(maxRow);
    }
    // The copy button follows the last address group, including after wrapping.
    const gaps = await rows.evaluateAll((elements) => elements.map((row) => {
      const last = row.querySelector(".addr-full .addr-chunk:last-child") as HTMLElement;
      const copy = row.querySelector('[aria-label="Copy contract address"]') as HTMLElement;
      const addressBox = last.getBoundingClientRect();
      const copyBox = copy.getBoundingClientRect();
      return { gap: copyBox.left - addressBox.right, sameLine: copyBox.top < addressBox.bottom && copyBox.bottom > addressBox.top };
    }));
    for (const { gap, sameLine } of gaps) {
      expect(sameLine).toBe(true);
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(12);
    }
  }

  // Below 1280 the lists switch behind tabs; at 1440 both show at once.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: /New pairs/ }).click();
  await expectRows('section[aria-label="New tokens"]', 130);
  await page.getByRole("tab", { name: /DexScreener/ }).click();
  await expectRows('section[aria-label="Paid promotions"]', 130);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectRows('section[aria-label="New tokens"]', 92);
  await expectRows('section[aria-label="Paid promotions"]', 92);

  // No "Market —", no "block N", no baseline "." separators in rows.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator(".feed-row").getByText("Market —").count()).toBe(0);
  expect(await page.locator(".feed-row").getByText(/block \d+/).count()).toBe(0);
  const dots = await page.locator(".feed-row .feed-line2 > .meta-item").evaluateAll((elements) =>
    elements.map((element) => getComputedStyle(element, "::before").content),
  );
  for (const content of dots) {
    expect(content === "none" || content === '""' || !content.includes("·")).toBe(true);
  }
});

test("dx1_start_page_layout_contract_and_height_budget", async ({ page }) => {
  const range = (count: number, base: string): Record<string, unknown>[] =>
    Array.from({ length: count }, (_, index) => {
      const suffix = (index + 10).toString(16).padStart(2, "0");
      return liveEntry(`${base}${suffix}`, `T${index}`);
    });
  await mockFeeds(page, {
    live: () => range(30, "0x5ab1e0000000000000000000000000000000d0"),
    market: () => {
      const now = Date.now();
      return Array.from({ length: 30 }, (_, index) => {
        const suffix = (index + 40).toString(16).padStart(2, "0");
        return marketEntry(`0x5ab1e0000000000000000000000000000000e0${suffix}`, now - (index + 5) * 60 * 1000);
      });
    },
  });
  await page.goto("/#/");
  const live = page.locator('section[aria-label="New tokens"]');
  await expect(live.getByText("10 of 30 new tokens")).toBeVisible();
  // Paged at 10 rows each with the total in the label. The market column
  // mounts after /health resolves, so wait for its rows too: a bare count
  // would race the second fetch and see only the 10 live rows.
  const market = page.locator('section[aria-label="Paid promotions"]');
  await expect(market.getByText("10 of 30 new tokens")).toBeVisible();
  await expect(page.locator(".feed-row")).toHaveCount(20);
  // U-12: feed symbol links stretch over their rows, so the row box is
  // the target and the compact anchor text is allowlisted here.
  await assertLayout(page, { widths: [320, 390, 768, 1024, 1280, 1440, 1920], allow: [".feed-link"] });

  // At 768 px the page is exactly viewport-wide and the search input
  // keeps a usable width (W-12 D2: never crushed below 12ch).
  await page.setViewportSize({ width: 768, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(768);
  const inputBox = await page.locator("#address-search").boundingBox();
  expect(inputBox).not.toBeNull();
  expect(inputBox?.width ?? 0).toBeGreaterThanOrEqual(160);

  // The start page stays compact: 10 rows per list fit under 4 000 px.
  await page.setViewportSize({ width: 1440, height: 900 });
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(height).toBeLessThanOrEqual(4000);
});
