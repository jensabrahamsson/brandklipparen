// U-14 acceptance: tablet hero at 768x900 and 1024x900. Band tag above
// y 600, verdict at most 3 lines at 768, and no empty block larger than
// 200x200 px inside the hero. Fixtures mirror the review screenshots:
// USDT-like (3 found + 3 extended) and PEPE-like (2 extended + can't tell).
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const USDT = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbee1";
const PEPE = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbee2";

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
] as const;

function pluginEntry(slug: string): Record<string, unknown> {
  return {
    id: `dev.brandklipparen.${slug}`,
    version: "1.0.0",
    displayName: `${slug} detector`,
    description: `Reports ${slug}.`,
    frontmatter: { tags: ["holder"], audience: ["holder"], severity: { min: "low", max: "high" } },
  };
}

const PLUGINS = { plugins: OWNER_SLUGS.map(pluginEntry) };

const HEALTH_DISABLED = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  costUnits: "placeholder-cost-unit",
};

const LIVE_EMPTY = { source: "none", status: "live", updatedAt: 0, items: [] };

function foundResult(pluginId: string, feature: string): Record<string, unknown> {
  return {
    pluginId,
    pluginVersion: "1.0.0",
    outcome: "ok",
    findings: [
      {
        id: `${pluginId}:found`,
        title: "Found",
        payload: { feature },
        evidence: [{ selector: "0x44337ea1", offset: 1 }],
      },
    ],
  };
}

function extendedResult(pluginId: string, fact: string): Record<string, unknown> {
  return {
    pluginId,
    pluginVersion: "1.0.0",
    outcome: "ok",
    findings: [
      {
        id: `${pluginId}:extended`,
        title: "Extended",
        payload: { fact, proof: "extended" },
        evidence: [{ selector: "0x44337ea1", offset: 1 }],
      },
    ],
  };
}

function emptyResult(pluginId: string): Record<string, unknown> {
  return { pluginId, pluginVersion: "1.0.0", outcome: "ok", findings: [] };
}

function analyzeBody(
  target: string,
  score: number,
  pluginResults: readonly Record<string, unknown>[],
): Record<string, unknown> {
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
    probabilities: { "rug-pull": 0.35, honeypot: 0.25, "bot-pump": 0.22 },
    score,
    signals: [
      {
        kind: "capability",
        id: "owner-pause",
        risk: "rug-pull",
        direction: "raises",
        severity: "medium",
        evidence: [{ selector: "0x8456cb59", offset: 100 }],
      },
    ],
    explanation: {
      kind: "template",
      templateVersion: "1.0.0",
      claims: [
        {
          text: "The owner can stop transfers.",
          signalLinks: ["owner-pause"],
          temporality: { kind: "can-change" },
        },
      ],
    },
    cantTell: [{ question: "Who holds the liquidity?", dataSource: "liquidity locks" }],
    pluginResults,
  };
}

function usdtResults(): Record<string, unknown>[] {
  return [
    foundResult("dev.brandklipparen.blacklist", "blacklist"),
    foundResult("dev.brandklipparen.pause", "pause"),
    foundResult("dev.brandklipparen.ownership", "ownership"),
    extendedResult("dev.brandklipparen.mint", "mint"),
    extendedResult("dev.brandklipparen.transfer-fee", "transfer-fee"),
    extendedResult("dev.brandklipparen.transfer-limits", "transfer-limits"),
    emptyResult("dev.brandklipparen.sell-block"),
    emptyResult("dev.brandklipparen.transfer-hooks"),
    emptyResult("dev.brandklipparen.proxy-upgrade"),
  ];
}

function pepeResults(): Record<string, unknown>[] {
  return [
    extendedResult("dev.brandklipparen.blacklist", "blacklist"),
    extendedResult("dev.brandklipparen.transfer-limits", "transfer-limits"),
    emptyResult("dev.brandklipparen.ownership"),
    emptyResult("dev.brandklipparen.pause"),
    emptyResult("dev.brandklipparen.mint"),
    emptyResult("dev.brandklipparen.transfer-fee"),
    emptyResult("dev.brandklipparen.sell-block"),
    emptyResult("dev.brandklipparen.transfer-hooks"),
    emptyResult("dev.brandklipparen.proxy-upgrade"),
  ];
}

async function mockRest(page: Page, target: string, score: number): Promise<void> {
  const results = target === USDT ? usdtResults() : pepeResults();
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH_DISABLED) });
  });
  await page.route("**/v1/analyze*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "x-deepening-status": "ready" },
      body: JSON.stringify(analyzeBody(target, score, results)),
    });
  });
  await page.route("**/v1/plugins", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PLUGINS) });
  });
  await page.route("**/v1/live-tokens*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(LIVE_EMPTY) });
  });
}

async function openToken(page: Page, target: string, score: number): Promise<void> {
  await mockRest(page, target, score);
  await page.goto("/");
  await page.goto(`/#/token/${target}`);
  const hero = page.locator('section[aria-label="Combined score"]');
  await expect(hero).toBeVisible();
  await expect(hero.locator(".score-dial .bandtag")).toBeVisible();
  await expect(page.getByTestId("powers-strip")).toBeVisible();
}

test("u14_tablet_bandtag_above_600", async ({ page }) => {
  for (const [target, score] of [
    [USDT, 29],
    [PEPE, 19],
  ] as const) {
    for (const viewport of [
      { width: 768, height: 900 },
      { width: 1024, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await openToken(page, target, score);
      const bottom = await page.evaluate(() => {
        const tag = document.querySelector(
          'section[aria-label="Combined score"] .bandtag',
        ) as HTMLElement | null;
        return tag === null ? null : tag.getBoundingClientRect().bottom;
      });
      expect(bottom).not.toBeNull();
      expect(bottom ?? 1000).toBeLessThanOrEqual(600);
    }
  }
});

test("u14_tablet_verdict_at_most_three_lines", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  for (const [target, score] of [
    [USDT, 29],
    [PEPE, 19],
  ] as const) {
    await openToken(page, target, score);
    const lines = await page.evaluate(() => {
      const verdict = document.querySelector(
        'section[aria-label="Combined score"] .risk-meaning',
      ) as HTMLElement | null;
      if (verdict === null) {
        return null;
      }
      const walker = document.createTreeWalker(verdict, NodeFilter.SHOW_TEXT);
      const tops = new Map<number, string[]>();
      const range = document.createRange();
      let node: Node | null = walker.nextNode();
      while (node !== null) {
        if (node.textContent !== null && node.textContent.trim() !== "") {
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()) {
            if (rect.width > 0 && rect.height > 0) {
              const top = Math.round(rect.top);
              const words = tops.get(top) ?? [];
              words.push(`${node.textContent.trim().slice(0, 40)}@${Math.round(rect.width)}`);
              tops.set(top, words);
            }
          }
        }
        node = walker.nextNode();
      }
      // Cluster tops within 12 px: the "?" trigger is a 44 px inline box
      // whose glyph sits a few px below its visual line's text top without
      // starting a new line (a real wrapped line is a full line-height
      // lower). Counting raw tops would mistake the trigger for a line.
      const sorted = [...tops.keys()].sort((a, b) => a - b);
      let lines = 0;
      let lastTop = -100;
      for (const top of sorted) {
        if (top - lastTop > 12) {
          lines += 1;
        }
        lastTop = top;
      }
      return lines;
    });
    expect(lines).not.toBeNull();
    expect(lines ?? 99).toBeLessThanOrEqual(3);
  }
});

test("u14_tablet_no_large_empty_block_in_hero", async ({ page }) => {
  for (const [target, score] of [
    [USDT, 29],
    [PEPE, 19],
  ] as const) {
    for (const viewport of [
      { width: 768, height: 900 },
      { width: 1024, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await openToken(page, target, score);
      const largest = await page.evaluate(() => {
        const hero = document.querySelector(
          'section[aria-label="Combined score"]',
        ) as HTMLElement | null;
        if (hero === null) {
          return null;
        }
        const heroBox = hero.getBoundingClientRect();
        const covered: Array<{ x: number; y: number; width: number; height: number }> = [];
        for (const child of hero.querySelectorAll("*")) {
          const element = child as HTMLElement;
          if (element.offsetParent === null) {
            continue;
          }
          const box = element.getBoundingClientRect();
          if (box.width > 0 && box.height > 0) {
            covered.push({ x: box.x, y: box.y, width: box.width, height: box.height });
          }
        }
        // Coarse grid over the hero: a cell counts as empty when no visible
        // descendant box covers its centre. Largest empty square via DP.
        const cell = 10;
        const cols = Math.max(1, Math.ceil(heroBox.width / cell));
        const rows = Math.max(1, Math.ceil(heroBox.height / cell));
        const empty: boolean[][] = [];
        for (let row = 0; row < rows; row += 1) {
          empty.push([]);
          for (let col = 0; col < cols; col += 1) {
            const x = heroBox.x + col * cell + cell / 2;
            const y = heroBox.y + row * cell + cell / 2;
            let hit = false;
            for (const box of covered) {
              if (x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height) {
                hit = true;
                break;
              }
            }
            empty[row].push(!hit);
          }
        }
        const best: number[][] = empty.map((line) => line.map(() => 0));
        let maxSide = 0;
        for (let row = 0; row < rows; row += 1) {
          for (let col = 0; col < cols; col += 1) {
            if (empty[row][col]) {
              best[row][col] =
                row === 0 || col === 0
                  ? 1
                  : Math.min(best[row - 1][col] ?? 0, best[row][col - 1] ?? 0, best[row - 1][col - 1] ?? 0) +
                    1;
              maxSide = Math.max(maxSide, best[row][col] ?? 0);
            }
          }
        }
        return maxSide * cell;
      });
      expect(largest).not.toBeNull();
      expect(largest ?? 10000).toBeLessThanOrEqual(200);
    }
  }
});
