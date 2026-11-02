// Playwright for the token page toolbar and Ask field (UI v2 §1.4,
// W-8): the Expert switch persists across reload and reveals raw data,
// the Ask field persists under the priorities key (K-035), typing
// highlights matching tiles with zero network, and one Ask press sends
// one /v1/chat request. Every REST response is route-mocked; no test
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
  modelVersion: "1.0.0",
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
  pluginResults: [
    {
      pluginId: "dev.brandklipparen.capability",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [
        {
          id: "dev.brandklipparen.capability:call",
          title: "Contract can forward calls",
          payload: { capability: "call" },
          evidence: [{ selector: "0x12345678", offset: 26 }],
        },
      ],
    },
    {
      pluginId: "dev.brandklipparen.clone-match",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [
        {
          id: "dev.brandklipparen.clone-match:drain-template",
          title: "Bytecode matches a known trap template",
          payload: { similarity: 0.9, group: "drain-template", priorCount: 3 },
          evidence: [{ selector: "0x44337ea1", offset: 2623 }],
        },
      ],
    },
  ],
};

const PLUGINS_FIXTURE = {
  plugins: [
    {
      id: "dev.brandklipparen.capability",
      version: "1.0.0",
      displayName: "Capability detector",
      description: "Reports structural bytecode capabilities.",
      outputSchema: {
        type: "array",
        items: {
          type: "object",
          properties: { payload: { type: "object", properties: { capability: { type: "string" } } } },
        },
      },
      frontmatter: {
        tags: ["owner-powers", "upgradeability"],
        audience: ["holder", "auditor"],
        severity: { min: "low", max: "high" },
      },
    },
    {
      id: "dev.brandklipparen.clone-match",
      version: "1.0.0",
      displayName: "Clone-match detector",
      description: "Matches known trap templates.",
      outputSchema: { type: "array" },
      frontmatter: {
        tags: ["honeypot"],
        audience: ["holder", "trader"],
        severity: { min: "medium", max: "high" },
      },
    },
  ],
};

const HEALTH_DISABLED = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  costUnits: "placeholder-cost-unit",
};

const CHAT_OK = {
  status: "ok",
  apiVersion: "v1",
  codeHash: "0xabc",
  chat: {
    kind: "ok",
    answers: ["The owner can stop chosen wallets from sending tokens."],
    droppedClaims: 0,
    provider: "test-adapter",
    modelId: "muse-spark-1.3",
  },
};

async function mockRest(page: Page, chatPosts: { count: number } | null = null): Promise<void> {
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
  await page.route("**/v1/chat", async (route) => {
    if (chatPosts !== null) {
      chatPosts.count += 1;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CHAT_OK) });
  });
}

test("k034_expert_switch_persists_across_reload", async ({ page }) => {
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);
  await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();
  // The Customize view is gone: no details.customize anywhere.
  await expect(page.locator("details.customize")).toHaveCount(0);
  const expert = page.getByRole("switch", { name: "Expert view" });
  // The toolbar owns the switch on the main view; the detail view owns
  // its own copy under a separate test id.
  await expect(page.getByTestId("expert-switch")).toBeVisible();
  await expect(page.getByTestId("expert-detail-switch")).toHaveCount(0);
  await expect(page.getByTestId("expert-detail")).toHaveCount(0);
  await expert.click();
  await expect(expert).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("expert-detail")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Expert view" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("expert-detail")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("brandklipparen-ui-mode"))).toBe("expert");
  await page.getByRole("switch", { name: "Expert view" }).click();
  await expect(page.getByTestId("expert-detail")).toHaveCount(0);
});

test("k034_expert_mode_reveals_bytecode_selectors_raw_data", async ({ page }) => {
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);
  await expect(page.getByTestId("expert-detail")).toHaveCount(0);
  const scoreSection = page.locator('section[aria-label="Combined score"]');
  // W-9 removed the hero's static score repeat, so the dial (1.7 s
  // count-up) and gauges (1.5 s) own these strings: wait for the
  // animation to settle before the one-shot read. The dial is the
  // slowest, so wait for its exact final number: a bare "84" substring
  // also matches the honeypot gauge passing through "84%" mid-count,
  // and "91%" lands while the dial is still below its final 84.
  await expect(scoreSection.getByText("84", { exact: true })).toBeVisible();
  await expect(scoreSection).toContainText("91%");
  const simpleScore = await scoreSection.innerText();
  await page.getByRole("switch", { name: "Expert view" }).click();
  await expect(page.getByTestId("expert-detail")).toContainText("0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF");
  await expect(page.getByTestId("expert-detail")).toContainText("0xabc");
  await expect(page.getByTestId("expert-selectors")).toContainText("0x44337ea1");
  await expect(page.getByTestId("expert-selectors")).toContainText("PC 0xa3f");
  await expect(page.getByTestId("raw-plugin-payloads")).toContainText('"capability":"call"');
  await expect(scoreSection.getByText("84", { exact: true })).toBeVisible();
  await expect(scoreSection).toContainText("91%");
  const expertScore = await scoreSection.innerText();
  // The score numbers never move between modes; Expert only adds the
  // calibration detail (S-131). W-9: the hero no longer repeats the
  // score line, so the dial owns "84"/"HIGH" and the gauges own the
  // percents and risk names.
  for (const line of ["84", "HIGH", "Rug pull", "62%", "Honeypot", "91%", "Bot pump", "34%"]) {
    expect(simpleScore).toContain(line);
    expect(expertScore).toContain(line);
  }
  expect(simpleScore).not.toContain("Calibration report");
  expect(expertScore).toContain("Calibration report");
});

test("k035_ask_field_persists_across_reload_and_clear_removes_it", async ({ page }) => {
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);
  const ask = page.getByLabel("Ask about this token");
  await ask.fill("Can the owner stop me selling?");
  await expect(page.getByTestId("matched-dev.brandklipparen.clone-match")).toContainText("Matches your question");
  await page.reload();
  await expect(page.getByLabel("Ask about this token")).toHaveValue("Can the owner stop me selling?");
  await expect(page.getByTestId("matched-dev.brandklipparen.clone-match")).toContainText("Matches your question");
  await page.getByTestId("ask-clear").click();
  await expect(page.getByLabel("Ask about this token")).toHaveValue("");
  await expect(page.getByTestId("matched-dev.brandklipparen.clone-match")).toHaveCount(0);
  const stored = await page.evaluate(() => localStorage.getItem("brandklipparen-user-priorities:v1"));
  expect(stored).toBe(null);
});

test("k035_typing_highlights_tiles_without_network", async ({ page }) => {
  await mockRest(page);
  const urls: string[] = [];
  page.on("request", (request) => {
    urls.push(request.url());
  });
  await page.goto(`/#/token/${ADDRESS}`);
  await expect(page.getByTestId("plugin-board")).toBeVisible();
  const settled = urls.length;
  expect(settled).toBeGreaterThan(0);
  await page.getByLabel("Ask about this token").fill("Can the owner stop me selling?");
  await expect(page.getByTestId("matched-dev.brandklipparen.clone-match")).toContainText("Matches your question");
  await expect(page.getByTestId("matched-dev.brandklipparen.capability")).toContainText("Matches your question");
  await page.waitForTimeout(400);
  // Typing only re-runs the local matcher: no new request leaves the page.
  expect(urls.length).toBe(settled);
  expect(urls.some((url) => url.includes("/v1/chat"))).toBe(false);
});

test("k519_critical_finding_visible_with_unrelated_question", async ({ page }) => {
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);
  await page.getByLabel("Ask about this token").fill("What a nice day for a walk");
  await expect(page.getByTestId("matched-dev.brandklipparen.clone-match")).toHaveCount(0);
  await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();
  await expect(page.locator('section[aria-label="Why this score"]')).toContainText("Owner can block transfers");
  await expect(page.getByTestId("plugin-tile-capability")).toBeVisible();
  await expect(page.getByTestId("plugin-tile-clone-match")).toBeVisible();
  // The section order never moves for a question (Option A): the overview
  // grid keeps the deterministic plan.
  const sections = await page.locator("div.token-grid div[data-section]").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-section")),
  );
  expect(sections[0]).toBe("explanation");
  expect(sections[1]).toBe("plugin-findings");
});

test("k519_ask_sends_one_chat_request_per_press", async ({ page }) => {
  const chatPosts = { count: 0 };
  await mockRest(page, chatPosts);
  await page.goto(`/#/token/${ADDRESS}`);
  const ask = page.getByLabel("Ask about this token");
  await ask.fill("Can the owner stop me selling?");
  await page.getByTestId("ask-submit").click();
  await expect(page.getByTestId("muse-output")).toContainText(
    "The owner can stop chosen wallets from sending tokens.",
  );
  await expect.poll(() => chatPosts.count).toBe(1);
  await ask.fill("Can fees change?");
  await page.getByTestId("ask-submit").click();
  await expect.poll(() => chatPosts.count).toBe(2);
  await expect(page.getByTestId("muse-output")).toContainText(
    "The owner can stop chosen wallets from sending tokens.",
  );
  await expect(page.getByTestId("muse-advisory")).toContainText("AI explanation · doesn't change the score");
});

test("k519_empty_ask_sends_nothing", async ({ page }) => {
  const chatPosts = { count: 0 };
  await mockRest(page, chatPosts);
  await page.goto(`/#/token/${ADDRESS}`);
  const submit = page.getByTestId("ask-submit");
  await expect(submit).not.toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("ask-hint")).toHaveCount(0);
  // Enter in the empty field submits the form, which focuses the field
  // and shows the error hint instead of sending.
  await page.getByLabel("Ask about this token").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("ask-hint")).toContainText("Type a question first, then press Ask.");
  await page.waitForTimeout(300);
  expect(chatPosts.count).toBe(0);
  await expect(page.getByTestId("muse-output")).toHaveCount(0);
});
