// S-133: desktop hero has no dead space. The left hero column (verdict
// copy plus the risk breakdown) must end near the bottom of the score
// dial at desktop widths, in every hero state, so no large empty area
// survives left of the dial.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const ADDRESS = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const HEALTH_DISABLED = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  costUnits: "placeholder-cost-unit",
};

function analyzeBody(score: number, probabilities: Record<string, number>): Record<string, unknown> {
  return {
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
    probabilities,
    score,
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
}

type HeroState = { score: number; deepening: "pending" | "ready" };

const current: HeroState = { score: 84, deepening: "pending" };

function probabilitiesFor(score: number): Record<string, number> {
  return score >= 60
    ? { "rug-pull": 0.62, honeypot: 0.91, "bot-pump": 0.34 }
    : score >= 30
      ? { "rug-pull": 0.4, honeypot: 0.45, "bot-pump": 0.3 }
      : { "rug-pull": 0.26, honeypot: 0.2, "bot-pump": 0.12 };
}

async function mockRest(page: Page): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH_DISABLED) });
  });
  await page.route("**/v1/analyze*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "x-deepening-status": current.deepening },
      body: JSON.stringify(analyzeBody(current.score, probabilitiesFor(current.score))),
    });
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
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ source: "none", status: "live", updatedAt: 0, items: [] }),
    });
  });
}

test("s133_desktop_hero_has_no_dead_space", async ({ page }) => {
  await mockRest(page);
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
  ]) {
    for (const score of [84, 45, 19]) {
      for (const deepening of ["pending", "ready"] as const) {
        current.score = score;
        current.deepening = deepening;
        await page.setViewportSize(viewport);
        await page.goto("/");
        await page.goto(`/#/token/${ADDRESS}`);
        const header = page.locator('section[aria-label="Combined score"]');
        await expect(header).toBeVisible();
        // Let the one-shot count-up settle so the dial reads final.
        await expect(header.locator(".score-dial .num")).toHaveText(String(score));
        const gap = await page.evaluate(() => {
          const hero = document.querySelector('section[aria-label="Combined score"]') as HTMLElement | null;
          const left = hero?.querySelector(":scope .score-ring-wrap > div:first-child") as HTMLElement | null;
          const dial = hero?.querySelector(":scope .score-dial") as HTMLElement | null;
          if (hero === null || left === null || dial === null) {
            return null;
          }
          const leftBox = left.getBoundingClientRect();
          const dialBox = dial.getBoundingClientRect();
          return dialBox.bottom - leftBox.bottom;
        });
        expect(gap).not.toBeNull();
        expect(Math.abs(gap ?? 1000)).toBeLessThanOrEqual(64);
      }
    }
  }
});

test("s133_hero_rebalance_keeps_mobile_within_viewport", async ({ page }) => {
  await mockRest(page);
  current.score = 84;
  current.deepening = "pending";
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.goto(`/#/token/${ADDRESS}`);
    const header = page.locator('section[aria-label="Combined score"]');
    await expect(header).toBeVisible();
    await expect(header.locator(".score-dial .num")).toHaveText("84");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  }
});
