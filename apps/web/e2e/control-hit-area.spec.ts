// Switch and ask-button hit-area pattern (R2-8): the Expert switch
// keeps a 44x44 box with a visible keyboard ring and a themed on-state
// (there is no motion switch), and the Ask button always looks enabled:
// an empty submit focuses the field with an error hint and sends nothing.
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

  // R2-8: the Ask button always looks enabled. Clicking it empty
  // focuses the field and shows the error hint; it still sends nothing.
  const ask = page.getByTestId("ask-submit");
  await expect(ask).not.toHaveAttribute("aria-disabled", "true");
  expect(await ask.evaluate((element) => getComputedStyle(element).cursor)).toBe("pointer");
  await expect(page.getByTestId("ask-hint")).toHaveCount(0);
  await ask.dispatchEvent("click");
  await expect(page.getByTestId("muse-output")).toHaveCount(0);
  await expect(page.getByTestId("ask-hint")).toContainText("Type a question first, then press Ask.");
});

test("control_no_motion_switch_in_settings", async ({ page }) => {
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

  await page.goto("/#/settings");

  // No motion switch exists: motion follows only the operating-system
  // reduced-motion setting. Settings keeps the API key field.
  await expect(page.getByLabel("API key", { exact: true })).toBeVisible();
  await expect(page.getByTestId("motion-switch")).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Animations" })).toHaveCount(0);
});
