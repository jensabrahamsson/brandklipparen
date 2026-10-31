// N-15 AI order e2e: applying the mocked mapping keeps "Why this score"
// directly under the score card, announces the applied notice in the
// role=status region, and Reset restores the standard order. Every REST
// response is route-mocked; no test reaches the network. Single narrow
// viewport keeps the score card in the grid so the pinned pair reads
// directly from DOM order.
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
  pluginResults: [],
};

const PLUGINS_FIXTURE = {
  plugins: [],
};

const HEALTH_DISABLED = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  costUnits: "placeholder-cost-unit",
};

const PERSONALIZE_STATUS = {
  status: "ok",
  apiVersion: "v1",
  personalize: { provider: "Meta", modelId: "meta-models/muse-spark-open-1026" },
};

function validSpecBody(): Record<string, unknown> {
  return {
    specVersion: 1,
    pluginRanking: [],
    placements: [
      { sectionId: "signals", emphasis: "high" },
      { sectionId: "score", emphasis: "normal" },
      { sectionId: "explanation", emphasis: "normal" },
    ],
  };
}

function personalizeOk(): Record<string, unknown> {
  return {
    status: "ok",
    apiVersion: "v1",
    personalize: {
      kind: "ok",
      provider: "Meta",
      modelId: "meta-models/muse-spark-open-1026",
      promptVersion: "1.0.0",
      cache: "miss",
      spec: validSpecBody(),
    },
  };
}

async function mockRest(page: Page): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH_DISABLED) });
  });
  await page.route("**/v1/analyze*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "x-deepening-status": "ready" },
      body: JSON.stringify(ANALYZE_FIXTURE),
    });
  });
  await page.route("**/v1/plugins", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PLUGINS_FIXTURE) });
  });
  await page.route("**/v1/personalize/status", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PERSONALIZE_STATUS) });
  });
  await page.route("**/v1/personalize", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(personalizeOk()) });
  });
}

async function openCustomize(page: Page): Promise<void> {
  const customize = page.locator("details.customize");
  await expect(customize).toBeVisible();
  if (!(await customize.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await customize.locator("summary").click();
  }
}

async function sectionOrder(page: Page): Promise<string[]> {
  return page.locator("div.token-grid div[data-section]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-section") ?? ""));
}

test("n15_ai_order_keeps_explanation_under_score_announces_and_resets", async ({ page }) => {
  await mockRest(page);
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto(`/#/token/${ADDRESS}`);
  await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();

  const standard = await sectionOrder(page);
  expect(standard[0]).toBe("score");
  expect(standard[1]).toBe("signals");

  await openCustomize(page);
  await page.getByTestId("priorities-field").fill("Can the owner stop me selling?");
  await page.getByTestId("ai-personalize-toggle").check();
  await page.getByTestId("ai-personalize-apply").click();

  await expect(page.getByTestId("ai-applied-compact")).toContainText("AI order applied");
  await openCustomize(page);
  await expect(page.getByTestId("ai-personalize-result")).toContainText("AI order applied");
  await expect(page.getByRole("status").filter({ hasText: "AI order applied" })).toBeVisible();

  const applied = await sectionOrder(page);
  expect(applied[0]).toBe("score");
  expect(applied[1]).toBe("explanation");

  const headings = await page.locator("div.token-grid h2").evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
  const riskIndex = headings.findIndex((text) => text.includes("Risk breakdown"));
  const whyIndex = headings.findIndex((text) => text.includes("Why this score"));
  expect(riskIndex).toBeGreaterThanOrEqual(0);
  expect(whyIndex).toBe(riskIndex + 1);

  await openCustomize(page);
  await expect(page.getByTestId("ai-personalize-reset")).toBeVisible();
  await page.getByTestId("ai-personalize-reset").click();

  const restored = await sectionOrder(page);
  expect(restored).toEqual(standard);
});
