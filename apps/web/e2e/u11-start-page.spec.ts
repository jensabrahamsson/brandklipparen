// U-11 start page first 30 seconds (D-14): two 44 px Try chips under
// the search (USDT opens its token page with no typing), the stale
// kicker, sub-copy and Chain pill gone, and topbar items disjoint at
// 320. The REST API is route-mocked: no live chain or provider calls.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

const HEALTH = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  costUnits: "placeholder-cost-unit",
};

const LIVE_EMPTY = {
  source: "none",
  status: "live",
  updatedAt: 0,
  items: [],
};

async function mockRest(page: Page): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH) });
  });
  await page.route("**/v1/live-tokens*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(LIVE_EMPTY) });
  });
}

test("u11_try_chips_open_token_pages_with_no_typing", async ({ page }) => {
  await mockRest(page);
  await page.goto("/");
  const chips = page.locator(".try-chip");
  await expect(chips).toHaveCount(2);
  await expect(page.getByRole("link", { name: "USDT" })).toBeVisible();
  await page.getByRole("link", { name: "USDT" }).click();
  await expect(page).toHaveURL(new RegExp(`#/token/${USDT}`));
});

test("u11_try_chips_measure_44px_under_the_search", async ({ page }) => {
  await mockRest(page);
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const chips = page.locator(".try-chip");
    await expect(chips).toHaveCount(2);
    const analyze = await page.getByRole("button", { name: "Analyze" }).boundingBox();
    expect(analyze).not.toBeNull();
    for (let index = 0; index < 2; index += 1) {
      const box = await chips.nth(index).boundingBox();
      expect(box).not.toBeNull();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      // Under the search: every chip starts below the Analyze button.
      expect(box?.y ?? 0).toBeGreaterThanOrEqual((analyze?.y ?? 0) + (analyze?.height ?? 0));
    }
  }
});

test("u11_stale_start_copy_and_chain_pill_are_gone", async ({ page }) => {
  await mockRest(page);
  await page.goto("/");
  const content = await page.content();
  for (const stale of ["bytecode alone", "BK/1", "ERC-20 contract reader"]) {
    expect(content).not.toContain(stale);
  }
  // No static Chain pill: "Ethereum mainnet" reads exactly once, in the
  // topbar. The footer links to Settings for the API key and carries
  // no Animations switch.
  await expect(page.getByText("Ethereum mainnet", { exact: true })).toHaveCount(1);
  await expect(page.getByText("See what its owner can do to you, in plain English.")).toBeVisible();
  await expect(page.locator(".page-foot")).toContainText("Deterministic score");
  await expect(page.locator(".page-foot")).toContainText("Muse is advisory");
  await expect(page.getByTestId("motion-switch")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Use your own API key" })).toHaveAttribute("href", "#/settings");
});

test("u11_settings_hold_api_key_and_animations", async ({ page }) => {
  await mockRest(page);
  await page.goto("/");
  await page.getByRole("link", { name: "Use your own API key" }).click();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByLabel("API key", { exact: true })).toBeVisible();
  await expect(page.getByText("Your own key, if you have one. Kept only in this browser session.")).toBeVisible();
  const animations = page.getByRole("switch", { name: "Animations" });
  await expect(animations).toBeVisible();
  await expect(page.getByText(/Blink and glow only/)).toBeVisible();
  const box = await animations.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
});

test("u11_topbar_items_do_not_intersect_at_320", async ({ page }) => {
  await mockRest(page);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/");
  await expect(page.locator(".topbar .brand")).toBeVisible();
  const rects = await page.evaluate(() => {
    const brand = document.querySelector(".topbar .brand")?.getBoundingClientRect();
    const net = document.querySelector(".topbar .net")?.getBoundingClientRect();
    if (brand === undefined || net === undefined || brand === null || net === null) {
      return null;
    }
    return {
      brand: { left: brand.left, right: brand.right, top: brand.top, bottom: brand.bottom },
      net: { left: net.left, right: net.right, top: net.top, bottom: net.bottom },
    };
  });
  expect(rects).not.toBeNull();
  if (rects !== null) {
    const intersects =
      rects.brand.left < rects.net.right &&
      rects.net.left < rects.brand.right &&
      rects.brand.top < rects.net.bottom &&
      rects.net.top < rects.brand.bottom;
    expect(intersects).toBe(false);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  }
});
