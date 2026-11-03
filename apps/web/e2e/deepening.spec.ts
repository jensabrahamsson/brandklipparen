// Playwright for UI P2 (S-100 stream view, S-101 explain panel). The
// field picker is retired in W-8: every section always renders. Every
// REST response is route-mocked with the fake adapter shape; no test
// reaches the network.
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

test("s100_stream_view_shows_analysis_before_deepening_status", async ({ page }) => {
  await mockAnalyze(page);
  await page.goto(`/#/token/${ADDRESS}`);
  await page.locator("details.tech-details > summary", { hasText: "Analysis tools" }).click();
  await page.getByRole("button", { name: "Stream", exact: true }).click();
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
  await page.getByRole("button", { name: "Explain this result" }).click();
  const output = page.getByTestId("muse-output");
  await expect(output).toContainText("Muse unavailable.");
  await expect(output.getByTestId("muse-advisory")).toContainText("Muse does not change the score.");
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
  await page.getByRole("button", { name: "Explain this result" }).click();
  const output = page.getByTestId("muse-output");
  // Script-bearing sentences stay inert text: no script element executes.
  await expect(output.getByText("<script>alert(1)</script> the owner can block selling.")).toBeVisible();
  expect(await output.locator("script").count()).toBe(0);
  await expect(page.getByTestId("explain-dropped")).toBeHidden();
  await output.locator("details.muse-details summary").click();
  await expect(page.getByTestId("explain-dropped")).toContainText("2 sentences removed: they cited no evidence.");
  await expect(output.getByTestId("muse-advisory")).toContainText("Muse does not change the score.");
  // Scores stand unchanged beside the console: the dial keeps the
  // number and the band word (W-9 removed the repeated score line).
  await expect(page.locator('section[aria-label="Combined score"] .score-dial .num')).toHaveText("84");
  await expect(page.locator('section[aria-label="Combined score"] .score-dial .bandtag')).toHaveText("HIGH");
});
