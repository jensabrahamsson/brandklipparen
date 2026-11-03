// S-123: one designed unavailable state for AI features. With every
// provider off, the token page decides up front from /health: no enabled
// button may fire a request that answers not-configured, the disabled
// buttons keep a 3:1 boundary, and screen readers hear the reason.
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

const HEALTH_ALL_DISABLED = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  investigation: { disabled: true },
  explain: { disabled: true },
  chat: { disabled: true },
  rug: { disabled: true },
  personalize: { disabled: true },
  onchain: { disabled: true },
  costUnits: "placeholder-cost-unit",
};

function isAiCall(pathname: string): boolean {
  return (
    pathname.startsWith("/v1/assessment") ||
    pathname.startsWith("/v1/investigate") ||
    pathname.startsWith("/v1/explain") ||
    pathname.startsWith("/v1/chat") ||
    pathname.startsWith("/v1/rug") ||
    pathname === "/v1/personalize"
  );
}

async function mockRest(page: Page, aiCalls: string[]): Promise<void> {
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (isAiCall(pathname)) {
      aiCalls.push(`${request.method()} ${pathname}`);
    }
  });
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH_ALL_DISABLED) });
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
  await page.route("**/v1/assessment**", async (route) => {
    await route.fulfill({ status: 501, contentType: "application/json", body: JSON.stringify({ code: "x", message: "off" }) });
  });
  await page.route("**/v1/investigate**", async (route) => {
    await route.fulfill({ status: 501, contentType: "application/json", body: JSON.stringify({ code: "x", message: "off" }) });
  });
  await page.route("**/v1/explain**", async (route) => {
    await route.fulfill({ status: 501, contentType: "application/json", body: JSON.stringify({ code: "x", message: "off" }) });
  });
  await page.route("**/v1/personalize", async (route) => {
    await route.fulfill({ status: 501, contentType: "application/json", body: JSON.stringify({ code: "x", message: "off" }) });
  });
}

test("s123_unavailable_state_blocks_all_ai_calls", async ({ page }) => {
  const aiCalls: string[] = [];
  await mockRest(page, aiCalls);
  await page.goto(`/#/token/${ADDRESS}`);
  await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();

  // The console decides up front from /health: with nothing configured it
  // collapses to one line and renders no request control at all, so no
  // action can invite a call that answers not-configured.
  const consoleCard = page.locator('section[aria-label="Muse console"]');
  await expect(consoleCard.getByTestId("muse-unavailable")).toContainText("Muse is off. Score is unaffected.");
  await expect(consoleCard.getByTestId("muse-unavailable")).not.toContainText(
    "Everything above is computed without it.",
  );
  await expect(consoleCard.locator("button")).toHaveCount(0);
  await expect(consoleCard.locator("input")).toHaveCount(0);
  await expect(page.locator('section[aria-label="Muse console"] button[disabled]')).toHaveCount(0);
  await expect(page.locator('section[aria-label="Investigation"]')).toHaveCount(0);

  // No AI request fires: there is no control left to press.
  await page.waitForTimeout(500);
  expect(aiCalls).toEqual([]);

  // No operator instructions anywhere on the page.
  const bodyText = await page.evaluate(() => document.body.innerText);
  for (const banned of ["Set its key", "Set one with", "ETHERSCAN", ".env"]) {
    expect(bodyText).not.toContain(banned);
  }
});
