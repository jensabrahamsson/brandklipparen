// W-5: plugin detail view. Entering the detail focuses the h1 and sets
// the document title; Expert reveals the raw payload; expanding a
// snippet calls /v1/snippet once per selector and renders numbered
// lines; the layout contract holds with the evidence row stacked below
// 640 px. Every REST response is route-mocked.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { assertLayout } from "./helpers/layoutContract.ts";

const ADDRESS = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const ANALYZE_FIXTURE = {
  kind: "assessed",
  target: ADDRESS,
  block: 18000000,
  tokenSymbol: "USDT",
  tokenName: "Tether USD",
  proxy: { kind: "none" },
  codeHash: "0xabc",
  modelVersion: "1.0.1",
  artifactChecksum: "checksum",
  indexVersion: "1.0.0",
  templateVersion: "1.0.0",
  assessedAt: 1700000000000,
  probabilities: { "rug-pull": 0.35, honeypot: 0.25, "bot-pump": 0.22 },
  score: 29,
  signals: [],
  explanation: { kind: "template", templateVersion: "1.0.0", claims: [] },
  cantTell: [],
  pluginResults: [
    {
      pluginId: "dev.brandklipparen.ownership",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [
        {
          id: "dev.brandklipparen.ownership:owner-slot",
          title: "Owner slot compared against the caller",
          payload: { feature: "owner-slot", slot: 0, privilegedFunctions: 11 },
          evidence: [{ selector: "0x8da5cb5b", offset: 64 }],
        },
      ],
    },
    {
      pluginId: "dev.brandklipparen.blacklist",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [
        {
          id: "dev.brandklipparen.blacklist:blacklist",
          title: "Blocked wallets",
          payload: { feature: "blacklist" },
          evidence: [200, 300, 400, 500, 600, 700, 800].map((offset) => ({
            selector: "0x44337ea1",
            offset,
          })),
        },
      ],
    },
    {
      pluginId: "dev.brandklipparen.mint",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [
        {
          id: "dev.brandklipparen.mint:mint-extended",
          title: "Mint, extended",
          payload: { fact: "mint", proof: "extended", capped: false },
          evidence: [
            { selector: "0x40c10f19", offset: 100 },
            { selector: "0x40c10f19", offset: 900 },
          ],
        },
      ],
    },
    {
      pluginId: "dev.brandklipparen.decompiler",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [
        {
          id: "dev.brandklipparen.decompiler:0x44337ea1",
          title: "Decompiled function addBlackList (0x44337ea1)",
          payload: { selector: "0x44337ea1", name: "addBlackList", signature: "addBlackList(address)", cause: null },
          evidence: [{ selector: "0x44337ea1", offset: 200 }],
        },
        {
          id: "dev.brandklipparen.decompiler:0x40c10f19",
          title: "Decompiled function mint (0x40c10f19)",
          payload: { selector: "0x40c10f19", name: "mint", signature: "mint(address,uint256)", cause: null },
          evidence: [{ selector: "0x40c10f19", offset: 100 }],
        },
      ],
    },
    ...[
      "pause",
      "transfer-fee",
      "transfer-limits",
      "sell-block",
      "transfer-hooks",
      "proxy-upgrade",
      "capability",
      "clone-match",
      "hard-to-analyze",
    ].map((slug) => ({
      pluginId: `dev.brandklipparen.${slug}`,
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [],
    })),
  ],
};

function registryEntry(id: string, weight: number): Record<string, unknown> {
  const short = id.split(".").pop() ?? id;
  return {
    id,
    kind: "detector",
    weight,
    version: "1.0.0",
    displayName: `${short} detector`,
    description: `Reports ${short}.`,
    frontmatter: { tags: ["holder"], audience: ["holder"], severity: { min: "low", max: "high" } },
  };
}

const PLUGINS_FIXTURE = {
  plugins: [
    registryEntry("dev.brandklipparen.ownership", 2),
    registryEntry("dev.brandklipparen.blacklist", 3),
    registryEntry("dev.brandklipparen.mint", 0),
    ...["pause", "transfer-fee", "transfer-limits", "sell-block", "transfer-hooks", "proxy-upgrade"].map((slug) =>
      registryEntry(`dev.brandklipparen.${slug}`, 1),
    ),
    ...["capability", "decompiler", "clone-match", "hard-to-analyze"].map((slug) =>
      registryEntry(`dev.brandklipparen.${slug}`, 0),
    ),
  ],
};

const HEALTH_DISABLED = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  costUnits: "placeholder-cost-unit",
};

function snippetBody(selector: string, count: number): Record<string, unknown> {
  return {
    status: "ok",
    apiVersion: "v1",
    codeHash: "0xabc",
    snippet: {
      selector,
      entryPc: 200,
      lines: Array.from({ length: count }, (_, index) => ({
        selector,
        lineNumber: index + 1,
        text: `line ${index + 1} checks the stored mapping`,
      })),
    },
  };
}

async function mockRest(page: Page, snippetCalls: string[]): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH_DISABLED) });
  });
  await page.route("**/v1/analyze*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ANALYZE_FIXTURE) });
  });
  await page.route("**/v1/plugins", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PLUGINS_FIXTURE) });
  });
  await page.route("**/v1/personalize/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ mapping: { disabled: true } }),
    });
  });
  await page.route("**/v1/live-tokens*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ source: "none", status: "live", updatedAt: 0, items: [] }),
    });
  });
  await page.route("**/v1/snippet*", async (route) => {
    snippetCalls.push(route.request().url());
    const url = new URL(route.request().url());
    const selector = url.searchParams.get("selector") ?? "0x44337ea1";
    const count = selector.toLowerCase() === "0x44337ea1" ? 40 : 10;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snippetBody(selector, count)) });
  });
}

test("plugin_detail_focuses_heading_sets_title_and_states_provenance", async ({ page }) => {
  await mockRest(page, []);
  await page.goto(`/#/token/${ADDRESS}/plugins/blacklist`);
  const heading = page.getByRole("heading", { name: "Blacklist", level: 1 });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  expect(await page.title()).toBe("Blacklist · USDT · Brandklipparen");
  await expect(page.locator("p.sr-only")).toContainText("Blacklist details");

  // Scored weight from /v1/plugins: the check reads as in score.
  await expect(page.getByText("In score: yes (model 1.0.1)")).toBeVisible();
  // Owner honesty: no address is proven by the envelope.
  await expect(page.getByText("Owner not identified")).toBeVisible();
  await expect(page.getByText("Applies now")).toBeVisible();
  // Limits and evidence naming from the decompiler readout.
  await expect(page.getByText("not which wallets are listed")).toBeVisible();
  await expect(page.getByText("addBlackList(address)").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Show all 7 places" })).toBeVisible();

  // The zero-weight extended finding reads as not in score.
  await page.goto(`/#/token/${ADDRESS}/plugins/mint`);
  await expect(page.getByRole("heading", { name: "Mint", level: 1 })).toBeFocused();
  await expect(page.getByTestId("detail-not-in-score")).toContainText("Not in score");
  await expect(page.getByText("No: extended analysis")).toBeVisible();
});

test("plugin_detail_expert_shows_raw_payload", async ({ page }) => {
  await mockRest(page, []);
  await page.goto(`/#/token/${ADDRESS}/plugins/blacklist`);
  await expect(page.getByTestId("detail-expert-raw")).toHaveCount(0);
  await page.getByRole("switch", { name: "Expert view" }).click();
  const raw = page.getByTestId("detail-expert-raw");
  await expect(raw).toBeVisible();
  await expect(raw).toContainText("dev.brandklipparen.blacklist:blacklist");
  await expect(raw).toContainText("blacklist");
});

test("plugin_detail_snippet_expands_once_per_selector_with_numbered_lines", async ({ page }) => {
  const snippetCalls: string[] = [];
  await mockRest(page, snippetCalls);
  await page.goto(`/#/token/${ADDRESS}/plugins/blacklist`);
  const expand = page.getByRole("button", { name: "Readable code for addBlackList(address) at 0xc8" });
  await expect(expand).toBeVisible();
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expand.click();
  await expect(expand).toHaveAttribute("aria-expanded", "true");
  const lines = page.locator(".snippet-lines .snippet-line");
  await expect(lines.first()).toBeVisible();
  await expect(page.locator(".snippet-no").first()).toHaveText("1");
  await expect(lines).toHaveCount(30);
  await expect(page.getByRole("button", { name: "Show all 40 lines" })).toBeVisible();

  // Collapse and expand again: the cached selector makes no new request.
  await expand.click();
  await expect(lines).toHaveCount(0);
  await expand.click();
  await expect(lines.first()).toBeVisible();
  const selectorCalls = snippetCalls.filter((url) => url.toLowerCase().includes("selector=0x44337ea1"));
  expect(selectorCalls).toHaveLength(1);

  // The full listing renders every numbered line.
  await page.getByRole("button", { name: "Show all 40 lines" }).click();
  await expect(lines).toHaveCount(40);
  await expect(page.locator(".snippet-no").last()).toHaveText("40");
});

test("plugin_detail_layout_contract_with_stacked_evidence", async ({ page }) => {
  await mockRest(page, []);
  await page.goto(`/#/token/${ADDRESS}/plugins/blacklist`);
  await expect(page.getByRole("heading", { name: "Blacklist", level: 1 })).toBeVisible();
  await assertLayout(page);

  // Below 640 px the evidence row stacks: the copy control sits below
  // the function name instead of beside it.
  await page.setViewportSize({ width: 390, height: 844 });
  const name = page.locator(".evidence-name").first();
  const copy = page.locator(".evidence-top .copy-btn").first();
  const nameBox = await name.boundingBox();
  const copyBox = await copy.boundingBox();
  expect(nameBox).not.toBeNull();
  expect(copyBox).not.toBeNull();
  expect(copyBox!.y).toBeGreaterThanOrEqual(nameBox!.y + nameBox!.height);
});
