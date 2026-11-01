// C-29 code-view render cost: a 500-line function stays responsive.
// A hover sweep across 50 lines completes in under 2 s with no long
// task over 100 ms, and the explain typing run reaches the end with
// no console errors. Every REST response is route-mocked; no test
// reaches the network.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const ADDRESS = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const SELECTOR = "0x44337ea1";
const ENTRY_PC = 200;

function snippetTexts(count: number): string[] {
  const texts = ["function wideFunction(address a0) {"];
  for (let index = 1; index < count - 1; index += 1) {
    texts.push(`  uint256 v${index} = v${index - 1} + ${index};`);
  }
  texts.push("}");
  return texts;
}

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
      pluginId: "dev.brandklipparen.decompiler",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [
        {
          id: `dev.brandklipparen.decompiler:${SELECTOR}`,
          title: `Decompiled function wideFunction (${SELECTOR})`,
          payload: {
            selector: SELECTOR,
            name: "wideFunction",
            signature: "wideFunction(address)",
            entryPc: ENTRY_PC,
            startPc: ENTRY_PC,
            endPc: 9057,
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
      "blacklist",
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
    registryEntry("dev.brandklipparen.decompiler", 0),
    ...[
      "ownership",
      "pause",
      "mint",
      "blacklist",
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

const HEALTH = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  explainCode: { provider: "meta-model-api", modelId: "muse-spark-1.3" },
  costUnits: "placeholder-cost-unit",
};

async function mockRest(page: Page, lineCount: number): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH) });
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
        snippet: {
          selector: SELECTOR,
          entryPc: ENTRY_PC,
          lines: snippetTexts(lineCount).map((text, index) => ({
            selector: SELECTOR,
            lineNumber: index + 1,
            text,
            pcs: index === 3 ? [ENTRY_PC] : [],
          })),
        },
      }),
    });
  });
  await page.route("**/v1/source*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "ok",
        apiVersion: "v1",
        codeHash: "0xabc",
        source: { status: "none", provider: null, match: null, compiler: null, files: [], functions: [] },
      }),
    });
  });
  await page.route("**/v1/explain-code", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "ok",
        apiVersion: "v1",
        codeHash: "0xabc",
        selector: SELECTOR,
        view: "decompiled",
        explainCode: {
          kind: "ok",
          summary: [
            {
              text: "Only the owner can call this function, and no one else can.",
              cites: [{ kind: "line", selector: SELECTOR, view: "decompiled", line: 3 }],
            },
          ],
          notes: [{ lines: [4, 4], text: "The owner check happens here.", cites: [] }],
          droppedClaims: 0,
          provider: "meta-model-api",
          modelId: "muse-spark-1.3",
        },
      }),
    });
  });
}

test("code_view_perf_hover_sweep_stays_fast_with_no_long_tasks", async ({ page }) => {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${String(error)}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      problems.push(`console: ${message.text()}`);
    }
  });
  await mockRest(page, 500);
  await page.goto(`/#/token/${ADDRESS}/plugins/decompiler/${SELECTOR}/decompiled`);
  await expect(page.locator(".code-line")).toHaveCount(30);

  await page.evaluate(() => {
    const store = window as unknown as { __longtasks?: number[] };
    store.__longtasks = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        store.__longtasks?.push(entry.duration);
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
  });

  await page.getByRole("button", { name: "Show all 500 lines" }).click();
  await expect(page.locator(".code-line")).toHaveCount(500);

  const sweepMs = await page.evaluate(async () => {
    const rows = Array.from(document.querySelectorAll(".code-line")).slice(0, 50);
    const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const start = performance.now();
    for (const row of rows) {
      row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      await frame();
      row.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    }
    await frame();
    await frame();
    return performance.now() - start;
  });
  expect(sweepMs).toBeLessThan(2000);

  const longtasks = await page.evaluate(() => {
    const store = window as unknown as { __longtasks?: number[] };
    return store.__longtasks ?? [];
  });
  for (const duration of longtasks) {
    expect(duration).toBeLessThan(100);
  }
  expect(problems).toEqual([]);
});

test("code_view_perf_typing_reaches_the_end_with_no_console_errors", async ({ page }) => {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${String(error)}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      problems.push(`console: ${message.text()}`);
    }
  });
  await mockRest(page, 6);
  await page.goto(`/#/token/${ADDRESS}/plugins/decompiler/${SELECTOR}/decompiled`);
  await page.getByTestId(`explain-code-${SELECTOR}`).click();
  await expect(page.getByText("Muse explanation ready: 1 summary, 1 note.")).toHaveCount(1);
  await expect(page.locator(".muse-summary-list .cursor")).toHaveCount(0, { timeout: 10000 });
  await expect(page.locator(".muse-note")).toHaveCount(1);
  await expect(page.getByText("The owner check happens here.").first()).toBeAttached();
  expect(problems).toEqual([]);
});
