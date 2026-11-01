// S-125: investigate trace as a static timeline. Steps render as an
// ordered list with one number per step joined by a static connector;
// evidence and narrative citations are chips that move focus to the linked
// signal and expand it; nothing transforms and steps appear instantly
// under reduced motion.
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

test("s125_investigation_timeline_chips", async ({ page, browser }) => {
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);
  await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();

  await page.getByRole("button", { name: "Investigate", exact: true }).click();
  const graph = page.locator('ol.timeline[aria-label="Investigation steps"]');
  await expect(graph.locator("li.timeline-step")).toHaveCount(2);
  await expect(page.locator('ol[data-graph="3d"]')).toHaveCount(0);

  // One number per step: the node carries the numeral, with no doubled
  // "Step N:" text anywhere in the trace.
  const nodes = await graph.locator(".timeline-node").allTextContents();
  expect(nodes.map((text) => text.trim())).toEqual(["1", "2"]);
  expect(await graph.getByText(/Step \d+:/).count()).toBe(0);

  // The tool name reads as a mono chip; the connector is static.
  await expect(graph.locator(".tool-chip").first()).toContainText("evidence.list");
  const connector = await graph
    .locator("li.timeline-step")
    .first()
    .evaluate((element) => getComputedStyle(element, "::before").animationName);
  expect(connector).toBe("none");
  const transforms = await page.evaluate(() => {
    const bad: string[] = [];
    document.querySelectorAll(".timeline, .timeline-step, .timeline-node, .timeline-body").forEach((element) => {
      if (getComputedStyle(element).transform !== "none") {
        bad.push(element.className);
      }
    });
    return bad;
  });
  expect(transforms).toEqual([]);

  // Evidence chips are buttons in step order; the first one moves focus
  // to the linked signal and expands it.
  const chips = graph.locator('button.chip[data-evidence="signal:owner-blacklist"]');
  expect(await chips.count()).toBeGreaterThanOrEqual(2);
  await chips.first().click();
  // With the tabs gone the chip moves focus straight to the linked
  // signal article and expands it in place.
  const signalArticle = page.locator('section[aria-label="Why this score"] article').first();
  await expect(signalArticle.locator("details[open]")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest("article") !== null), { timeout: 3000 })
    .toBe(true);

  // Narrative citations render as the same chips.
  await expect(page.locator("text=The frozen evidence shows the transfer guard.")).toBeVisible();
  await expect(page.locator('section[aria-label="Investigation"] button.chip[data-evidence]').first()).toBeVisible();

  // Under reduced motion the steps appear instantly with no animation.
  const reduced = await browser.newContext({ reducedMotion: "reduce" });
  const reducedPage = await reduced.newPage();
  await mockRest(reducedPage);
  await reducedPage.goto(`/#/token/${ADDRESS}`);
  await expect(reducedPage.getByRole("img", { name: /Combined score/ })).toBeVisible();
  await reducedPage.getByRole("button", { name: "Investigate", exact: true }).click();
  const reducedGraph = reducedPage.locator('ol.timeline[aria-label="Investigation steps"]');
  await expect(reducedGraph.locator("li.timeline-step")).toHaveCount(2);
  const bodyAnimation = await reducedGraph
    .locator(".timeline-body")
    .first()
    .evaluate((element) => getComputedStyle(element).animationName);
  expect(bodyAnimation).toBe("none");
  expect(await reducedPage.evaluate(() => document.getAnimations().length)).toBe(0);
  await reduced.close();
});
