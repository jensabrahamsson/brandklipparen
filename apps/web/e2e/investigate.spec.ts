// Playwright for the investigation loop UI (S-076, K-036, K-507, K-103).
// The REST API is route-mocked: no live chain or provider calls.
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
          rationale: "<img src=x onerror=alert(1)>",
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

function sseBody(): string {
  const stepOne = {
    kind: "step",
    step: 1,
    toolId: "evidence.list",
    rationale: "List the frozen evidence first.",
    evidenceIds: ["signal:owner-blacklist"],
  };
  const stepTwo = {
    kind: "step",
    step: 2,
    toolId: "detector.capability",
    rationale: "<img src=x onerror=alert(1)>",
    evidenceIds: ["signal:owner-blacklist"],
  };
  const report = {
    kind: "report",
    investigation: INVESTIGATE_DONE.investigation,
    investigationProvider: "hosted-open-weights",
    investigationModel: "meta-models/muse-spark-open-1026",
  };
  return (
    `data: ${JSON.stringify(stepOne)}\n\n` +
    `data: ${JSON.stringify(stepTwo)}\n\n` +
    `data: ${JSON.stringify(report)}\n\n`
  );
}

async function mockBase(page: Page): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH_DISABLED) });
  });
  await page.route("**/v1/analyze*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ANALYZE_FIXTURE) });
  });
}

test("k036_investigation_graph_renders_trace_steps_as_inert_text", async ({ page }) => {
  await mockBase(page);
  await page.route("**/v1/investigate/events*", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: sseBody() });
  });
  await page.route("**/v1/investigate*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(INVESTIGATE_DONE) });
  });
  await page.goto(`/#/token/${ADDRESS}`);
  await page.getByRole("tab", { name: "Investigate" }).click();
  await page.getByRole("button", { name: "Request investigation" }).click();
  const graph = page.locator('ol[aria-label="Investigation steps"]');
  await expect(graph.locator("li")).toHaveCount(2);
  await expect(graph).toContainText("evidence.list");
  await expect(graph).toContainText("List the frozen evidence first.");
  await expect(graph).toContainText("<img src=x onerror=alert(1)>");
  expect(await page.locator('section[aria-label="Investigation"] script').count()).toBe(0);
  expect(await page.locator('section[aria-label="Investigation"] img').count()).toBe(0);
  await expect(page.getByText("The frozen evidence shows the transfer guard.").first()).toBeVisible();
});

test("k036_investigation_shows_not_configured_limit_and_failure_states", async ({ page }) => {
  await mockBase(page);
  await page.route("**/v1/investigate/events*", async (route) => {
    await route.fulfill({
      status: 501,
      contentType: "application/json",
      body: JSON.stringify({
        status: 501,
        code: "investigation-not-configured",
        message: "Investigation is not configured.",
        requestId: "123e4567-e89b-12d3-a456-426614174000",
      }),
    });
  });
  await page.route("**/v1/investigate*", async (route) => {
    await route.fulfill({
      status: 501,
      contentType: "application/json",
      body: JSON.stringify({
        status: 501,
        code: "investigation-not-configured",
        message: "Investigation is not configured.",
        requestId: "123e4567-e89b-12d3-a456-426614174000",
      }),
    });
  });
  await page.goto(`/#/token/${ADDRESS}`);
  await page.getByRole("tab", { name: "Investigate" }).click();
  await page.getByRole("button", { name: "Request investigation" }).click();
  await expect(page.getByText("AI investigation is not configured on this server.")).toBeVisible();
  // The deterministic score stands untouched beside the panel.
  await page.getByRole("tab", { name: "Overview" }).click();
  await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();
});

test("k036_investigation_step_limit_shows_plain_state_with_inert_narrative", async ({ page }) => {
  await mockBase(page);
  const limited = {
    ...ANALYZE_FIXTURE,
    investigation: {
      status: "failed",
      reason: { kind: "step-limit", message: "investigation step budget spent", limit: 8 },
      partial: [],
      collectedEvidenceIds: [],
      limits: { maxSteps: 8, maxTokens: 8000, deadlineMs: 60000, toolTimeoutMs: 5000 },
    },
    investigationProvider: "hosted-open-weights",
    investigationModel: "meta-models/muse-spark-open-1026",
  };
  await page.route("**/v1/investigate/events*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(limited) });
  });
  await page.route("**/v1/investigate*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(limited) });
  });
  await page.goto(`/#/token/${ADDRESS}`);
  await page.getByRole("tab", { name: "Investigate" }).click();
  await page.getByRole("button", { name: "Request investigation" }).click();
  await expect(page.getByText(/step budget/)).toBeVisible();
});

test("k036_investigation_forced_conclusion_names_the_step_limit", async ({ page }) => {
  await mockBase(page);
  const forced = {
    ...ANALYZE_FIXTURE,
    investigation: {
      status: "done",
      report: {
        narrative: "The frozen evidence shows the transfer guard. [E:signal:owner-blacklist]",
        droppedClaims: 0,
        forcedConclusion: true,
        steps: [
          {
            step: 1,
            toolId: "evidence.list",
            rationale: "List the frozen evidence first.",
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
  await page.route("**/v1/investigate/events*", async (route) => {
    await route.abort("failed");
  });
  await page.route("**/v1/investigate*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(forced) });
  });
  await page.goto(`/#/token/${ADDRESS}`);
  await page.getByRole("tab", { name: "Investigate" }).click();
  await page.getByRole("button", { name: "Request investigation" }).click();
  await expect(page.getByText("Muse concluded at the step limit.")).toBeVisible();
});

test("k036_investigation_post_fallback_renders_same_trace_without_events", async ({ page }) => {
  await mockBase(page);
  await page.route("**/v1/investigate/events*", async (route) => {
    await route.abort("failed");
  });
  await page.route("**/v1/investigate*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(INVESTIGATE_DONE) });
  });
  await page.goto(`/#/token/${ADDRESS}`);
  await page.getByRole("tab", { name: "Investigate" }).click();
  await page.getByRole("button", { name: "Request investigation" }).click();
  const graph = page.locator('ol[aria-label="Investigation steps"]');
  await expect(graph.locator("li")).toHaveCount(2);
  await expect(page.getByText("The frozen evidence shows the transfer guard.").first()).toBeVisible();
});
