// Playwright for UI P2 (S-100 field picker + stream view, S-101 explain
// panel). Every REST response is route-mocked with the fake adapter shape;
// no test reaches the network.
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

async function mockAnalyze(page: Page): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH_DISABLED) });
  });
  await page.route("**/v1/analyze/stream*", async (route) => {
    const body = `data: ${JSON.stringify(ANALYZE_FIXTURE)}\n\ndata: ${JSON.stringify({ kind: "deepening", status: "pending" })}\n\n`;
    await route.fulfill({ status: 200, contentType: "text/event-stream", body });
  });
  await page.route("**/v1/analyze*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "x-deepening-status": "pending" },
      body: JSON.stringify(ANALYZE_FIXTURE),
    });
  });
}

test("s100_field_picker_limits_sections_without_changing_score", async ({ page }) => {
  await mockAnalyze(page);
  await page.goto(`/#/token/${ADDRESS}`);
  const score = page.locator('section[aria-label="Combined score"]');
  await expect(score).toContainText("84 High");
  const before = await score.innerText();
  // The picked Signals section renders by default.
  await expect(page.locator('section[aria-label="Signals"]')).toBeVisible();
  // Clearing Signals hides it while the score stays byte-identical.
  await page.getByLabel("Show Signals").uncheck();
  await expect(page.locator('section[aria-label="Signals"]')).toHaveCount(0);
  expect(await score.innerText()).toBe(before);
  // Re-picking renders it again with the score still unchanged.
  await page.getByLabel("Show Signals").check();
  await expect(page.locator('section[aria-label="Signals"]')).toBeVisible();
  expect(await score.innerText()).toBe(before);
});

test("s100_stream_view_shows_analysis_before_deepening_status", async ({ page }) => {
  await mockAnalyze(page);
  await page.goto(`/#/token/${ADDRESS}`);
  await page.getByRole("button", { name: "Stream analysis" }).click();
  const analysis = page.getByTestId("stream-analysis");
  const deepening = page.getByTestId("stream-deepening");
  await expect(analysis).toContainText("score 84");
  await expect(deepening).toContainText("Deepening: pending");
  // The fast-path render sits ahead of the deepening line in DOM order.
  const order = await page.evaluate(() => {
    const first = document.querySelector("[data-testid='stream-analysis']");
    const second = document.querySelector("[data-testid='stream-deepening']");
    if (first === null || second === null) {
      return "missing";
    }
    const position = first.compareDocumentPosition(second);
    return position & Node.DOCUMENT_POSITION_FOLLOWING ? "analysis-first" : "wrong-order";
  });
  expect(order).toBe("analysis-first");
});

test("s101_explain_panel_shows_not_configured_without_key", async ({ page }) => {
  await mockAnalyze(page);
  await page.route("**/v1/explain*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", apiVersion: "v1", codeHash: "0xabc", explain: { kind: "not-configured" } }),
    });
  });
  await page.goto(`/#/token/${ADDRESS}`);
  await page.getByRole("button", { name: "Request explanation" }).click();
  await expect(page.getByTestId("explain-not-configured")).toContainText("Explanations are not configured.");
});

test("s101_explain_panel_renders_checked_sentences_as_inert_text", async ({ page }) => {
  await mockAnalyze(page);
  await page.route("**/v1/explain*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "ok",
        apiVersion: "v1",
        codeHash: "0xabc",
        explain: {
          kind: "ok",
          narrative: ["<script>alert(1)</script> the owner can block selling.", "Allowance logic looks standard."],
          droppedClaims: 2,
          provider: "test-adapter",
          modelId: "test-explain-1",
        },
      }),
    });
  });
  await page.goto(`/#/token/${ADDRESS}`);
  await page.getByRole("button", { name: "Request explanation" }).click();
  const panel = page.locator('section[aria-label="Explain panel"]');
  // Script-bearing sentences stay inert text: no script element executes.
  await expect(panel.getByText("<script>alert(1)</script> the owner can block selling.")).toBeVisible();
  expect(await panel.locator("script").count()).toBe(0);
  await expect(page.getByTestId("explain-dropped")).toContainText("2 unsupported claims dropped.");
  // Scores stand unchanged beside the panel.
  await expect(page.locator('section[aria-label="Combined score"]')).toContainText("84 High");
});
