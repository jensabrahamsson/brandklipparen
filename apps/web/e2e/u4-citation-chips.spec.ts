// U-4 Muse answers read like evidence (round-3 review D-5). Every
// coverage id shape becomes a lamp chip with a short plain label that
// navigates to the plugin detail or the can't-tell panel; unknown ids
// render nothing. The empty fallback reads the verdict, never a dangling
// colon, and no developer copy appears inside the console. Every REST
// response is route-mocked; no test reaches the network.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { assertLayout } from "./helpers/layoutContract.ts";

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
  probabilities: { "rug-pull": 0.35, honeypot: 0.25, "bot-pump": 0.22 },
  score: 29,
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
    claims: [],
  },
  cantTell: [{ question: "liquidity-locks", dataSource: "liquidity-lock-registry" }],
  pluginResults: [
    {
      pluginId: "dev.brandklipparen.blacklist",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [
        {
          id: "dev.brandklipparen.blacklist:blacklist",
          title: "Blocked wallets",
          payload: { feature: "blacklist" },
          evidence: [{ selector: "0x44337ea1", offset: 2623 }],
        },
      ],
    },
    {
      pluginId: "dev.brandklipparen.pause",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [],
    },
    {
      pluginId: "dev.brandklipparen.decompiler",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [],
    },
  ],
};

function registryEntry(id: string): Record<string, unknown> {
  const short = id.split(".").pop() ?? id;
  return {
    id,
    kind: "detector",
    weight: 3,
    version: "1.0.0",
    displayName: `${short} detector`,
    description: `Reports ${short}.`,
    frontmatter: { tags: ["holder"], audience: ["holder"], severity: { min: "low", max: "high" } },
  };
}

const PLUGINS_FIXTURE = {
  plugins: [
    registryEntry("dev.brandklipparen.ownership"),
    registryEntry("dev.brandklipparen.pause"),
    registryEntry("dev.brandklipparen.blacklist"),
    registryEntry("dev.brandklipparen.mint"),
    registryEntry("dev.brandklipparen.decompiler"),
    registryEntry("dev.brandklipparen.capability"),
  ],
};

const HEALTH = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  explain: { provider: "test-adapter", modelId: "test-explain-1" },
  chat: { provider: "test-adapter", modelId: "test-explain-1" },
  investigation: { provider: "test-adapter", modelId: "test-investigate-1" },
  rug: { disabled: true },
  onchain: { disabled: true },
  costUnits: "placeholder-cost-unit",
};

const EXPLAIN_CHIPS = {
  status: "ok",
  apiVersion: "v1",
  codeHash: "0xabc",
  explain: {
    kind: "ok",
    narrative: [
      "The owner can stop chosen wallets from sending tokens. [E:signal:owner-blacklist]",
      "Pause found nothing to flag. [E:check:dev.brandklipparen.pause:not-found]",
      "Whether the liquidity is locked stays open. [E:cant-tell:liquidity-locks]",
      "The board below names every check we ran. [E:analysis:summary]",
    ],
    droppedClaims: 1,
    provider: "test-adapter",
    modelId: "test-explain-1",
  },
};

const EXPLAIN_EMPTY = {
  status: "ok",
  apiVersion: "v1",
  codeHash: "0xabc",
  explain: {
    kind: "ok",
    narrative: [],
    droppedClaims: 0,
    provider: "test-adapter",
    modelId: "test-explain-1",
  },
};

const CHAT_CHIPS = {
  status: "ok",
  apiVersion: "v1",
  codeHash: "0xabc",
  chat: {
    kind: "ok",
    answers: [
      "Pause found nothing to flag. [E:check:dev.brandklipparen.pause:not-found]",
      "Whether the liquidity is locked stays open. [E:cant-tell:liquidity-locks]",
    ],
    droppedClaims: 1,
    provider: "test-adapter",
    modelId: "test-explain-1",
  },
};

const BANNED_CHIP = /^(signal|check|cant-tell|analysis):|^0x[0-9a-f]{6,}/i;
const BANNED_CONSOLE = [
  "frozen",
  "deterministic",
  "unsupported",
  "citation checking",
  "not configured on this server",
];

async function mockBase(page: Page, explain: unknown): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH) });
  });
  await page.route("**/v1/analyze*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ANALYZE_FIXTURE) });
  });
  await page.route("**/v1/plugins", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PLUGINS_FIXTURE) });
  });
  await page.route("**/v1/explain*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(explain) });
  });
}

async function expectCleanChips(page: Page): Promise<string[]> {
  const chips = page.getByTestId("muse-output").locator("a.muse-chip, button.muse-chip");
  const texts = await chips.allInnerTexts();
  expect(texts.length).toBeGreaterThan(0);
  for (const text of texts) {
    expect(text.trim()).not.toMatch(BANNED_CHIP);
  }
  return texts.map((text) => text.trim());
}

async function expectCleanConsole(page: Page): Promise<void> {
  const consoleCard = page.locator('[data-testid="muse-console"]');
  for (const banned of BANNED_CONSOLE) {
    await expect(consoleCard).not.toContainText(banned);
  }
}

test("u4_explain_coverage_chips_read_as_evidence", async ({ page }) => {
  await mockBase(page, EXPLAIN_CHIPS);
  await page.route("**/v1/chat", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CHAT_CHIPS) });
  });
  await page.goto(`/#/token/${ADDRESS}`);
  await expect(page.getByRole("img", { name: /Combined score 29 of 100, Low risk/ })).toBeVisible();
  await page.getByRole("button", { name: "Explain this result" }).click();
  const output = page.getByTestId("muse-output");
  await expect(output.getByText("Blacklist").first()).toBeVisible();

  const texts = await expectCleanChips(page);
  expect(texts).toContain("Blacklist");
  expect(texts).toContain("Pause · not found");
  expect(texts).toContain("Liquidity lock · can't tell");
  expect(texts).toContain("What we checked");
  await expect(output.getByTestId("explain-dropped")).toContainText(
    "1 sentence removed: it cited no evidence.",
  );
  await expectCleanConsole(page);

  // The signal chip moves focus to the Why this score row.
  await output.getByRole("button", { name: /Evidence: Blacklist/ }).click();
  await expect(page.locator("#signal-0-capability-honeypot summary")).toBeFocused();

  await assertLayout(page, { widths: [390, 1440] });
});

test("u4_coverage_chip_navigates_to_the_plugin_detail", async ({ page }) => {
  await mockBase(page, EXPLAIN_CHIPS);
  await page.goto(`/#/token/${ADDRESS}`);
  await page.getByRole("button", { name: "Explain this result" }).click();
  const output = page.getByTestId("muse-output");
  await expect(output.getByText("Pause · not found")).toBeVisible();
  await output.getByRole("link", { name: /Evidence: Pause/ }).click();
  await expect(page).toHaveURL(new RegExp(`#/token/${ADDRESS}/plugins/pause`));
  await expect(page.getByRole("heading", { name: "Pause" })).toBeVisible();
});

test("u4_coverage_chip_navigates_to_cant_tell", async ({ page }) => {
  await mockBase(page, EXPLAIN_CHIPS);
  await page.goto(`/#/token/${ADDRESS}`);
  await page.getByRole("button", { name: "Explain this result" }).click();
  const output = page.getByTestId("muse-output");
  await expect(output.getByText("Liquidity lock · can't tell")).toBeVisible();
  await output.getByRole("button", { name: /Liquidity lock/ }).click();
  const panel = page.locator("#cant-tell");
  await expect(panel).toBeFocused();
  await expect(panel).toContainText("Is the liquidity locked?");
});

test("u4_coverage_chip_navigates_to_the_plugin_board", async ({ page }) => {
  await mockBase(page, EXPLAIN_CHIPS);
  await page.goto(`/#/token/${ADDRESS}`);
  await page.getByRole("button", { name: "Explain this result" }).click();
  const output = page.getByTestId("muse-output");
  await expect(output.getByText("What we checked")).toBeVisible();
  await output.getByRole("link", { name: /What we checked/ }).click();
  await expect(page).toHaveURL(new RegExp(`#/token/${ADDRESS}/plugins$`));
  await expect(page.getByRole("heading", { name: "What we checked" })).toBeVisible();
});

test("u4_empty_narrative_with_empty_claims_renders_the_verdict_fallback", async ({ page }) => {
  await mockBase(page, EXPLAIN_EMPTY);
  await page.goto(`/#/token/${ADDRESS}`);
  await page.getByRole("button", { name: "Explain this result" }).click();
  const output = page.getByTestId("muse-output");
  await expect(output.getByTestId("explain-fallback")).toContainText(
    "Low risk. The owner controls blacklist.",
  );
  const lines = (await output.innerText()).split("\n").map((line) => line.trim()).filter(Boolean);
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.filter((line) => line.endsWith(":"))).toEqual([]);
  await expect(output.getByTestId("explain-dropped")).toHaveCount(0);
  await expectCleanConsole(page);
});

test("u4_chat_answers_render_coverage_chips", async ({ page }) => {
  await mockBase(page, EXPLAIN_EMPTY);
  await page.route("**/v1/chat", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CHAT_CHIPS) });
  });
  await page.goto(`/#/token/${ADDRESS}`);
  await page.getByLabel("Ask about this token").fill("Can the owner stop me selling?");
  await page.getByTestId("ask-submit").click();
  const output = page.getByTestId("muse-output");
  await expect(output.getByText("Pause · not found")).toBeVisible();
  const texts = await expectCleanChips(page);
  expect(texts).toContain("Pause · not found");
  expect(texts).toContain("Liquidity lock · can't tell");
  await expectCleanConsole(page);
});

test("u4_investigate_starts_the_run_with_no_second_button", async ({ page }) => {
  await mockBase(page, EXPLAIN_EMPTY);
  const report = {
    status: "done",
    report: {
      narrative: "The pause check found nothing. [E:check:dev.brandklipparen.pause:not-found]",
      droppedClaims: 0,
      steps: [
        {
          step: 1,
          toolId: "evidence.list",
          rationale: "List the collected evidence first.",
          evidenceIds: ["signal:owner-blacklist"],
          elapsedMs: 0,
        },
      ],
      collectedEvidenceIds: ["signal:owner-blacklist"],
    },
    limits: { maxSteps: 8, maxTokens: 8000, deadlineMs: 60000, toolTimeoutMs: 5000 },
  };
  await page.route("**/v1/investigate/events*", async (route) => {
    await route.abort("failed");
  });
  await page.route("**/v1/investigate*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...ANALYZE_FIXTURE, investigation: report, investigationProvider: "test-adapter", investigationModel: "test-investigate-1" }),
    });
  });
  await page.goto(`/#/token/${ADDRESS}`);
  await expect(page.getByRole("button", { name: "Investigate", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Investigate", exact: true }).click();
  const output = page.getByTestId("muse-output");
  await expect(output.getByText("List the collected evidence first.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Request investigation" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Investigate", exact: true })).toHaveCount(1);
  const texts = await expectCleanChips(page);
  expect(texts).toContain("Blacklist");
  expect(texts).toContain("Pause · not found");
  await expectCleanConsole(page);
});
