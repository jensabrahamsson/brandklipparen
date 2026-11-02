// Playwright smoke for the web UI: start page, token page with a mocked
// REST analyze response, and the assessment not-configured state. No live
// chain or provider calls: every REST response is route-mocked.
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

const HEALTH_NOTHING = {
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

const EXPLAIN_OK = {
  status: "ok",
  apiVersion: "v1",
  codeHash: "0xabc",
  explain: {
    kind: "ok",
    narrative: ["The owner can stop chosen wallets from sending tokens.", "Pause and blacklist are owner-only."],
    droppedClaims: 2,
    provider: "test-adapter",
    modelId: "test-explain-1",
  },
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
  await page.route("**/v1/explain*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(EXPLAIN_OK) });
  });
}

async function mockNothing(page: Page): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH_NOTHING) });
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

test("k020_start_page_loads_and_search_validates", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Scan before you swap." })).toBeVisible();
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
  await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();
  // W-9: the hero no longer repeats the score line; the dial keeps the
  // number and the band word, and the gauges own the percents.
  await expect(page.locator('section[aria-label="Combined score"] .score-dial .num')).toHaveText("84");
  await expect(page.locator('section[aria-label="Combined score"] .score-dial .bandtag')).toHaveText("HIGH");
  await expect(page.getByText("Honeypot", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("91%", { exact: true })).toBeVisible();
  await expect(page.getByText("What bytecode alone cannot tell you")).toBeVisible();
  // U-3 hero diet: gauge reasons hide at >=1100, so the claim sentence is
  // asserted inside "Why this score" where it always renders.
  const whyCard = page.locator('section[aria-label="Why this score"]');
  await expect(whyCard.getByText("The owner can stop you from selling.").first()).toBeVisible();
  await expect(whyCard).not.toContainText("v1.0.0");
  await page.getByTestId("expert-switch").click();
  await expect(page.getByTestId("expert-switch")).toHaveAttribute("aria-checked", "true");
  await expect(whyCard).toContainText("v1.0.0");
});

test("k305_console_shows_not_connected_when_nothing_configured", async ({ page }) => {
  await mockNothing(page);
  await page.goto(`/#/token/${ADDRESS}`);
  const consoleCard = page.locator('section[aria-label="Muse console"]');
  await expect(consoleCard.getByTestId("muse-unavailable")).toContainText("Muse is not connected on this server.");
  // No buttons at all in the one-line state, enabled or disabled.
  await expect(consoleCard.locator("button")).toHaveCount(0);
  await expect(consoleCard.locator("button[disabled]")).toHaveCount(0);
  // The deterministic score stands untouched beside the console.
  await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();
});

test("w3_console_sits_after_hero_with_explain_above_fold", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);
  await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();
  // The console is the next sibling after the hero section.
  const nextLabel = await page.evaluate(() => {
    const hero = document.querySelector('section[aria-label="Combined score"]');
    const next = hero?.nextElementSibling;
    return next?.getAttribute("aria-label") ?? "missing";
  });
  expect(nextLabel).toBe("Muse console");
  // The Explain button sits above the fold at desktop size.
  const box = await page.getByRole("button", { name: "Explain this result" }).boundingBox();
  expect(box).not.toBeNull();
  if (box !== null) {
    expect(box.y + box.height).toBeLessThanOrEqual(900);
  }
});

test("w3_explain_renders_sentences_dropped_count_and_advisory", async ({ page }) => {
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);
  const hero = page.locator('section[aria-label="Combined score"]');
  await expect(page.locator(".score-dial .num")).toHaveText("84");
  const before = await hero.innerText();
  await page.getByRole("button", { name: "Explain this result" }).click();
  const output = page.getByTestId("muse-output");
  await expect(output.getByTestId("explain-sentences")).toContainText(
    "The owner can stop chosen wallets from sending tokens.",
  );
  await expect(output.getByTestId("explain-dropped")).toContainText("2 sentences removed: they cited no evidence.");
  await expect(output.getByTestId("muse-advisory")).toContainText("Advisory. The score above did not change.");
  // Scores, gauges and hero text are byte-identical before and after Explain.
  expect(await hero.innerText()).toBe(before);
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
  // U-3 hero diet: gauge reasons hide at >=1100, so the hostile id is
  // asserted inside "Why this score" where it always renders as text.
  const whyCard = page.locator("section[aria-label='Why this score']");
  await expect(whyCard.getByText("<img src=x onerror=alert(1)>").first()).toBeVisible();
  expect(await whyCard.locator("img").count()).toBe(0);
});

test("design_review_skip_link_keeps_hash", async ({ page }) => {
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);
  await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();
  await page.locator("a.skip-link").focus();
  await page.keyboard.press("Enter");
  expect(new URL(page.url()).hash).toBe(`#/token/${ADDRESS}`);
  await expect(page.locator("#main")).toBeFocused();
});

test("design_review_preview_serves_csp_header", async ({ request }) => {
  const response = await request.get("/");
  const csp = response.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
});
