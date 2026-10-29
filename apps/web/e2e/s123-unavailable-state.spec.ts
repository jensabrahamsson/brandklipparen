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
  personalize: { disabled: true },
  onchain: { disabled: true },
  costUnits: "placeholder-cost-unit",
};

function isAiCall(pathname: string): boolean {
  return (
    pathname.startsWith("/v1/assessment") ||
    pathname.startsWith("/v1/investigate") ||
    pathname.startsWith("/v1/explain") ||
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

  // Overview panels decide up front: Explain and On-chain show the
  // unavailable state with no enabled request button.
  await expect(page.getByTestId("explain-unavailable")).toContainText("Explanations are not configured on this server.");
  await expect(page.getByTestId("onchain-unavailable")).toContainText("On-chain features are not configured on this server.");
  await page.getByTestId("explain-unavailable").locator("button").evaluate((element) => {
    (element as HTMLButtonElement).click();
  });
  await page.getByTestId("onchain-unavailable").locator("button").evaluate((element) => {
    (element as HTMLButtonElement).click();
  });

  // Assessment tab: neutral pill, plain reason, disabled primary button.
  await page.getByRole("tab", { name: "Contract assessment" }).click();
  const assessmentPanel = page.locator('section[aria-label="Contract assessment"]');
  await expect(assessmentPanel.getByText("Contract assessment: Unavailable")).toBeVisible();
  await expect(assessmentPanel.getByText("Contract assessment is not configured on this server.")).toBeVisible();
  const assessmentButton = assessmentPanel.getByRole("button", { name: "Request assessment" });
  await expect(assessmentButton).toBeDisabled();
  await expect(assessmentButton).toHaveAttribute("aria-disabled", "true");
  await assessmentButton.evaluate((element) => {
    (element as HTMLButtonElement).click();
  });

  // Investigate tab: the same designed state, no enabled dead-end button.
  await page.getByRole("tab", { name: "Investigate" }).click();
  const investigatePanel = page.locator('section[aria-label="Investigation"]');
  await expect(investigatePanel.getByText("Investigation: Unavailable")).toBeVisible();
  await expect(investigatePanel.getByText("AI investigation is not configured on this server.")).toBeVisible();
  const investigateButton = investigatePanel.getByRole("button", { name: "Request investigation" });
  await expect(investigateButton).toBeDisabled();
  await investigateButton.evaluate((element) => {
    (element as HTMLButtonElement).click();
  });

  // AI personalize: a disabled checkbox with the reason as its description.
  await page.getByRole("tab", { name: "Overview" }).click();
  await page.locator("details.customize > summary").click();
  const toggle = page.getByTestId("ai-personalize-toggle");
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute("aria-describedby", "ai-personalize-status");
  await expect(page.getByTestId("ai-personalize-label")).toContainText("Mapping provider not configured on this server.");

  // Every click above targeted a disabled control: no AI request may fire.
  await page.waitForTimeout(500);
  expect(aiCalls).toEqual([]);

  // The disabled buttons keep a visible 3:1 boundary and announce the
  // reason. Panels unmount on tab switch, so measure each tab in turn.
  const boundaries: Array<{ ratio: number; reason: string | null }> = [];
  for (const tab of ["Overview", "Contract assessment", "Investigate"] as const) {
    await page.getByRole("tab", { name: tab }).click();
    const found = await page.evaluate(() => {
      const parse = (value: string): readonly [number, number, number] => {
        const match = value.match(/[\d.]+/g) ?? [];
        return [Number(match[0] ?? 0), Number(match[1] ?? 0), Number(match[2] ?? 0)];
      };
      const luminance = (rgb: readonly [number, number, number]): number => {
        const linear = rgb.map((channel) => {
          const value = channel / 255;
          return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
      };
      return Array.from(document.querySelectorAll("section button.button:disabled")).map((element) => {
        const style = getComputedStyle(element);
        const edge = luminance(parse(style.borderColor));
        const face = luminance(parse(style.backgroundColor));
        const describedBy = element.getAttribute("aria-describedby") ?? "";
        const reason = describedBy === "" ? null : document.getElementById(describedBy)?.textContent ?? null;
        return {
          ratio: (Math.max(edge, face) + 0.05) / (Math.min(edge, face) + 0.05),
          reason,
        };
      });
    });
    // The pills are neutral: no brand dot inside, only the outline icon.
    expect(await page.locator(".unavailable-pill .assessment-dot").count()).toBe(0);
    expect(await page.locator(".unavailable-pill svg").count()).toBeGreaterThan(0);
    boundaries.push(...found);
  }
  expect(boundaries.length).toBe(4);
  for (const boundary of boundaries) {
    expect(boundary.ratio).toBeGreaterThanOrEqual(3);
    expect(boundary.reason).toMatch(/not configured on this server/);
  }

  // No operator instructions anywhere on the page.
  const bodyText = await page.evaluate(() => document.body.innerText);
  for (const banned of ["Set its key", "Set one with", "ETHERSCAN", ".env"]) {
    expect(bodyText).not.toContain(banned);
  }
});
