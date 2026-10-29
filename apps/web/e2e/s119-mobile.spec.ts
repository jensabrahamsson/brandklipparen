// S-119: every view fits the phone. No horizontal scrolling at 390 px
// and 320 px on the start page, the token page (all tabs, Simple and
// Expert) and the error pages; the live list renders as stacked cards
// below 640 px; badges stay fully visible; every tap target is 44 px.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const ADDRESS = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const ANALYZE_FIXTURE = {
  kind: "assessed",
  target: ADDRESS,
  block: 18000000,
  proxy: { kind: "none" },
  codeHash: `0x${"cd".repeat(32)}`,
  modelVersion: "0.1.0",
  artifactChecksum: "checksum",
  indexVersion: "1.0.0",
  templateVersion: "1.0.0",
  assessedAt: 1700000000000,
  probabilities: { "rug-pull": 0.62, honeypot: 0.91, "bot-pump": 0.34 },
  score: 84,
  signals: [
    {
      kind: "capability",
      id: "owner-blacklist",
      risk: "honeypot",
      direction: "raises",
      severity: "high",
      evidence: [{ selector: "0x44337ea1", offset: 2623 }],
    },
  ],
  explanation: {
    kind: "template",
    templateVersion: "1.0.0",
    claims: [
      {
        text: "The owner can stop you from selling.",
        signalLinks: ["owner-blacklist"],
        temporality: { kind: "can-change" },
      },
    ],
  },
  cantTell: [{ question: "Who holds the liquidity?", dataSource: "liquidity locks" }],
};

const HEALTH_DISABLED = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  costUnits: "placeholder-cost-unit",
};

const LIVE_FIXTURE = {
  source: "etherscan",
  status: "live",
  updatedAt: 1700000000000,
  items: [
    {
      tokenAddress: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbee1",
      symbol: "PEPE",
      name: "Pepe",
      pairAddress: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbee2",
      dex: "Uniswap V2",
      block: 18000000,
      createdAt: 1700000000,
      blockTimestampMs: 1700000000000,
      ageSeconds: 45,
      initialLiquidityWeth: "12.5",
      state: "done",
      riskBand: "High",
      score: 84,
    },
    {
      tokenAddress: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbee3",
      symbol: null,
      name: null,
      pairAddress: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbee4",
      dex: "Uniswap V3",
      feeTier: 3000,
      block: 18000000,
      createdAt: 1700000000,
      blockTimestampMs: null,
      ageSeconds: null,
      initialLiquidityWeth: null,
      state: "cant-tell",
      reason: "missing data",
    },
  ],
};

async function mockRest(page: Page, analyzeStatus: number, analyzeBody: unknown): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH_DISABLED) });
  });
  await page.route("**/v1/analyze*", async (route) => {
    await route.fulfill({ status: analyzeStatus, contentType: "application/json", body: JSON.stringify(analyzeBody) });
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
  await page.route("**/v1/live-tokens*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(LIVE_FIXTURE) });
  });
}

async function openCustomize(page: Page): Promise<void> {
  const customize = page.locator("details.customize");
  await expect(customize).toBeVisible();
  if (!(await customize.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await customize.locator("summary").click();
  }
}

async function expectFitsViewport(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
}

async function expectBadgesVisible(page: Page): Promise<void> {
  for (const badge of await page.locator(".risk-badge").all()) {
    if (!(await badge.isVisible())) {
      continue;
    }
    const box = await badge.boundingBox();
    expect(box).not.toBeNull();
    const viewport = page.viewportSize() ?? { width: 390, height: 844 };
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
  }
}

async function expectTapTargets(page: Page): Promise<void> {
  const small = await page.evaluate(() => {
    const bad: string[] = [];
    const viewportWidth = window.innerWidth;
    document.querySelectorAll("a, button, input, select, textarea, summary").forEach((element) => {
      if ((element as HTMLElement).offsetParent === null) {
        return;
      }
      if (element instanceof HTMLButtonElement && element.disabled) {
        return;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || rect.right < 0 || rect.left > viewportWidth) {
        return;
      }
      if (rect.width < 44 || rect.height < 44) {
        bad.push(`${element.tagName}<${element.className ?? ""}> ${Math.round(rect.width)}x${Math.round(rect.height)}`);
      }
    });
    return bad;
  });
  expect(small).toEqual([]);
}

test("s119_no_horizontal_scroll_at_390_and_320", async ({ page }) => {
  await mockRest(page, 200, ANALYZE_FIXTURE);
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Scan before you ape." })).toBeVisible();
    await expectFitsViewport(page);

    // Below 640 px the live list renders as stacked cards, not a table.
    const live = page.locator('section[aria-label="New tokens"]');
    await expect(live).toBeVisible();
    await expect(live.locator(".live-cards")).toBeVisible();
    await expect(live.locator(".live-table")).toBeHidden();
    await expect(live.locator(".live-card").first()).toContainText("PEPE");
    await expectFitsViewport(page);
    await expectBadgesVisible(page);
    await expectTapTargets(page);

    await page.goto(`/#/token/${ADDRESS}`);
    await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();
    await expectFitsViewport(page);
    await expectBadgesVisible(page);
    await expectTapTargets(page);

    for (const tab of ["Contract assessment", "Investigate"]) {
      await page.getByRole("tab", { name: tab }).click();
      await expectFitsViewport(page);
      await expectTapTargets(page);
    }

    // Expert mode with every section on.
    await page.getByRole("tab", { name: "Overview" }).click();
    await openCustomize(page);
    await page.getByRole("radio", { name: "Expert" }).check();
    await expect(page.getByTestId("expert-detail")).toBeVisible();
    await expectFitsViewport(page);
    await expectTapTargets(page);

    // The invalid-address error page fits too.
    await page.goto("/#/token/not-an-address");
    await expect(page.getByRole("alert")).toBeVisible();
    await expectFitsViewport(page);
    await expectTapTargets(page);
  }
});

test("s119_error_pages_have_no_horizontal_scroll", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await mockRest(page, 503, { status: 503, code: "upstream-unavailable", message: "Down for maintenance." });
  await page.goto(`/#/token/${ADDRESS}`);
  await expect(page.getByRole("alert")).toBeVisible();
  await expectFitsViewport(page);
  await expectTapTargets(page);
});
