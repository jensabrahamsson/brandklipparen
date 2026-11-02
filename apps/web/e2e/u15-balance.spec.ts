// U-15 desktop balance probe (R3 D-13, D-18): real viewport
// measurements at 1440 and 1920 for USDT-like (signals present) and
// PEPE-like (no signals) fixtures, plus the detail evidence column at
// >=1100. Behavior only: bounding boxes with synthetic fixtures.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const USDT_ADDRESS = "0xdeaDbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const PEPE_ADDRESS = "0xfeeDbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function registryEntry(id: string, displayName: string): Record<string, unknown> {
  return { id, version: "1.0.0", displayName, description: `Reports ${id}.` };
}

const OWNER_SLUGS = [
  "ownership",
  "pause",
  "blacklist",
  "mint",
  "transfer-fee",
  "transfer-limits",
  "sell-block",
  "transfer-hooks",
  "proxy-upgrade",
];

const PLUGINS_FIXTURE = {
  plugins: [
    ...OWNER_SLUGS.map((slug) => registryEntry(`dev.brandklipparen.${slug}`, `${slug} detector`)),
    registryEntry("dev.brandklipparen.capability", "Capability detector"),
    registryEntry("dev.brandklipparen.decompiler", "Decompiler detector"),
    registryEntry("dev.brandklipparen.clone-match", "Clone-match detector"),
    registryEntry("dev.brandklipparen.hard-to-analyze", "Hard-to-read detector"),
  ],
};

const HEALTH_DISABLED = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  costUnits: "placeholder-cost-unit",
};

function finding(id: string, title: string, payload: Record<string, unknown>, offsets: number[]) {
  return {
    id,
    title,
    payload,
    evidence: offsets.map((offset) => ({ selector: "0x44337ea1", offset })),
  };
}

function okEmpty(pluginId: string) {
  return { pluginId, pluginVersion: "1.0.0", outcome: "ok", findings: [] };
}

const USDT_RESULTS = [
  {
    pluginId: "dev.brandklipparen.ownership",
    pluginVersion: "1.0.0",
    outcome: "ok",
    findings: [
      finding("dev.brandklipparen.ownership:owner", "Owner account", { feature: "ownership", privilegedFunctions: 11 }, [10, 20]),
    ],
  },
  {
    pluginId: "dev.brandklipparen.pause",
    pluginVersion: "1.0.0",
    outcome: "ok",
    findings: [finding("dev.brandklipparen.pause:pause", "Pause switch", { feature: "pause", mode: "pause" }, [30, 40])],
  },
  {
    pluginId: "dev.brandklipparen.blacklist",
    pluginVersion: "1.0.0",
    outcome: "ok",
    findings: [finding("dev.brandklipparen.blacklist:block", "Blocked wallets", { feature: "blacklist" }, [50, 60])],
  },
  {
    pluginId: "dev.brandklipparen.mint",
    pluginVersion: "1.0.0",
    outcome: "ok",
    findings: [finding("dev.brandklipparen.mint:mint", "Mint, extended", { fact: "mint", proof: "extended", capped: true }, [70])],
  },
  okEmpty("dev.brandklipparen.transfer-fee"),
  okEmpty("dev.brandklipparen.transfer-limits"),
  okEmpty("dev.brandklipparen.sell-block"),
  okEmpty("dev.brandklipparen.transfer-hooks"),
  okEmpty("dev.brandklipparen.proxy-upgrade"),
  {
    pluginId: "dev.brandklipparen.capability",
    pluginVersion: "1.0.0",
    outcome: "ok",
    findings: [finding("dev.brandklipparen.capability:call", "Calls out", { capability: "call" }, [26])],
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
        evidence: [{ selector: "0x44337ea1", offset: 50 }],
      },
    ],
  },
  okEmpty("dev.brandklipparen.clone-match"),
  okEmpty("dev.brandklipparen.hard-to-analyze"),
];

const PEPE_RESULTS = [
  okEmpty("dev.brandklipparen.ownership"),
  okEmpty("dev.brandklipparen.pause"),
  {
    pluginId: "dev.brandklipparen.blacklist",
    pluginVersion: "1.0.0",
    outcome: "ok",
    findings: [finding("dev.brandklipparen.blacklist:block", "Blocked wallets", { fact: "blacklist", proof: "extended" }, [50])],
  },
  okEmpty("dev.brandklipparen.mint"),
  okEmpty("dev.brandklipparen.transfer-fee"),
  {
    pluginId: "dev.brandklipparen.transfer-limits",
    pluginVersion: "1.0.0",
    outcome: "ok",
    findings: [
      finding("dev.brandklipparen.transfer-limits:limits", "Limits, extended", { fact: "limits", proof: "extended" }, [90]),
    ],
  },
  okEmpty("dev.brandklipparen.sell-block"),
  okEmpty("dev.brandklipparen.transfer-hooks"),
  okEmpty("dev.brandklipparen.proxy-upgrade"),
  {
    pluginId: "dev.brandklipparen.capability",
    pluginVersion: "1.0.0",
    outcome: "ok",
    findings: [finding("dev.brandklipparen.capability:call", "Calls out", { capability: "call" }, [26])],
  },
  {
    pluginId: "dev.brandklipparen.decompiler",
    pluginVersion: "1.0.0",
    outcome: "ok",
    findings: [
      {
        id: "dev.brandklipparen.decompiler:0x70a08231",
        title: "Decompiled function balanceOf (0x70a08231)",
        payload: { selector: "0x70a08231", name: "balanceOf", cause: null },
        evidence: [{ selector: "0x70a08231", offset: 26 }],
      },
    ],
  },
  okEmpty("dev.brandklipparen.clone-match"),
  okEmpty("dev.brandklipparen.hard-to-analyze"),
];

function analyzeFixture(target: string, kind: "usdt" | "pepe") {
  const scored = kind === "usdt";
  return {
    kind: "assessed",
    target,
    block: 18000000,
    proxy: { kind: "none" },
    codeHash: "0xabc",
    modelVersion: "0.1.0",
    artifactChecksum: "checksum",
    indexVersion: "1.0.0",
    templateVersion: "1.0.0",
    assessedAt: 1700000000000,
    probabilities: { "rug-pull": 0.35, honeypot: 0.25, "bot-pump": 0.2 },
    score: scored ? 29 : 12,
    signals: scored
      ? [
          {
            kind: "capability",
            id: "owner-blacklist",
            risk: "honeypot",
            direction: "raises",
            severity: "high",
            evidence: [{ selector: "0x44337ea1", offset: 50 }],
          },
          {
            kind: "capability",
            id: "owner-pause",
            risk: "rug-pull",
            direction: "raises",
            severity: "medium",
            evidence: [{ selector: "0x44337ea1", offset: 30 }],
          },
        ]
      : [],
    explanation: { kind: "template", templateVersion: "1.0.0", claims: [] },
    cantTell: [],
    pluginResults: kind === "usdt" ? USDT_RESULTS : PEPE_RESULTS,
  };
}

async function mockAll(page: Page): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH_DISABLED) });
  });
  await page.route("**/v1/analyze*", async (route) => {
    const url = new URL(route.request().url());
    const target = (url.searchParams.get("address") ?? "").toLowerCase();
    const kind = target === USDT_ADDRESS.toLowerCase() ? "usdt" : "pepe";
    const addr = kind === "usdt" ? USDT_ADDRESS : PEPE_ADDRESS;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(analyzeFixture(addr, kind)),
    });
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
      body: JSON.stringify({ status: "ok", apiVersion: "v1", codeHash: "0xabc", snippet: { selector: "0x44337ea1", entryPc: 50, lines: [] } }),
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
        source: { status: "none", provider: "Sourcify", match: null, compiler: null, files: [], functions: [] },
      }),
    });
  });
  await page.route("**/v1/proof*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", apiVersion: "v1", codeHash: "0xabc", proofs: [] }),
    });
  });
  await page.route("**/v1/onchain*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok" }) });
  });
}

async function tokenGridVoid(page: Page, target: string, width: number): Promise<{
  gridClass: string;
  columns: number;
  rowH: number;
  mainInnerH: number;
  factsInnerH: number;
  voidMain: number;
  voidFacts: number;
}> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/#/token/${target}`);
  await expect(page.locator(".token-grid")).toBeVisible();
  await page.waitForTimeout(1200);
  return page.evaluate(() => {
    const grid = document.querySelector(".token-grid") as HTMLElement | null;
    const main = document.querySelector('[data-section="explanation"]') as HTMLElement | null;
    const facts = document.querySelector(".token-facts") as HTMLElement | null;
    const gridClass = grid?.className ?? "";
    const cols = getComputedStyle(grid as Element)
      .getPropertyValue("grid-template-columns")
      .split(" ")
      .filter((part) => part.trim().length > 0).length;
    const mainRect = main?.getBoundingClientRect();
    const factsRect = facts?.getBoundingClientRect();
    // Inner content: the explanation card vs the facts card. Stretched
    // grid items share the row height, so the honest void is row height
    // minus each column's content height.
    const mainInner =
      (main?.querySelector(".card") as HTMLElement | null)?.getBoundingClientRect().height ?? mainRect?.height ?? 0;
    const factsInner =
      (facts?.querySelector(".contract-facts") as HTMLElement | null)?.getBoundingClientRect().height ?? factsRect?.height ?? 0;
    const rowH = Math.max(mainRect?.height ?? 0, factsRect?.height ?? 0);
    return {
      gridClass,
      columns: cols,
      rowH,
      mainInnerH: mainInner,
      factsInnerH: factsInner,
      voidMain: rowH - mainInner,
      voidFacts: rowH - factsInner,
    };
  });
}

for (const width of [1440, 1920]) {
  test(`u15_token_grid_void_${width}`, async ({ page }) => {
    await mockAll(page);
    const usdt = await tokenGridVoid(page, USDT_ADDRESS, width);
    console.log(
      `U15 GRID usdt ${width} ${usdt.gridClass} cols=${usdt.columns} row=${Math.round(usdt.rowH)} mainInner=${Math.round(usdt.mainInnerH)} factsInner=${Math.round(usdt.factsInnerH)} voidMain=${Math.round(usdt.voidMain)} voidFacts=${Math.round(usdt.voidFacts)}`,
    );
    const pepe = await tokenGridVoid(page, PEPE_ADDRESS, width);
    console.log(
      `U15 GRID pepe ${width} ${pepe.gridClass} cols=${pepe.columns} row=${Math.round(pepe.rowH)} mainInner=${Math.round(pepe.mainInnerH)} factsInner=${Math.round(pepe.factsInnerH)} voidMain=${Math.round(pepe.voidMain)} voidFacts=${Math.round(pepe.voidFacts)}`,
    );
    // Flat (single-column) layouts have no beside-content void by construction.
    expect(pepe.columns).toBe(1);
    expect(usdt.columns).toBe(1);
  });
}

test("u15_detail_evidence_column", async ({ page }) => {
  await mockAll(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#/token/${USDT_ADDRESS}/plugins/blacklist`);
  await expect(page.getByRole("heading", { name: "Blacklist", level: 1 })).toBeVisible();
  await page.waitForTimeout(800);
  const measured = await page.evaluate(() => {
    const evidence = document.querySelector(".detail-evidence") as HTMLElement | null;
    const name = document.querySelector(".evidence-name") as HTMLElement | null;
    const copyBtn = document.querySelector(".evidence-top .copy-btn") as HTMLElement | null;
    const evidenceW = evidence?.getBoundingClientRect().width ?? 0;
    const nameRect = name?.getBoundingClientRect();
    const copyRect = copyBtn?.getBoundingClientRect();
    const gap = nameRect && copyRect ? copyRect.left - nameRect.right : Number.POSITIVE_INFINITY;
    return { evidenceW, gap };
  });
  console.log(`U15 DETAIL evidenceW=${Math.round(measured.evidenceW)} gap=${Math.round(measured.gap)}`);
  expect(measured.evidenceW <= 760 || measured.gap <= 160).toBe(true);
});
