// S-131 user-facing copy pass: Simple mode never shows implementation
// strings (REST, v1, contract gap, .env, env var names, "set its key"),
// Stream view and the bot/API blocks are Expert-only, can't-tell entries
// read as plain questions, and recent rows show a symbol or short title
// with labelled bars plus the full address in the row meta (S-134).
import { expect, test, type Page } from "@playwright/test";

const ADDRESS = "0x5ab1e0000000000000000000000000000000f005";
const RECENT_SYMBOL = "0x5ab1e0000000000000000000000000000000a001";
const RECENT_SHORT = "0x5ab1e0000000000000000000000000000000b002";
// Row meta shows the EIP-55 form; session storage keeps the raw strings.
const C_RECENT_SYMBOL = "0x5ab1E0000000000000000000000000000000a001";
const C_RECENT_SHORT = "0x5AB1E0000000000000000000000000000000b002";

// Implementation tokens that must never reach the Simple-mode DOM.
// Widget words ("half-arc", "gauge:") stay out too: help text must say
// what a risk means, never how it is drawn.
const BANNED_SUBSTRINGS = ["REST", "contract gap", ".env", "ETHERSCAN_API_KEY", "set its key", "half-arc", "gauge:"];
const BANNED_V1 = /(?<![A-Za-z0-9_.])v1(?![A-Za-z0-9_.])/;

function bannedIn(html: string): string[] {
  const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/g, "");
  // Test hooks are not rendered copy: explanation keys ride in
  // data-testid values (for example "explain-score:gauge:honeypot"),
  // so strip those attributes before scanning for dev strings.
  const withoutTestIds = withoutScripts.replace(/\sdata-testid="[^"]*"/g, "");
  const hits: string[] = [];
  for (const token of BANNED_SUBSTRINGS) {
    if (withoutTestIds.includes(token)) {
      hits.push(token);
    }
  }
  if (BANNED_V1.test(withoutTestIds)) {
    hits.push("v1");
  }
  return hits;
}

const ANALYZE = {
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
  probabilities: { "rug-pull": 0.6, honeypot: 0.1, "bot-pump": 0.1 },
  score: 62,
  deepening: "ready",
  signals: [
    {
      kind: "capability",
      id: "mintable",
      risk: "rug-pull",
      direction: "raises",
      severity: "high",
      evidence: [{ selector: "0x40c10f19", offset: 100 }],
    },
  ],
  explanation: { kind: "template", templateVersion: "1.0.0", claims: [] },
  cantTell: [
    { question: "liquidity-locks", dataSource: "liquidity-lock-registry" },
    { question: "team-identity", dataSource: "team-disclosure" },
  ],
  pluginResults: [],
};

const HEALTH = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  costUnits: "x",
};

async function mockToken(page: Page): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH) });
  });
  await page.route("**/v1/analyze*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "x-deepening-status": "ready" },
      body: JSON.stringify(ANALYZE),
    });
  });
  await page.route("**/v1/plugins", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plugins: [] }) });
  });
  await page.route("**/v1/personalize/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "ok",
        apiVersion: "v1",
        personalize: { provider: "hosted-open-weights", modelId: "meta-models/muse-spark-open-1026" },
      }),
    });
  });
}

test("s131_simple_mode_copy_has_no_dev_strings", async ({ page }) => {
  // Note: hash URLs build by concatenation (see token-symbol-heading).
  await page.addInitScript(
    ({ symbolEntry, shortEntry }) => {
      sessionStorage.setItem("brandklipparen-recent", JSON.stringify([symbolEntry, shortEntry]));
    },
    {
      symbolEntry: {
        address: RECENT_SYMBOL,
        score: 62,
        word: "High",
        probabilities: { "rug-pull": 0.6, honeypot: 0.1, "bot-pump": 0.1 },
        topSignal: "Owner can pause trading",
        symbol: "SYNTH",
        name: "Synthetic Token",
      },
      shortEntry: {
        address: RECENT_SHORT,
        score: 10,
        word: "Low",
        probabilities: { "rug-pull": 0.1, honeypot: 0.1, "bot-pump": 0.1 },
        topSignal: null,
      },
    },
  );
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH) });
  });
  await page.route("**/v1/live-tokens", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "not-configured", source: "none", updatedAt: 1, items: [] }),
    });
  });
  await page.route("**/v1/plugins", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plugins: [] }) });
  });

  await page.goto("/");
  const startHtml = await page.locator("body").innerHTML();
  expect(bannedIn(startHtml)).toEqual([]);

  // The offline feed notice is plain: no variable names, no file paths.
  const feedNotice = page.locator("section[aria-label='New tokens']");
  await expect(feedNotice).toContainText("unavailable");
  expect(bannedIn(await feedNotice.innerHTML())).toEqual([]);

  // Recent rows show a symbol or short title with labelled bars, and
  // the full address rides in the row meta (S-134).
  const recent = page.locator("section[aria-label='Recently analyzed']");
  await expect(recent).toBeVisible();
  await expect(recent.getByRole("button", { name: /Re-analyze/ }).first()).toContainText("SYNTH");
  await expect(recent.getByRole("button", { name: /Re-analyze/ }).nth(1)).toContainText("0x5ab1…b002");
  await expect(recent).toContainText(C_RECENT_SYMBOL);
  await expect(recent).toContainText(C_RECENT_SHORT);
  await expect(recent.getByRole("button", { name: "Copy contract address" }).first()).toBeVisible();
  for (const label of ["Rug", "Honey", "Bot"]) {
    await expect(recent.getByText(label, { exact: true }).first()).toBeVisible();
  }

  // The token page in Simple mode: questions, plain snippet, no dev text.
  await mockToken(page);
  await page.goto("/#/token/" + ADDRESS);
  await expect(page.locator("details.customize")).toHaveCount(0);
  const cantTell = page.locator("section[aria-label='What bytecode alone cannot tell you']");
  await expect(cantTell).toBeVisible();
  const questions = await cantTell.locator("li > div:first-child").allInnerTexts();
  expect(questions.length).toBeGreaterThan(0);
  for (const question of questions) {
    expect(question.endsWith("?")).toBe(true);
    expect(question).not.toContain("-locks");
    expect(question).not.toContain("-identity");
  }
  await expect(cantTell).toContainText("Needs a liquidity-lock registry");

  // The snippet placeholder is plain in Simple mode. The top signal
  // starts expanded, so the slot reads without a click.
  await expect(page.locator("article")).toContainText("No decompiled snippet is available");
  expect(bannedIn(await page.locator("body").innerHTML())).toEqual([]);

  // Stream view and the bot/API blocks stay Expert-only.
  await expect(page.locator("section[aria-label='Stream view']")).toHaveCount(0);
  await expect(page.getByText("Use this result in your bot")).toHaveCount(0);
  await expect(page.getByText("Calibration report")).toHaveCount(0);
});

test("s131_expert_mode_keeps_relocated_detail", async ({ page }) => {
  await mockToken(page);
  // Note: hash URLs build by concatenation (see token-symbol-heading).
  await page.goto("/#/token/" + ADDRESS);
  await expect(page.locator("details.customize")).toHaveCount(0);
  // The Expert switch lives in the toolbar; one press reveals the
  // relocated detail.
  await page.getByTestId("expert-switch").click();

  // The relocated detail still exists: stream, calibration, bot facts.
  await expect(page.locator("section[aria-label='Stream view']")).toBeVisible();
  await expect(page.getByText("Calibration report")).toBeVisible();
  await expect(page.getByText("Use this result in your bot")).toBeVisible();
  await expect(page.locator("article")).toContainText("contract gap");
});
