import { expect, test } from "@playwright/test";

test("about page is reachable and fits a 320px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/#/");
  await page.getByRole("link", { name: "About" }).click();
  await expect(page).toHaveURL(/#\/about$/);
  await expect(page.getByRole("heading", { name: "The horse" })).toBeVisible();
  await expect(page.locator(".page-foot")).toContainText("Scan before you swap · About · GitHub");
  const widths = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport);
  expect(widths.body).toBeLessThanOrEqual(widths.viewport);
  for (const link of await page.locator(".about a").all()) {
    const box = await link.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
});
