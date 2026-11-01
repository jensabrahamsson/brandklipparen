// Switch and ask-button hit-area pattern (W-8, W-10): the Expert and
// Motion switches keep a 44x44 box with a visible keyboard ring and a
// themed on-state, and the Ask button stays focusable with an off tone
// while empty.
import { expect, test } from "@playwright/test";

const ADDRESS = "0x5ab1e0000000000000000000000000000000f005";

const ANALYZE = {
  kind: "assessed",
  target: ADDRESS,
  block: 18000000,
  proxy: { kind: "none" },
  codeHash: "0xabc",
  modelVersion: "0.1.0",
  artifactChecksum: "checksum",
  indexVersion: "1.0.0",
  templateVersion: "1.0.0",
  assessedAt: 1700000000000,
  probabilities: { "rug-pull": 0.1, honeypot: 0.1, "bot-pump": 0.1 },
  score: 10,
  signals: [],
  explanation: { kind: "template", templateVersion: "1.0.0", claims: [] },
  cantTell: [],
};

test("control_hit_area_visual_boundary_and_states", async ({ page }) => {
  await page.route("**/health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", apiVersion: "v1", assessment: { disabled: true }, costUnits: "x" }),
    });
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

  // Note: hash URLs build by concatenation (see token-symbol-heading).
  await page.goto("/#/token/" + ADDRESS);
  await expect(page.getByRole("img", { name: /Combined score 10 of 100/ })).toBeVisible();

  // The Expert switch keeps a real 44x44 box on the toolbar.
  const expert = page.getByTestId("expert-switch");
  await expect(expert).toBeVisible();
  const box = await expert.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

  // The on-state wears the theme tone, never native system blue. The
  // colour change settles over --dur-hover, so poll until it lands.
  const dim = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--dim").trim(),
  );
  expect(dim).toBe("#4fb27a");
  await expect
    .poll(() => expert.evaluate((element) => getComputedStyle(element).color))
    .toBe("rgb(79, 178, 122)");
  await expert.click();
  await expect(expert).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(() => expert.evaluate((element) => getComputedStyle(element).color))
    .toBe("rgb(214, 255, 230)");
  const onColor = await expert.evaluate((element) => getComputedStyle(element).color);
  expect(onColor).not.toContain("0, 122, 255");

  // Keyboard focus draws a visible halo around the whole hit area. Tab
  // from Search lands on the switch, and Space flips it back.
  await page.getByRole("button", { name: "← Search" }).focus();
  await page.keyboard.press("Tab");
  await expect.poll(() => expert.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  const outline = await expert.evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(outline).toBe("solid");
  await page.keyboard.press("Space");
  await expect(expert).toHaveAttribute("aria-checked", "false");

  // The empty Ask button stays in the tab order with an off tone: dashed
  // border, dim text, not-allowed cursor. Clicking it sends nothing.
  // Playwright treats aria-disabled like disabled for clicks, so the
  // click is dispatched directly: the handler still guards it.
  const ask = page.getByTestId("ask-submit");
  await expect(ask).toHaveAttribute("aria-disabled", "true");
  expect(await ask.evaluate((element) => getComputedStyle(element).borderStyle)).toBe("dashed");
  expect(await ask.evaluate((element) => getComputedStyle(element).cursor)).toBe("not-allowed");
  await ask.dispatchEvent("click");
  await expect(page.getByTestId("muse-output")).toHaveCount(0);
});

test("control_motion_switch_hit_area_and_keyboard", async ({ page }) => {
  await page.route("**/health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", apiVersion: "v1", assessment: { disabled: true }, costUnits: "x" }),
    });
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

  // Note: hash URLs build by concatenation (see token-symbol-heading).
  await page.goto("/#/token/" + ADDRESS);
  await expect(page.getByRole("img", { name: /Combined score 10 of 100/ })).toBeVisible();

  // The Motion switch keeps a real 44x44 box in the page footer.
  const motion = page.getByTestId("motion-switch");
  await expect(motion).toBeVisible();
  const box = await motion.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

  // Space flips it off and pins data-motion; Space flips it back on.
  await expect(motion).toHaveAttribute("aria-checked", "true");
  await motion.focus();
  await expect.poll(() => motion.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  expect(await motion.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
  await page.keyboard.press("Space");
  await expect(motion).toHaveAttribute("aria-checked", "false");
  expect(await page.evaluate(() => document.documentElement.dataset["motion"])).toBe("off");
  await page.keyboard.press("Space");
  await expect(motion).toHaveAttribute("aria-checked", "true");
  expect(await page.evaluate(() => document.documentElement.dataset["motion"])).toBeUndefined();
});
