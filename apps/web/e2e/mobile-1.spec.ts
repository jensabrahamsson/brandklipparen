// MOBILE-1: token page on a real phone width. The explanation tooltip
// must paint on top of every card, stay fully inside the viewport, and
// the page must never scroll sideways at 390 px or 320 px.
// The repo Playwright config defines no WebKit project, so this spec
// uses Chromium mobile emulation (touch, mobile viewport, iPhone-size
// viewports); it exercises the same layout the WebKit build ships.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const ADDRESS = "0x5ab1e0000000000000000000000000000000a001";

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
  probabilities: { "rug-pull": 0.26, honeypot: 0.08, "bot-pump": 0.18 },
  score: 19,
  signals: [],
  explanation: {
    kind: "template",
    templateVersion: "1.0.0",
    claims: [],
  },
  cantTell: [{ question: "Who holds the liquidity?", dataSource: "liquidity locks" }],
};

const HEALTH_DISABLED = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  costUnits: "placeholder-cost-unit",
};

async function mockRest(page: Page): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH_DISABLED) });
  });
  await page.route("**/v1/analyze*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ANALYZE_FIXTURE) });
  });
  await page.route("**/v1/plugins", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plugins: [] }) });
  });
  await page.route("**/v1/live-tokens*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ source: "etherscan", status: "live", updatedAt: 1700000000000, items: [] }),
    });
  });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
  expect(overflow.bodyScrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
}

test.describe("mobile-1 token page", () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const width of [390, 320]) {
    test(`tooltip_on_top_and_inside_viewport_at_${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await mockRest(page);
      await page.goto(`/#/token/${ADDRESS}`);
      await expect(page.getByTestId("token-address-full")).toContainText(ADDRESS.slice(0, 6));
      await expectNoHorizontalOverflow(page);
      for (const box of await page.locator("h1, h2").evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          return { left: rect.left, right: rect.right };
        }),
      )) {
        expect(box.left).toBeGreaterThanOrEqual(-1);
        expect(box.right).toBeLessThanOrEqual(width + 1);
      }

      // The "Why this score" (?) sits directly above the next card:
      // the exact overlap that used to paint the tooltip behind it.
      const trigger = page.getByTestId("explain-explanation:claim");
      await trigger.scrollIntoViewIfNeeded();
      await trigger.tap();
      const tooltip = page.locator('[role="tooltip"]');
      await expect(tooltip).toBeVisible();
      await expect(tooltip).toContainText("About these claims");
      const tooltipBox = await tooltip.boundingBox();
      expect(tooltipBox).not.toBeNull();
      expect(tooltipBox?.x ?? -1).toBeGreaterThanOrEqual(15);
      expect((tooltipBox?.x ?? 0) + (tooltipBox?.width ?? 0)).toBeLessThanOrEqual(width - 15);
      expect(tooltipBox?.y ?? -1).toBeGreaterThanOrEqual(0);
      expect((tooltipBox?.y ?? 0) + (tooltipBox?.height ?? 0)).toBeLessThanOrEqual(845);

      const hit = await tooltip.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const hitNode = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return hitNode !== null && (hitNode === node || hitNode.closest('[role="tooltip"]') === node);
      });
      expect(hit).toBe(true);
      await expectNoHorizontalOverflow(page);
      await trigger.press("Escape");
    });

    test(`no_horizontal_overflow_with_long_address_at_${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await mockRest(page);
      await page.goto(`/#/token/${ADDRESS}`);
      await expect(page.getByTestId("token-address-full")).toBeVisible();
      await expectNoHorizontalOverflow(page);
      // Opening and closing every "?" on the page must not widen it.
      for (const trigger of await page.locator(".explain-trigger").all()) {
        if (!(await trigger.isVisible())) {
          continue;
        }
        await trigger.scrollIntoViewIfNeeded();
        await trigger.tap();
        await expect(page.locator('[role="tooltip"]')).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await trigger.press("Escape");
        await expect(page.locator('[role="tooltip"]')).toHaveCount(0);
      }
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await expectNoHorizontalOverflow(page);
    });
  }
});
