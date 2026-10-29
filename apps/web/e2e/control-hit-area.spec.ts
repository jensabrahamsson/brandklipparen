// Checkbox and radio hit-area pattern: the input keeps a 44x44 tap
// target while the visible control paints at ~20 px inside it, with a
// 3:1 boundary, a visible keyboard focus ring, and themed checked and
// disabled states (no native bright system blue).
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
      headers: { "x-deepening-status": "pending" },
      body: JSON.stringify(ANALYZE),
    });
  });
  await page.route("**/v1/plugins", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plugins: [] }) });
  });

  // Note: hash URLs build by concatenation (see token-symbol-heading).
  await page.goto("/#/token/" + ADDRESS);
  const customize = page.locator("details.customize");
  await expect(customize).toBeVisible();
  await customize.locator("summary").click();
  await expect(customize).toHaveAttribute("open", "");

  const controls = customize.locator('input[type="radio"], input[type="checkbox"]');
  expect(await controls.count()).toBeGreaterThan(0);

  // 44x44 hit areas with a ~20 px visual control inside.
  const boxes = await controls.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = (element as HTMLElement).getBoundingClientRect();
      const style = getComputedStyle(element as HTMLElement);
      return {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        paddingTop: Number.parseFloat(style.paddingTop),
        backgroundClip: style.backgroundClip,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
      };
    }),
  );
  for (const box of boxes) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    // The visible control is the content box: 44 minus padding both sides.
    expect(box.backgroundClip).toBe("content-box");
    expect(box.width - 2 * box.paddingTop).toBeLessThanOrEqual(22);
    expect(box.width - 2 * box.paddingTop).toBeGreaterThanOrEqual(16);
    // A solid 3:1 boundary ring, not a bare square.
    expect(box.outlineStyle).toBe("solid");
    expect(box.outlineWidth).toBe("2px");
  }

  // The checked radio wears the theme tone, never native system blue. The
  // fill transitions over --dur-fast, so poll until it settles (instant
  // under reduced motion, 120 ms otherwise).
  const expert = customize.getByRole("radio", { name: "Expert" });
  await expert.check();
  const brandDeep = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--brand-deep").trim(),
  );
  expect(brandDeep).toBe("#1f5a3a");
  await expect
    .poll(() =>
      expert.evaluate((element) => getComputedStyle(element).backgroundColor),
    )
    .toBe("rgb(31, 90, 58)");
  const checkedBackground = await expert.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(checkedBackground).toBe("rgb(31, 90, 58)");
  expect(checkedBackground).not.toContain("0, 122, 255");

  // The AI personalize box is disabled while no provider is configured.
  const aiToggle = customize.getByTestId("ai-personalize-toggle");
  await expect(aiToggle).toBeDisabled();
  const disabledCursor = await aiToggle.evaluate((element) => getComputedStyle(element).cursor);
  expect(disabledCursor).toBe("not-allowed");

  // Keyboard focus draws a visible halo around the whole hit area. Tab
  // from the summary lands on the checked group member (Expert here).
  await customize.locator("summary").focus();
  await page.keyboard.press("Tab");
  await expect.poll(() => expert.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  const halo = await expert.evaluate((element) => getComputedStyle(element).boxShadow);
  expect(halo).not.toBe("none");
});
