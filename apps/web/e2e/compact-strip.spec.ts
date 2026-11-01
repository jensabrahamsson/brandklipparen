// Result summary strip: hidden while the combined score ring is visible,
// pinned to the viewport top once the ring scrolls out. With the tabs
// gone the strip no longer depends on any tab: only ring visibility
// decides. No live chain or provider calls: every REST response is
// route-mocked like in smoke.spec.ts.
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

const NOT_CONFIGURED = {
  status: 501,
  code: "assessment-not-configured",
  message: "Assessment is not configured: set an assessment provider to enable it.",
  requestId: "123e4567-e89b-12d3-a456-426614174000",
};

async function mockRest(page: Page): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH_DISABLED) });
  });
  await page.route("**/v1/analyze*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "x-deepening-status": "pending" },
      body: JSON.stringify(ANALYZE_FIXTURE),
    });
  });
  await page.route("**/v1/assessment*", async (route) => {
    await route.fulfill({ status: 501, contentType: "application/json", body: JSON.stringify(NOT_CONFIGURED) });
  });
}

type Box = { x: number; y: number; width: number; height: number };

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test("result_summary_strip_follows_ring_visibility", async ({ page }) => {
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);
  const strip = page.getByTestId("result-summary");
  const ring = page.locator('section[aria-label="Combined score"]');
  const gauges = page.locator("section.gauge");

  // At the top: the ring is in view, so the strip stays mounted but
  // hidden (no layout space taken, nothing to overlap the gauges).
  await expect(ring).toBeInViewport();
  await expect(strip).toBeHidden();
  await expect(await gauges.count()).toBe(3);

  // Scroll until the combined score section is fully out of view: the strip
  // appears, with the score exactly once plus short probs and the hash.
  await page.evaluate(() => {
    document.querySelector('section[aria-label="Why this score"]')?.scrollIntoView(true);
  });
  await expect(ring).not.toBeInViewport();
  await expect(strip).toBeVisible();
  const text = (await strip.textContent()) ?? "";
  expect(text.match(/84 High/g)?.length).toBe(1);
  expect(text).toContain("Rug 62%");
  expect(text).toContain("Honey 91%");
  expect(text).toContain("Bot 34%");
  expect(text).toContain("0xabc");

  // Pinned to the top of the viewport, clear of every gauge card.
  const stripBox = await strip.boundingBox();
  expect(stripBox).not.toBeNull();
  if (stripBox !== null) {
    expect(stripBox.y).toBeLessThanOrEqual(8);
    for (let index = 0; index < 3; index += 1) {
      const gaugeBox = await gauges.nth(index).boundingBox();
      expect(gaugeBox).not.toBeNull();
      if (gaugeBox !== null) {
        expect(overlaps(stripBox, gaugeBox)).toBe(false);
      }
    }
  }

  // Scrolling back to the top: ring visible again, strip hidden again.
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(ring).toBeInViewport();
  await expect(strip).toBeHidden();
});

test("result_summary_probs_carry_full_text_as_title_on_narrow_phones", async ({ page }) => {
  // R-5: on <= 480 px the row truncates with ellipsis while the hero meta
  // is scrolled away, so the full string rides as the title (as the hash
  // span already does) for hover and long-press readers.
  await mockRest(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/token/${ADDRESS}`);
  // Mirror the sibling: wait for the assessed view before the one-shot
  // scroll, or it can run before Signals mounts and the strip never
  // appears on narrow phones.
  await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();
  await page.evaluate(() => {
    document.querySelector('section[aria-label="Why this score"]')?.scrollIntoView(true);
  });
  await expect(page.getByTestId("result-summary")).toBeVisible();
  const probs = page.locator(".compact-strip-probs");
  await expect(probs).toBeVisible();
  const full = "Rug 62% · Honey 91% · Bot 34%";
  await expect(probs).toHaveText(full);
  await expect(probs).toHaveAttribute("title", full);
});
