// Playwright for the adaptive UI (S-061, S-066, S-067, S-070): mode
// toggle, priorities persistence, severity floor and the experimental AI
// personalize toggle with its deterministic fallback. Every REST response
// is route-mocked; no test reaches the network.
import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

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

const PERSONALIZE_STATUS = {
  status: "ok",
  apiVersion: "v1",
  personalize: { provider: "hosted-open-weights", modelId: "meta-models/muse-spark-open-1026" },
};

function validSpecBody(): Record<string, unknown> {
  return {
    specVersion: 1,
    pluginRanking: ["dev.brandklipparen.clone-match", "dev.brandklipparen.capability"],
    placements: [
      { sectionId: "signals", emphasis: "high" },
      { sectionId: "summary", emphasis: "normal" },
      { sectionId: "score", emphasis: "normal" },
    ],
  };
}

function personalizeOk(): Record<string, unknown> {
  return {
    status: "ok",
    apiVersion: "v1",
    personalize: {
      kind: "ok",
      provider: "hosted-open-weights",
      modelId: "meta-models/muse-spark-open-1026",
      promptVersion: "1.0.0",
      cache: "miss",
      spec: validSpecBody(),
    },
  };
}

function personalizeInvalid(): Record<string, unknown> {
  const spec = validSpecBody();
  spec["placements"] = [{ sectionId: "secret-panel", emphasis: "high" }];
  return {
    status: "ok",
    apiVersion: "v1",
    personalize: {
      kind: "ok",
      provider: "hosted-open-weights",
      modelId: "meta-models/muse-spark-open-1026",
      promptVersion: "1.0.0",
      cache: "miss",
      spec,
    },
  };
}

async function mockRest(
  page: Page,
  personalizeScenario: "ok" | "invalid" | null = null,
  counter: { posts: number; lastBody: string } | null = null,
): Promise<void> {
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
  await page.route("**/v1/plugins", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PLUGINS_FIXTURE) });
  });
  await page.route("**/v1/personalize/status", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PERSONALIZE_STATUS) });
  });
  await page.route("**/v1/personalize", async (route: Route, request) => {
    if (request.method() === "POST" && counter !== null) {
      counter.posts += 1;
      counter.lastBody = request.postData() ?? "";
    }
    if (personalizeScenario === null) {
      await route.abort("failed");
      return;
    }
    const body = personalizeScenario === "ok" ? personalizeOk() : personalizeInvalid();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

async function openCustomize(page: Page): Promise<void> {
  const customize = page.locator("details.customize");
  await expect(customize).toBeVisible();
  if (!(await customize.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await customize.locator("summary").click();
  }
}

test("k034_mode_toggle_persists_across_reload", async ({ page }) => {
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);
  await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();
  await openCustomize(page);
  await page.getByRole("radio", { name: "Expert" }).check();
  await expect(page.getByTestId("expert-detail")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();
  await openCustomize(page);
  await expect(page.getByRole("radio", { name: "Expert" })).toBeChecked();
  await expect(page.getByTestId("expert-detail")).toBeVisible();
  await page.getByRole("radio", { name: "Simple" }).check();
  await expect(page.getByTestId("expert-detail")).toHaveCount(0);
});

test("k034_expert_mode_reveals_bytecode_selectors_raw_data", async ({ page }) => {
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);
  await openCustomize(page);
  await expect(page.getByTestId("expert-detail")).toHaveCount(0);
  const simpleScore = await page.locator('section[aria-label="Combined score"]').innerText();
  await page.getByRole("radio", { name: "Expert" }).check();
  await expect(page.getByTestId("expert-detail")).toContainText(ADDRESS);
  await expect(page.getByTestId("expert-detail")).toContainText("0xabc");
  await expect(page.getByTestId("expert-selectors")).toContainText("0x44337ea1");
  await expect(page.getByTestId("expert-selectors")).toContainText("PC 0xa3f");
  await expect(page.getByTestId("raw-plugin-payloads")).toContainText('"capability":"call"');
  const expertScore = await page.locator('section[aria-label="Combined score"]').innerText();
  // The score numbers never move between modes; Expert only adds the
  // calibration detail (S-131).
  for (const line of ["84 High", "Rug 62%", "Honey 91%", "Bot 34%"]) {
    expect(simpleScore).toContain(line);
    expect(expertScore).toContain(line);
  }
  expect(simpleScore).not.toContain("Calibration report");
  expect(expertScore).toContain("Calibration report");
});

test("k035_priorities_persist_across_reload_and_clear_removes_them", async ({ page }) => {
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);
  await openCustomize(page);
  await page.getByTestId("priorities-field").fill("Can the owner stop me selling?");
  await expect(page.getByTestId("personalized-notice")).toBeVisible();
  await page.reload();
  await openCustomize(page);
  await expect(page.getByTestId("priorities-field")).toHaveValue("Can the owner stop me selling?");
  await expect(page.getByTestId("personalized-notice")).toBeVisible();
  await page.getByTestId("priorities-clear").click();
  await expect(page.getByTestId("priorities-field")).toHaveValue("");
  await expect(page.getByTestId("personalized-notice")).toHaveCount(0);
  const stored = await page.evaluate(() => localStorage.getItem("brandklipparen-user-priorities:v1"));
  expect(stored).toBe(null);
});

test("k519_critical_finding_visible_with_unrelated_priorities", async ({ page }) => {
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);
  await openCustomize(page);
  await page.getByTestId("priorities-field").fill("What a nice day for a walk");
  await expect(page.getByTestId("personalized-notice")).toHaveCount(0);
  await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();
  await expect(page.locator('section[aria-label="Signals"]')).toContainText("Owner can block transfers");
  await expect(page.locator('section[aria-label="Plugins"]')).toContainText("Capability detector");
  await expect(page.locator('section[aria-label="Plugins"]')).toContainText("Clone-match detector");
});

test("deterministic match orders and labels the plugin cards", async ({ page }) => {
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);
  await openCustomize(page);
  await page.getByTestId("priorities-field").fill("Can the owner stop me selling?");
  await expect(page.getByTestId("personalized-notice")).toContainText("Ordered by what matters to you.");
  await expect(page.getByTestId("matched-dev.brandklipparen.clone-match")).toContainText("honeypot");
});

test("k519_invalid_or_missing_personalize_spec_falls_back_to_deterministic_baseline", async ({ page }) => {
  await mockRest(page, "invalid");
  await page.goto(`/#/token/${ADDRESS}`);
  await openCustomize(page);
  await page.getByTestId("priorities-field").fill("Can the owner stop me selling?");
  await page.getByTestId("ai-personalize-toggle").check();
  await page.getByTestId("ai-personalize-apply").click();
  await expect(page.getByTestId("ai-personalize-result")).toContainText("AI layout unavailable");
  await expect(page.getByTestId("ai-emphasis-signals")).toHaveCount(0);
  const sections = await page.locator("div.token-grid div[data-section]").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-section")),
  );
  // S-133: the risk breakdown ("score") lives in the verdict hero above the
  // tabs, so the overview grid starts with the next planned section; the
  // hero still carries the gauges and the combined-score ring.
  expect(sections[0]).toBe("signals");
  expect(sections[1]).toBe("plugin-findings");
  await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();
  await expect(page.locator('section[aria-label="Combined score"] .gauges-hero')).toBeVisible();
});

test("k519_ai_personalize_toggle_off_by_default_and_labelled", async ({ page }) => {
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);
  await openCustomize(page);
  await expect(page.getByTestId("ai-personalize-toggle")).not.toBeChecked();
  await expect(page.getByTestId("ai-personalize-label")).toContainText("hosted-open-weights");
  await expect(page.getByTestId("ai-personalize-label")).toContainText("meta-models/muse-spark-open-1026");
  await expect(page.getByTestId("ai-personalize-preface")).toHaveCount(0);
});

test("k519_ai_personalize_toggle_states_priorities_before_first_call", async ({ page }) => {
  const counter = { posts: 0, lastBody: "" };
  await mockRest(page, "ok", counter);
  await page.goto(`/#/token/${ADDRESS}`);
  await openCustomize(page);
  await page.getByTestId("priorities-field").fill("Can the owner stop me selling?");
  await page.getByTestId("ai-personalize-toggle").check();
  await expect(page.getByTestId("ai-personalize-preface")).toContainText("Sends your priorities text");
  await expect(page.getByTestId("ai-personalize-preface")).toContainText("Nothing else is sent");
  expect(counter.posts).toBe(0);
  await page.getByTestId("ai-personalize-apply").click();
  await expect(page.getByTestId("ai-personalize-result")).toContainText("AI order applied");
  expect(counter.posts).toBe(1);
  expect(counter.lastBody).toContain("Can the owner stop me selling?");
  await expect(page.getByTestId("ai-emphasis-signals")).toContainText("Highlighted for you");
  const sections = await page.locator("div.token-grid div[data-section]").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-section")),
  );
  expect(sections[0]).toBe("summary");
});
