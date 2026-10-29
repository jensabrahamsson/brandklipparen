// S-122: motion tokens and micro-interactions. In default mode every
// transition lasts at most 300 ms, no animation loops forever, and hover
// never changes transform; the score ring draws once on mount and then
// stays put. Under reduced motion the duration tokens collapse to 0 ms
// and a full interaction script leaves zero running animations.
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
  investigationProvider: "hosted-open-weights",
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

  // Default mode: no transition runs longer than 300 ms and no animation
  // loops forever.
  const violations = await page.evaluate(() => {
    const bad: string[] = [];
    document.querySelectorAll("*").forEach((element) => {
      const style = getComputedStyle(element);
      style.transitionDuration.split(",").forEach((part) => {
        if (Number.parseFloat(part) > 0.3) {
          bad.push(`${element.tagName} duration ${part.trim()}`);
        }
      });
      if (style.animationName !== "none") {
        const counts = style.animationIterationCount.split(",").map((part) => part.trim());
        if (counts.some((part) => part === "infinite" || Number.parseFloat(part) > 1)) {
          bad.push(`${element.tagName} iteration ${counts.join(",")}`);
        }
      }
    });
    return bad;
  });
  expect(violations).toEqual([]);

  // Hover never changes transform on cards, tabs or explain triggers.
  const hoverTargets = [cards.first(), page.locator(".tab").first(), page.locator(".explain-trigger").first()];
  for (const target of hoverTargets) {
    const before = await target.evaluate((element) => getComputedStyle(element).transform);
    await target.hover();
    expect(await target.evaluate((element) => getComputedStyle(element).transform)).toBe(before);
    expect(before).toBe("none");
  }

  // The score ring draws once on mount over the slow token, then holds
  // its final value through later interaction.
  const arc = page.locator(".score-arc");
  await expect(arc).toBeAttached();
  expect(await arc.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0.28s");
  await page.waitForTimeout(600);
  const settled = await arc.evaluate((element) => element.getAttribute("stroke-dasharray") ?? "");
  expect(Number.parseFloat(settled)).toBeGreaterThan(0);
  await cards.first().hover();
  await page.waitForTimeout(400);
  expect(await arc.evaluate((element) => element.getAttribute("stroke-dasharray") ?? "")).toBe(settled);

  // Reduced motion: the duration tokens collapse and the full
  // interaction script stays animation-free and instant.
  const reduced = await browser.newContext({ reducedMotion: "reduce" });
  const reducedPage = await reduced.newPage();
  await mockRest(reducedPage);
  await reducedPage.goto(`/#/token/${ADDRESS}`);
  await expect(reducedPage.locator(".card").first()).toBeVisible();

  const tokens = await reducedPage.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return [
      root.getPropertyValue("--dur-fast").trim(),
      root.getPropertyValue("--dur-base").trim(),
      root.getPropertyValue("--dur-slow").trim(),
    ];
  });
  expect(tokens).toEqual(["0ms", "0ms", "0ms"]);

  // The ring renders final at once: the dash opens with no animation.
  const instant = await reducedPage
    .locator(".score-arc")
    .evaluate((element) => element.getAttribute("stroke-dasharray") ?? "");
  expect(Number.parseFloat(instant)).toBeGreaterThan(0);

  await reducedPage.locator(".card").first().hover();
  await reducedPage.locator('[data-testid="explain-score:combined"]').focus();
  await reducedPage.locator('section[aria-label="Signals"] article > button[aria-expanded]').first().click();
  await reducedPage.getByRole("tab", { name: "Contract assessment" }).click();
  await reducedPage.getByRole("tab", { name: "Investigate" }).click();
  await reducedPage.getByRole("button", { name: "Request investigation" }).click();
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
