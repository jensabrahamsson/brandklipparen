// Playwright for the explanation triggers (S-113, K-021, K-103).
// The REST API is route-mocked: no live chain or provider calls. The same
// tooltip text must appear on hover, on keyboard focus and on tap; Escape
// closes the keyboard-opened text, and an open tooltip never covers the
// score numbers beside it.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const ADDRESS = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const ANALYZE_FIXTURE = {
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
  await page.route("**/v1/personalize/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ mapping: { disabled: true } }),
    });
  });
}

test("tooltips_show_same_text_on_hover_and_keyboard_focus", async ({ page }) => {
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);
  const trigger = page.getByTestId("explain-score:combined");
  await expect(trigger).toBeVisible();

  await trigger.hover();
  const hovered = page.locator('[role="tooltip"]');
  await expect(hovered).toBeVisible();
  const hoveredText = await hovered.textContent();
  expect(hoveredText).toContain("Combined score");
  await page.mouse.move(4, 400);

  await trigger.focus();
  const focused = page.locator('[role="tooltip"]');
  await expect(focused).toBeVisible();
  expect(await focused.textContent()).toBe(hoveredText);

  await page.keyboard.press("Escape");
  await expect(page.locator('[role="tooltip"]')).toHaveCount(0);
});

test("tooltips_leave_numbers_readable", async ({ page }) => {
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);
  const trigger = page.getByTestId("explain-score:gauge:honeypot");
  await trigger.hover();
  const tooltip = page.locator('[role="tooltip"]');
  await expect(tooltip).toBeVisible();

  // S-133: the gauges live inside the Combined score hero on wide screens,
  // so the readability check targets the dial numbers themselves, not the
  // whole hero card.
  const dialNumber = page.locator('section[aria-label="Combined score"] .score-dial .num');
  await expect(dialNumber).toBeVisible();
  const tooltipBox = await tooltip.boundingBox();
  const scoreBox = await dialNumber.boundingBox();
  expect(tooltipBox).not.toBeNull();
  expect(scoreBox).not.toBeNull();
  if (tooltipBox !== null && scoreBox !== null) {
    const overlaps =
      tooltipBox.x < scoreBox.x + scoreBox.width &&
      tooltipBox.x + tooltipBox.width > scoreBox.x &&
      tooltipBox.y < scoreBox.y + scoreBox.height &&
      tooltipBox.y + tooltipBox.height > scoreBox.y;
    expect(overlaps).toBe(false);
  }
  await expect(page.getByText("84", { exact: true }).first()).toBeVisible();
});

test.describe("mobile tap", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("tooltips_toggle_on_tap", async ({ page }) => {
    await mockRest(page);
    await page.goto(`/#/token/${ADDRESS}`);
    const trigger = page.getByTestId("explain-cant-tell");
    await expect(trigger).toBeVisible();
    await trigger.tap();
    const tooltip = page.locator('[role="tooltip"]');
    await expect(tooltip).toBeVisible();
    expect(await tooltip.textContent()).toContain("What bytecode cannot tell");
    await trigger.tap();
    await expect(page.locator('[role="tooltip"]')).toHaveCount(0);
  });
});
