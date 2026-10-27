// Playwright smoke for the web UI (S-029): start page, token page with a
// mocked REST analyze response, and the assessment not-configured state.
// No live chain or provider calls: every REST response is route-mocked.
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

test("k020_start_page_loads_and_search_validates", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Know the risk before you buy." })).toBeVisible();
  await page.getByLabel("Contract address").fill("not-an-address");
  await page.getByRole("button", { name: "Analyze" }).click();
  await expect(page.getByRole("alert")).toContainText("Invalid address");
  expect(new URL(page.url()).hash).toBe("");
});

test("k020_valid_address_navigates_to_token_page", async ({ page }) => {
  await mockRest(page);
  await page.goto("/");
  await page.getByLabel("Contract address").fill(ADDRESS);
  await page.getByRole("button", { name: "Analyze" }).click();
  await expect(page).toHaveURL(new RegExp(`#/token/${ADDRESS}`));
});

test("k103_token_page_shows_score_as_number_and_word", async ({ page }) => {
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);
  await expect(page.getByRole("status").first()).toContainText("84");
  await expect(page.getByRole("status").first()).toContainText("High");
  await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();
  await expect(page.getByText("Honeypot", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("91%", { exact: true })).toBeVisible();
  await expect(page.getByText("What bytecode alone cannot tell you")).toBeVisible();
});

test("k305_assessment_tab_shows_not_configured", async ({ page }) => {
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);
  await page.getByRole("tab", { name: "Contract assessment with Muse" }).click();
  await expect(page.getByText("open weights")).toBeVisible();
  await page.getByRole("button", { name: "Request assessment" }).click();
  await expect(page.getByText("Assessment is not configured.")).toBeVisible();
  // The deterministic score stands untouched beside the panel.
  await page.getByRole("tab", { name: "Overview" }).click();
  await expect(page.getByRole("status").first()).toContainText("84");
});

test("k507_hostile_signal_renders_as_text_only", async ({ page }) => {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH_DISABLED) });
  });
  const hostile = { ...ANALYZE_FIXTURE };
  hostile.signals = [
    {
      kind: "capability",
      id: "<img src=x onerror=alert(1)>",
      risk: "honeypot",
      direction: "raises",
      severity: "high",
      evidence: [{ selector: "0x44337ea1", offset: 2623 }],
    },
  ];
  await page.route("**/v1/analyze*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(hostile) });
  });
  await page.goto(`/#/token/${ADDRESS}`);
  await expect(page.getByText("<img src=x onerror=alert(1)>").first()).toBeVisible();
  expect(await page.locator("section[aria-label='Signals'] img").count()).toBe(0);
});
