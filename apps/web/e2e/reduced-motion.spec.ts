// Playwright for the motion rules (Phosphor Console): default mode
// allows only short (at most 300 ms) opacity/colour/shadow transitions
// plus looping glow/opacity pulses inside 1.0-3.2 s, and never
// transforms; with prefers-reduced-motion the UI is fully static. No
// card carries a transform, no container uses perspective, the
// investigate trace is always the flat 2D list.
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
      body: JSON.stringify({ mapping: { disabled: true } }),
    });
  });
  await page.route("**/v1/investigate/events*", async (route) => {
    await route.abort("failed");
  });
  await page.route("**/v1/investigate*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(INVESTIGATE_DONE) });
  });
}

test("default_motion_is_short_pulses_bounded_and_never_transforms", async ({ page }) => {
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);

  const cards = page.locator(".card, .cant-tell");
  await expect(cards.first()).toBeVisible();

  const violations = await page.evaluate(() => {
    const bad: string[] = [];
    document.querySelectorAll("*").forEach((element) => {
      const style = getComputedStyle(element);
      style.transitionDuration.split(",").forEach((part, index) => {
        const seconds = Number.parseFloat(part);
        if (!(seconds > 0)) {
          return;
        }
        const properties = style.transitionProperty.split(",");
        const property = (properties[Math.min(index, properties.length - 1)] ?? "").trim();
        if (seconds > 0.3 || property.includes("transform")) {
          bad.push(`${element.tagName}<${element.getAttribute("class") ?? ""}> ${property} ${part.trim()}`);
        }
      });
      // Looping animations must be glow/opacity pulses inside 1.0-3.2 s:
      // blinks run at most 1 Hz, breathing between 1.4 s and 3.2 s.
      if (style.animationName !== "none") {
        const counts = style.animationIterationCount.split(",").map((part) => part.trim());
        const durations = style.animationDuration.split(",").map((part) => Number.parseFloat(part));
        counts.forEach((count, index) => {
          if (count === "infinite" || Number.parseFloat(count) > 1) {
            const seconds = durations[Math.min(index, durations.length - 1)] ?? 0;
            if (!(seconds >= 1 && seconds <= 3.2)) {
              bad.push(
                `${element.tagName}<${element.getAttribute("class") ?? ""}> loop ${style.animationName} ${seconds}s`,
              );
            }
          }
        });
      }
    });
    return bad;
  });
  expect(violations).toEqual([]);
});

test("reduced_motion_has_no_animation_or_transform", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);

  // evaluateAll does not auto-wait, so wait until the token view has rendered its cards.
  const cards = page.locator(".card, .cant-tell");
  await expect(cards.first()).toBeVisible();

  const violations = await page.evaluate(() => {
    const bad: string[] = [];
    document.querySelectorAll("*").forEach((element) => {
      const style = getComputedStyle(element);
      const animated =
        style.animationName !== "none" &&
        style.animationDuration.split(",").some((part) => Number.parseFloat(part) > 0);
      const transitioned =
        style.transitionProperty !== "none" &&
        style.transitionDuration.split(",").some((part) => Number.parseFloat(part) > 0);
      if (animated || transitioned) {
        bad.push(`${element.tagName}<${element.getAttribute("class") ?? ""}>`);
      }
    });
    return bad;
  });
  expect(violations).toEqual([]);

  const transforms = await cards.evaluateAll((elements) =>
    elements.map((element) => getComputedStyle(element).transform),
  );
  expect(transforms.length).toBeGreaterThan(0);
  for (const transform of transforms) {
    expect(transform).toBe("none");
  }

  await page.getByRole("button", { name: "Investigate", exact: true }).click();
  const graph = page.locator('ol[aria-label="Investigation steps"]');
  await expect(graph).toHaveAttribute("data-graph", "2d");
  await expect(graph.locator("li")).toHaveCount(2);
  await expect(page.locator('ol[data-graph="3d"]')).toHaveCount(0);
  expect(await graph.evaluate((element) => getComputedStyle(element).perspective)).toBe("none");
});

test("hover_leaves_cards_flat_without_perspective", async ({ page }) => {
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);

  const cards = page.locator(".card, .cant-tell");
  await expect(cards.first()).toBeVisible();
  await cards.first().hover();
  expect(await cards.first().evaluate((element) => getComputedStyle(element).transform)).toBe("none");
  expect(
    await page.locator(".token-grid").evaluate((element) => getComputedStyle(element).perspective),
  ).toBe("none");

  await page.getByRole("button", { name: "Investigate", exact: true }).click();
  const graph = page.locator('ol[aria-label="Investigation steps"]');
  await expect(graph.locator("li")).toHaveCount(2);
  expect(await graph.evaluate((element) => getComputedStyle(element).perspective)).toBe("none");
});

test("motion_switch_off_is_static_without_emulation", async ({ page }) => {
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);

  const cards = page.locator(".card, .cant-tell");
  await expect(cards.first()).toBeVisible();
  const motion = page.getByTestId("motion-switch");
  await expect(motion).toHaveAttribute("aria-checked", "true");
  await motion.click();
  await expect(motion).toHaveAttribute("aria-checked", "false");
  expect(await page.evaluate(() => document.documentElement.dataset["motion"])).toBe("off");

  // Same interaction script as the reduced-motion run: hover, open a
  // tooltip, expand a signal and run the investigation. Nothing may
  // animate or transition while the switch is off.
  await cards.first().hover();
  await page.locator('[data-testid="explain-score:combined"]').focus();
  await page.locator('section[aria-label="Signals"] article > button[aria-expanded]').first().click();
  await page.getByRole("button", { name: "Investigate", exact: true }).click();
  const graph = page.locator('ol[aria-label="Investigation steps"]');
  await expect(graph.locator("li")).toHaveCount(2);
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);

  const violations = await page.evaluate(() => {
    const bad: string[] = [];
    document.querySelectorAll("*").forEach((element) => {
      const style = getComputedStyle(element);
      const animated =
        style.animationName !== "none" &&
        style.animationDuration.split(",").some((part) => Number.parseFloat(part) > 0);
      const transitioned =
        style.transitionProperty !== "none" &&
        style.transitionDuration.split(",").some((part) => Number.parseFloat(part) > 0);
      if (animated || transitioned) {
        bad.push(`${element.tagName}<${element.getAttribute("class") ?? ""}>`);
      }
    });
    return bad;
  });
  expect(violations).toEqual([]);
});

test("investigation_graph_runs_no_animations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);

  // Full interaction script under reduced motion: hover, open a tooltip,
  // expand a signal and switch tabs. Nothing may animate at any point.
  const cards = page.locator(".card, .cant-tell");
  await expect(cards.first()).toBeVisible();
  await cards.first().hover();
  await page.locator('[data-testid="explain-score:combined"]').focus();
  await page.locator('section[aria-label="Signals"] article > button[aria-expanded]').first().click();
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);

  await page.getByRole("button", { name: "Investigate", exact: true }).click();
  const graph = page.locator('ol[aria-label="Investigation steps"]');
  await expect(graph.locator("li")).toHaveCount(2);
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
});
