// Token page heading: the analysis response symbol/name wins, then the
// live-list entry the visitor came from, then the short address. The
// full contract address always rides the heading meta (S-134). DEX and
// human age ride the heading meta when the live entry is known.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const ADDRESS = "0x5ab1e0000000000000000000000000000000c001";
// The header meta shows the EIP-55 form; routes keep the raw string.
const C_ADDRESS = "0x5Ab1E0000000000000000000000000000000c001";

function analyzeFixture(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    signals: [],
    explanation: { kind: "template", templateVersion: "1.0.0", claims: [] },
    cantTell: [],
    ...extra,
  };
}

const HEALTH_DISABLED = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  costUnits: "placeholder-cost-unit",
};

const PLUGINS_EMPTY = { plugins: [] };

const PERSONALIZE_STATUS = {
  status: "ok",
  apiVersion: "v1",
  personalize: { provider: "hosted-open-weights", modelId: "meta-models/muse-spark-open-1026" },
};

function liveEntry(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tokenAddress: ADDRESS,
    symbol: null,
    name: null,
    pairAddress: "0x5ab1e0000000000000000000000000000000c0cc",
    dex: "Uniswap V3",
    feeTier: 3000,
    block: 21600002,
    createdAt: 1700000000000,
    blockTimestampMs: null,
    ageSeconds: 300,
    initialLiquidityWeth: null,
    state: "done",
    ...partial,
  };
}

// Note: hash URLs below build by concatenation, not template
// interpolation: a template literal dropped the slash after "#" in this
// file's transform and landed on the start page, while the identical
// concatenated string navigates to the token page every run.
async function mockToken(
  page: Page,
  analyze: Record<string, unknown>,
  live: Record<string, unknown>[] | null,
): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH_DISABLED) });
  });
  await page.route("**/v1/analyze*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "x-deepening-status": "pending" },
      body: JSON.stringify(analyze),
    });
  });
  await page.route("**/v1/plugins", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PLUGINS_EMPTY) });
  });
  await page.route("**/v1/personalize/status", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PERSONALIZE_STATUS) });
  });
  if (live === null) {
    await page.route("**/v1/live-tokens", async (route) => {
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    });
  } else {
    await page.route("**/v1/live-tokens", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ source: "etherscan", status: "live", updatedAt: 1700000000000, items: live }),
      });
    });
  }
}

test("token_heading_prefers_analysis_symbol_then_live_entry_then_address", async ({ page }) => {
  // Analysis response names the token: the live entry must not override it.
  await mockToken(page, analyzeFixture({ tokenSymbol: "NEW", tokenName: "New Token" }), [
    liveEntry({ symbol: "LIVE", name: "Live Token" }),
  ]);
  await page.goto("/#/token/" + ADDRESS);
  const heading = page.locator("h1").first();
  await expect(heading).toHaveText("NEW");
  await expect(page.getByText("New Token").first()).toBeVisible();
  await expect(page.locator('[data-testid="token-address-full"]').first()).toHaveText(C_ADDRESS);
});

test("token_heading_falls_back_to_live_entry_with_dex_age_meta", async ({ page }) => {
  await mockToken(page, analyzeFixture(), [liveEntry({ symbol: "LIVE" })]);
  await page.goto("/#/token/" + ADDRESS);
  const heading = page.locator("h1").first();
  await expect(heading).toHaveText("LIVE");
  await expect(page.getByText("Uniswap V3 · 0.3% · 5 min ago").first()).toBeVisible();
});

test("token_heading_falls_back_to_short_address", async ({ page }) => {
  await mockToken(page, analyzeFixture(), null);
  await page.goto("/#/token/" + ADDRESS);
  const heading = page.locator("h1").first();
  await expect(heading).toHaveText("0x5ab1…c001");
  await expect(page.locator('[data-testid="token-address-full"]').first()).toHaveText(C_ADDRESS);
});

