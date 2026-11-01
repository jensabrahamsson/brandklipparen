// VS-1 code view: Decompiled and Verified source panes with tabs
// below 1100 px and side by side above, evidence linking, empty
// states, full-text copy and the E-5 correspondence highlight.
// Every REST response is route-mocked; no test reaches the network.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { assertLayout } from "./helpers/layoutContract.ts";

const ADDRESS = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const SELECTOR = "0x44337ea1";
const ENTRY_PC = 200;

const LONG_HEX = `0x${"ab".repeat(32)}`;
// A 120-character emit line: long lines wrap with a hanging indent,
// never a horizontal scroll.
const EMIT_LINE = `  emit ${LONG_HEX}(${Array.from({ length: 30 }, (_, index) => `a${index}`).join(", ")});`.slice(0, 120);

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
      pluginId: "dev.brandklipparen.blacklist",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [
        {
          id: "dev.brandklipparen.blacklist:blacklist",
          title: "Blocked wallets",
          payload: { feature: "blacklist" },
          evidence: [{ selector: SELECTOR, offset: ENTRY_PC }],
        },
      ],
    },
    {
      pluginId: "dev.brandklipparen.decompiler",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [
        {
          id: `dev.brandklipparen.decompiler:${SELECTOR}`,
          title: `Decompiled function addBlackList (${SELECTOR})`,
          payload: {
            selector: SELECTOR,
            name: "addBlackList",
            signature: "addBlackList(address)",
            entryPc: ENTRY_PC,
            startPc: ENTRY_PC,
            endPc: 3057,
            annotations: [],
            cause: null,
            unresolvedJumps: 0,
          },
          evidence: [{ selector: SELECTOR, offset: ENTRY_PC }],
        },
      ],
    },
    ...[
      "ownership",
      "pause",
      "mint",
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
    registryEntry("dev.brandklipparen.blacklist", 3),
    registryEntry("dev.brandklipparen.decompiler", 0),
    ...[
      "ownership",
      "pause",
      "mint",
      "transfer-fee",
      "transfer-limits",
      "sell-block",
      "transfer-hooks",
      "proxy-upgrade",
      "capability",
      "clone-match",
      "hard-to-analyze",
    ].map((slug) => registryEntry(`dev.brandklipparen.${slug}`, 1)),
  ],
};

const HEALTH_DISABLED = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  costUnits: "placeholder-cost-unit",
};

function snippetLines(withPcs: boolean): Array<Record<string, unknown>> {
  const texts = [
    "function addBlackList(address a0) {",
    "  require(msg.value == 0);",
    "  require(msg.sender == owner);",
    "  isBlackListed[a0] = true;",
    EMIT_LINE,
    "}",
  ];
  return texts.map((text, index) => ({
    selector: SELECTOR,
    lineNumber: index + 1,
    text,
    ...(withPcs ? { pcs: index === 3 ? [ENTRY_PC] : [] } : {}),
  }));
}

function sourceBody(status: string, withMap: boolean): Record<string, unknown> {
  const content = Array.from({ length: 20 }, (_, index) => `line ${index + 1} of Token.sol`).join("\n");
  return {
    status: "ok",
    apiVersion: "v1",
    codeHash: "0xabc",
    source: {
      status,
      provider: "Sourcify",
      match: "full",
      compiler: "v0.8.20",
      files: [{ path: "contracts/Token.sol", content }],
      functions: [
        {
          selector: SELECTOR,
          signature: "addBlackList(address)",
          name: "addBlackList",
          file: "contracts/Token.sol",
          startLine: 12,
          endLine: 16,
        },
      ],
      ...(withMap ? { pcToLine: { [String(ENTRY_PC)]: { file: "contracts/Token.sol", line: 14 } } } : {}),
    },
  };
}

type Scenario = { withPcs: boolean; sourceStatus: string; withMap: boolean };

async function mockRest(page: Page, scenario: Scenario): Promise<void> {
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
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "ok",
        apiVersion: "v1",
        codeHash: "0xabc",
        snippet: { selector: SELECTOR, entryPc: ENTRY_PC, lines: snippetLines(scenario.withPcs) },
      }),
    });
  });
  await page.route("**/v1/source*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(sourceBody(scenario.sourceStatus, scenario.withMap)),
    });
  });
}

test("code_view_panes_side_by_side_at_1440_and_tabs_below_1100", async ({ page }) => {
  await mockRest(page, { withPcs: true, sourceStatus: "verified", withMap: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#/token/${ADDRESS}/plugins/decompiler/${SELECTOR}`);
  await expect(page.getByRole("tablist")).toHaveCount(0);
  const panes = page.locator(".code-pane");
  await expect(panes).toHaveCount(2);
  const first = await panes.nth(0).boundingBox();
  const second = await panes.nth(1).boundingBox();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(Math.abs(first!.y - second!.y)).toBeLessThanOrEqual(1);

  // At 1099 and below the same content switches to tabs. Without a pc
  // the default is the verified source when it exists.
  await page.setViewportSize({ width: 1099, height: 900 });
  await expect(page.getByRole("tablist", { name: `Code views for addBlackList(address)` })).toBeVisible();
  await expect(page.locator(".code-pane")).toHaveCount(1);
  const decompiled = page.getByRole("tab", { name: "Decompiled" });
  const source = page.getByRole("tab", { name: "Verified source" });
  await expect(source).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Verified means published, not safe.")).toBeVisible();
  await decompiled.click();
  await expect(decompiled).toHaveAttribute("aria-selected", "true");
  await expect(decompiled).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(source).toHaveAttribute("aria-selected", "true");
  await expect(source).toBeFocused();
});

test("code_view_show_in_code_focuses_the_mapped_line", async ({ page }) => {
  await mockRest(page, { withPcs: true, sourceStatus: "verified", withMap: true });
  await page.goto(`/#/token/${ADDRESS}/plugins/blacklist`);
  await page.getByRole("link", { name: "Show in code" }).click();
  await expect(page).toHaveURL(new RegExp(`/plugins/decompiler/${SELECTOR}/decompiled/0xc8`));
  const target = page.locator(".code-line.is-target");
  await expect(target).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.id ?? "")).toContain("-line-4");
});

test("code_view_without_pcs_links_by_function_only", async ({ page }) => {
  await mockRest(page, { withPcs: false, sourceStatus: "verified", withMap: false });
  await page.goto(`/#/token/${ADDRESS}/plugins/decompiler/${SELECTOR}/decompiled/0xc8`);
  await expect(page.getByText("Linked by function. Line-level links need a newer server.").first()).toBeVisible();
  await expect(page.locator(".code-line.is-target")).toHaveCount(0);
});

test("code_view_empty_states_for_none_and_unavailable", async ({ page }) => {
  const scenario: Scenario = { withPcs: true, sourceStatus: "none", withMap: false };
  await mockRest(page, scenario);
  await page.goto(`/#/token/${ADDRESS}/plugins/decompiler/${SELECTOR}/source`);
  await expect(page.getByText("No verified source").first()).toBeVisible();
  await expect(page.getByText("Most new tokens never do.").first()).toBeVisible();

  // The same view with a failed lookup reads differently and offers a retry.
  scenario.sourceStatus = "unavailable";
  await page.reload();
  await expect(page.getByText("Verified source is unavailable").first()).toBeVisible();
  await expect(page.getByText("The decompiled code is unaffected.").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("code_view_copy_writes_the_full_function_text", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __copied: string[] }).__copied = [];
    const writeText = async (text: string): Promise<void> => {
      (window as unknown as { __copied: string[] }).__copied.push(text);
    };
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });
  await mockRest(page, { withPcs: true, sourceStatus: "verified", withMap: true });
  // The default view with verified source is the source pane, so open the
  // decompiled view explicitly: this test copies the decompiled text.
  await page.goto(`/#/token/${ADDRESS}/plugins/decompiler/${SELECTOR}/decompiled`);
  await page.getByRole("button", { name: "Copy decompiled addBlackList(address)" }).click();
  const copied = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied ?? []);
  expect(copied).toHaveLength(1);
  expect(copied[0]).toContain("function addBlackList(address a0) {");
  expect(copied[0]).toContain(LONG_HEX);
  expect(copied[0]).not.toContain("…");
});

test("code_view_correspondence_highlights_mapped_lines", async ({ page }) => {
  const scenario: Scenario = { withPcs: true, sourceStatus: "verified", withMap: true };
  await mockRest(page, scenario);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#/token/${ADDRESS}/plugins/decompiler/${SELECTOR}`);
  const decompiledLine = page.locator(".code-pane").nth(0).locator(".code-line").nth(3);
  await decompiledLine.hover();
  await expect(page.locator(".code-pane").nth(1).locator(".code-line.is-match")).toHaveCount(1);

  // Without a source map, hovering highlights nothing.
  scenario.withMap = false;
  await page.reload();
  await page.locator(".code-pane").nth(0).locator(".code-line").nth(3).hover();
  await expect(page.locator(".code-line.is-match")).toHaveCount(0);
  await expect(page.getByText("Linked by function").first()).toBeVisible();
});

test("code_view_reduced_motion_is_static", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockRest(page, { withPcs: true, sourceStatus: "verified", withMap: true });
  await page.goto(`/#/token/${ADDRESS}/plugins/decompiler/${SELECTOR}/decompiled/0xc8`);
  await expect(page.locator(".code-line.is-target")).toBeVisible();
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
});

test("code_view_layout_contract_with_a_long_emit_line", async ({ page }) => {
  expect(EMIT_LINE.length).toBe(120);
  await mockRest(page, { withPcs: true, sourceStatus: "verified", withMap: true });
  await page.goto(`/#/token/${ADDRESS}/plugins/decompiler/${SELECTOR}`);
  await expect(page.locator("ol.code").first()).toBeVisible();
  await assertLayout(page, { widths: [320, 390, 768, 1440, 1920] });
});
