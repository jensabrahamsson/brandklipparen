// S-122: phosphor motion tokens and micro-interactions. In default mode
// every transition lasts at most 300 ms, nothing uses transform or
// perspective, hover never changes transform, and every running animation
// touches only opacity/colour/glow with infinite cycles inside 1.0-3.2 s
// (blinks at most 1 Hz). The 50-tick dial lights once on mount and then
// holds its final value. Under reduced motion the full interaction script
// stays animation-free and count-ups render final at once.
// Every REST response is route-mocked.
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

const INVESTIGATE_DONE = {
  ...ANALYZE_FIXTURE,
  investigation: {
    status: "done",
    report: {
      narrative: "The frozen evidence shows the transfer guard. [E:signal:owner-blacklist]",
      droppedClaims: 0,
      steps: [
        {
          step: 1,
          toolId: "evidence.list",
          rationale: "List the frozen evidence first.",
          evidenceIds: ["signal:owner-blacklist"],
          elapsedMs: 0,
        },
        {
          step: 2,
          toolId: "detector.capability",
          rationale: "Check the capability findings.",
          evidenceIds: ["signal:owner-blacklist"],
          elapsedMs: 0,
        },
      ],
      collectedEvidenceIds: ["signal:owner-blacklist"],
    },
    limits: { maxSteps: 8, maxTokens: 8000, deadlineMs: 60000, toolTimeoutMs: 5000 },
  },
  investigationProvider: "meta-model-api",
  investigationModel: "meta-models/muse-spark-open-1026",
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
      body: JSON.stringify({ status: "ok", apiVersion: "v1", personalize: { disabled: true } }),
    });
  });
  await page.route("**/v1/investigate/events*", async (route) => {
    await route.abort("failed");
  });
  await page.route("**/v1/investigate*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(INVESTIGATE_DONE) });
  });
}

test("s122_motion_tokens_short_static_under_reduce", async ({ page, browser }) => {
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);

  const cards = page.locator(".card");
  await expect(cards.first()).toBeVisible();

  // Default mode: no transition runs longer than 300 ms.
  const violations = await page.evaluate(() => {
    const bad: string[] = [];
    document.querySelectorAll("*").forEach((element) => {
      const style = getComputedStyle(element);
      style.transitionDuration.split(",").forEach((part) => {
        if (Number.parseFloat(part) > 0.3) {
          bad.push(`${element.tagName} duration ${part.trim()}`);
        }
      });
    });
    return bad;
  });
  expect(violations).toEqual([]);

  // No transform or perspective anywhere in the author stylesheets.
  const motionDeclarations = await page.evaluate(() => {
    const found: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | null = null;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules ?? [])) {
        if (rule instanceof CSSStyleRule) {
          const transform = rule.style.getPropertyValue("transform");
          const perspective = rule.style.getPropertyValue("perspective");
          if (transform !== "" || perspective !== "") {
            found.push(`${rule.selectorText} ${transform} ${perspective}`);
          }
        }
      }
    }
    return found;
  });
  expect(motionDeclarations).toEqual([]);

  // Hover never changes transform on cards, console buttons or explain triggers.
  const hoverTargets = [cards.first(), page.getByRole("button", { name: "Explain this result" }), page.locator(".explain-trigger").first()];
  for (const target of hoverTargets) {
    const before = await target.evaluate((element) => getComputedStyle(element).transform);
    await target.hover();
    expect(await target.evaluate((element) => getComputedStyle(element).transform)).toBe(before);
    expect(before).toBe("none");
  }

  // The 50-tick dial lights once on mount to the score share (84 lights
  // 42), then holds its final value through later interaction.
  await expect(page.locator(".score-dial .tick.lit")).toHaveCount(42);
  await cards.first().hover();
  await page.waitForTimeout(400);
  await expect(page.locator(".score-dial .tick.lit")).toHaveCount(42);

  // Reduced motion: the full interaction script stays animation-free and
  // instant, and count-ups render final at once.
  const reduced = await browser.newContext({ reducedMotion: "reduce" });
  const reducedPage = await reduced.newPage();
  await mockRest(reducedPage);
  await reducedPage.goto(`/#/token/${ADDRESS}`);
  await expect(reducedPage.locator(".card").first()).toBeVisible();

  // The dial renders final at once: all 42 ticks lit, number at target.
  await expect(reducedPage.locator(".score-dial .tick.lit")).toHaveCount(42);
  await expect(reducedPage.locator(".score-dial .num")).toHaveText("84");

  await reducedPage.locator(".card").first().hover();
  await reducedPage.locator('[data-testid="explain-score:combined"]').focus();
  await reducedPage.locator('section[aria-label="Why this score"] article details > summary').first().click();
  await reducedPage.getByRole("button", { name: "Investigate", exact: true }).click();
  const graph = reducedPage.locator('ol[aria-label="Investigation steps"]');
  await expect(graph.locator("li")).toHaveCount(2);
  await reducedPage.waitForTimeout(600);

  const durations = await reducedPage.evaluate(() => {
    const bad: string[] = [];
    document.querySelectorAll("*").forEach((element) => {
      const style = getComputedStyle(element);
      style.transitionDuration.split(",").forEach((part) => {
        if (Number.parseFloat(part) > 0) {
          bad.push(element.tagName);
        }
      });
      if (
        style.animationName !== "none" &&
        style.animationDuration.split(",").some((part) => Number.parseFloat(part) > 0)
      ) {
        bad.push(`${element.tagName}:animated`);
      }
    });
    return bad;
  });
  expect(durations).toEqual([]);
  expect(await reducedPage.evaluate(() => document.getAnimations().length)).toBe(0);
  await reduced.close();
});

test("s122_no_motion_switch_anywhere", async ({ page }) => {
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);
  await expect(page.locator(".card").first()).toBeVisible();

  // No switch in any footer; the token footer links to Settings instead.
  await expect(page.getByTestId("motion-switch")).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Animations" })).toHaveCount(0);
  await expect(page.locator(".page-foot")).toContainText("Deterministic score · Muse is advisory");
  await expect(page.locator(".page-foot .foot-model")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Use your own API key" })).toHaveAttribute("href", "#/settings");

  // Settings holds the API key field and no motion switch: motion
  // follows only the operating-system reduced-motion setting.
  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByLabel("API key", { exact: true })).toBeVisible();
  await expect(page.getByTestId("motion-switch")).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Animations" })).toHaveCount(0);
});
