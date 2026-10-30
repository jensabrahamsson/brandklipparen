// Brief 39: separators never start or end a visual line.
// Meta rows that list items with " · " (token header meta, analysis hero
// meta lines, live card meta and pair rows, recent rows) wrap at 390 px,
// so every wrapped visual line must start and end with a real item
// glyph, never "·". Separators drawn by the item itself are clipped when
// the item starts a new line; separators inside one unbreakable item stay
// interior. Desktop keeps the same separators visible between items.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const TOKEN_A = "0x5ab1e0000000000000000000000000000000a001";
const PAIR_A = "0x5ab1e0000000000000000000000000000000a0aa";
const TOKEN_B = "0x5ab1e0000000000000000000000000000000b002";
const PAIR_B = "0x5ab1e0000000000000000000000000000000b0bb";

const HEALTH = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  costUnits: "x",
};

const ANALYZE = {
  kind: "assessed",
  target: TOKEN_A,
  tokenSymbol: "AUR",
  tokenName: "Aurora Meridian Vault Token Extended",
  block: 18000000,
  proxy: { kind: "none" },
  codeHash: "0xabc",
  modelVersion: "0.1.0",
  artifactChecksum: "checksum",
  indexVersion: "1.0.0",
  templateVersion: "1.0.0",
  assessedAt: 1700000000000,
  probabilities: { "rug-pull": 0.1, honeypot: 0.1, "bot-pump": 0.1 },
  score: 12,
  deepening: "ready",
  signals: [],
  explanation: { kind: "template", templateVersion: "1.0.0", claims: [] },
  cantTell: [],
  pluginResults: [],
};

function liveEntry(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    symbol: null,
    name: null,
    block: 21600002,
    createdAt: 1700000000000,
    blockTimestampMs: 1700000000000 - 11000000 * 1000,
    ageSeconds: 11000000,
    initialLiquidityWeth: "12345.6789",
    state: "done",
    riskBand: "Low",
    score: 12,
    ...partial,
  };
}

function liveItems(): Record<string, unknown>[] {
  return [
    liveEntry({
      tokenAddress: TOKEN_A,
      symbol: "AURORA",
      name: "Aurora Meridian Vault Token Extended",
      pairAddress: PAIR_A,
      dex: "Uniswap V3",
      feeTier: 10000,
    }),
    liveEntry({
      tokenAddress: TOKEN_B,
      symbol: "BOREALIS",
      pairAddress: PAIR_B,
      dex: "Uniswap V2",
      block: 21600001,
      ageSeconds: 7200,
      initialLiquidityWeth: null,
    }),
  ];
}

async function mockRest(page: Page): Promise<void> {
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
      body: JSON.stringify({ mapping: { disabled: true } }),
    });
  });
  await page.route("**/v1/live-tokens", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ source: "etherscan", status: "live", updatedAt: 1700000000000, items: liveItems() }),
    });
  });
}

async function seedRecent(page: Page): Promise<void> {
  await page.addInitScript(
    ({ tokenA }) => {
      sessionStorage.setItem(
        "brandklipparen-recent",
        JSON.stringify([
          {
            address: tokenA,
            score: 12,
            word: "Low",
            probabilities: { "rug-pull": 0.1, honeypot: 0.1, "bot-pump": 0.1 },
            topSignal: "Owner can pause trading after a long quiet period",
            symbol: "AURORA",
            name: "Aurora Meridian Vault Token Extended",
          },
        ]),
      );
    },
    { tokenA: TOKEN_A },
  );
}

type RowLine = { first: string; last: string; count: number };
type RowAnalysis = { lines: RowLine[]; wraps: boolean };

// Visible glyph boxes per visual line: every rendered character of the
// row's own text (screen-reader-only announcements excluded), grouped by
// vertical position. Separators drawn with ::before are not DOM text, so
// a second helper below checks their clipped/painted state directly.
async function analyzeRow(page: Page, selector: string, index: number): Promise<RowAnalysis> {
  return page.evaluate(
    ({ sel, idx }) => {
      const rows = Array.from(document.querySelectorAll(sel));
      const row = rows[idx] as HTMLElement | undefined;
      if (!row) {
        return { lines: [], wraps: false };
      }
      const glyphs: { ch: string; top: number; left: number; right: number }[] = [];
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) {
            return NodeFilter.FILTER_REJECT;
          }
          if (parent.closest(".sr-only")) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const range = document.createRange();
      let node: Node | null;
      while ((node = walker.nextNode()) !== null) {
        const text = node.textContent ?? "";
        for (let i = 0; i < text.length; i += 1) {
          const ch = text[i] as string;
          if (ch.trim() === "") {
            continue;
          }
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const rects = range.getClientRects();
          for (const rect of Array.from(rects)) {
            if (rect.width === 0 && rect.height === 0) {
              continue;
            }
            glyphs.push({ ch, top: rect.top, left: rect.left, right: rect.right });
          }
        }
      }
      const buckets = new Map<number, typeof glyphs>();
      for (const glyph of glyphs) {
        let key: number | null = null;
        for (const existing of buckets.keys()) {
          if (Math.abs(existing - glyph.top) <= 2) {
            key = existing;
            break;
          }
        }
        if (key === null) {
          key = glyph.top;
          buckets.set(key, []);
        }
        (buckets.get(key) as typeof glyphs).push(glyph);
      }
      const ordered = Array.from(buckets.entries()).sort((a, b) => a[0] - b[0]);
      const lines: RowLine[] = ordered.map(([, items]) => {
        const byLeft = [...items].sort((a, b) => a.left - b.left);
        const byRight = [...items].sort((a, b) => b.right - a.right);
        return { first: byLeft[0]?.ch ?? "", last: byRight[0]?.ch ?? "", count: items.length };
      });
      return { lines, wraps: lines.length > 1 };
    },
    { sel: selector, idx: index },
  );
}

type SepStatus = {
  found: boolean;
  startsLine: boolean;
  beforeContent: string;
  hitIsItem: boolean;
};

// Per item separator state: the ::before content plus clipping math. A
// separator hanging left of a line-starting item sits outside the row box
// and is removed by the row's inline-start clip, so a probe there must
// not hit the item; a mid-line separator is painted and hit-tests to it.
async function sepStatus(page: Page, selector: string, rowIndex: number, itemIndex: number): Promise<SepStatus> {
  return page.evaluate(
    ({ sel, rIdx, iIdx }) => {
      const rows = Array.from(document.querySelectorAll(sel));
      const row = rows[rIdx] as HTMLElement | undefined;
      const item = row?.querySelectorAll(":scope > .meta-item")?.[iIdx] as HTMLElement | undefined;
      if (!row || !item) {
        return { found: false, startsLine: false, beforeContent: "", hitIsItem: false };
      }
      // Hit testing only sees the viewport, so bring the item on screen.
      item.scrollIntoView({ block: "center" });
      const rowRect = row.getBoundingClientRect();
      const padLeft = Number.parseFloat(getComputedStyle(row).paddingLeft || "0") || 0;
      const contentLeft = rowRect.left + padLeft;
      const first = item.getClientRects()[0];
      if (!first) {
        return { found: true, startsLine: false, beforeContent: "", hitIsItem: false };
      }
      const fontSize = Number.parseFloat(getComputedStyle(item).fontSize || "12") || 12;
      const startsLine = Math.abs(first.left - contentLeft) <= 2;
      const beforeContent = getComputedStyle(item, "::before").content;
      // Live cards stretch their heading link over the whole card, so a
      // single topmost hit is the link overlay: read the full stack and
      // look for the item itself. A clipped separator leaves the item out
      // of the stack; a painted one keeps it in.
      const stack = document.elementsFromPoint(first.left - 0.7 * fontSize, first.top + first.height / 2);
      const hitIsItem = stack.some((hit) => hit === item || item.contains(hit));
      return { found: true, startsLine, beforeContent, hitIsItem };
    },
    { sel: selector, rIdx: rowIndex, iIdx: itemIndex },
  );
}

async function itemCount(page: Page, selector: string, rowIndex: number): Promise<number> {
  return page.evaluate(
    ({ sel, rIdx }) => {
      const rows = Array.from(document.querySelectorAll(sel));
      const row = rows[rIdx] as HTMLElement | undefined;
      return row?.querySelectorAll(":scope > .meta-item").length ?? 0;
    },
    { sel: selector, rIdx: rowIndex },
  );
}

async function expectNoStrandedSeparators(page: Page, selector: string, count: number): Promise<boolean> {
  let wrapped = false;
  for (let i = 0; i < count; i += 1) {
    const analysis = await analyzeRow(page, selector, i);
    expect(analysis.lines.length).toBeGreaterThan(0);
    for (const line of analysis.lines) {
      expect(line.first, `${selector}#${i} line starts with separator`).not.toBe("·");
      expect(line.last, `${selector}#${i} line ends with separator`).not.toBe("·");
    }
    // Every non-first item draws its own separator; a line-starting item
    // must have it clipped, a mid-line item must show it painted.
    const items = await itemCount(page, selector, i);
    for (let k = 1; k < items; k += 1) {
      const sep = await sepStatus(page, selector, i, k);
      expect(sep.found).toBe(true);
      expect(sep.beforeContent, `${selector}#${i} item ${k} separator`).toContain("·");
      if (sep.startsLine) {
        expect(sep.hitIsItem, `${selector}#${i} item ${k} separator clipped at line start`).toBe(false);
      } else {
        expect(sep.hitIsItem, `${selector}#${i} item ${k} separator painted mid-line`).toBe(true);
      }
    }
    wrapped = wrapped || analysis.wraps;
  }
  return wrapped;
}

test("brief39_mobile_meta_rows_never_strand_separators", async ({ page }) => {
  await mockRest(page);
  await seedRecent(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/#/");
  await expect(page.getByText("2 new tokens")).toBeVisible();
  const liveSubCount = await page.locator(".live-cards .live-sub").count();
  expect(liveSubCount).toBeGreaterThanOrEqual(2);
  const pairFullCount = await page.locator(".live-cards .live-pair-full").count();
  expect(pairFullCount).toBeGreaterThanOrEqual(2);
  let wrapped = await expectNoStrandedSeparators(page, ".live-cards .live-sub", liveSubCount);
  wrapped = (await expectNoStrandedSeparators(page, ".live-cards .live-pair-full", pairFullCount)) || wrapped;

  // Recent rows carry no separators today; the wrap holds no stranded
  // glyph either way.
  const recentCount = await page.locator(".recent-meta").count();
  expect(recentCount).toBeGreaterThanOrEqual(1);
  wrapped = (await expectNoStrandedSeparators(page, ".recent-meta", recentCount)) || wrapped;

  // Note: hash URLs build by concatenation (see token-symbol-heading).
  await page.goto("/#/token/" + TOKEN_A);
  await expect(page.locator('[data-testid="token-address-full"]').first()).toBeVisible();
  wrapped = (await expectNoStrandedSeparators(page, ".token-meta", 1)) || wrapped;
  wrapped =
    (await expectNoStrandedSeparators(page, '[data-testid="analysis-complete-meta"]', 1)) || wrapped;
  wrapped = (await expectNoStrandedSeparators(page, '[data-testid="hero-score-meta"]', 1)) || wrapped;

  // The fixtures are long enough that at least one row really wraps, so
  // the assertions above exercise real line breaks.
  expect(wrapped).toBe(true);

  // No horizontal scroll at 390 px.
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBe(390);

  // The 44 px copy tap target and its focus ring survive the inline-start
  // clip: the button keeps its full height inside the viewport.
  const headerCopy = page.locator('[data-testid="copy-contract-address"]').first();
  await headerCopy.focus();
  const copyBox = await headerCopy.evaluate((element) => {
    const rect = (element as HTMLElement).getBoundingClientRect();
    const row = (element as HTMLElement).closest(".token-meta") as HTMLElement | null;
    return {
      height: rect.height,
      left: rect.left,
      right: rect.right,
      overflowY: row ? getComputedStyle(row).overflowY : "unknown",
    };
  });
  expect(copyBox.height).toBeGreaterThanOrEqual(43);
  expect(copyBox.left).toBeGreaterThanOrEqual(0);
  expect(copyBox.right).toBeLessThanOrEqual(390);
  expect(copyBox.overflowY).toBe("visible");
});

test("brief39_desktop_separators_stay_visible_between_items", async ({ page }) => {
  await mockRest(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Note: hash URLs build by concatenation (see token-symbol-heading).
  await page.goto("/#/token/" + TOKEN_A);
  await expect(page.locator('[data-testid="token-address-full"]').first()).toBeVisible();
  for (const selector of [".token-meta", '[data-testid="analysis-complete-meta"]', '[data-testid="hero-score-meta"]']) {
    const items = await itemCount(page, selector, 0);
    expect(items).toBeGreaterThanOrEqual(2);
    let painted = 0;
    for (let k = 1; k < items; k += 1) {
      const sep = await sepStatus(page, selector, 0, k);
      expect(sep.found).toBe(true);
      expect(sep.beforeContent, `${selector} item ${k} separator`).toContain("·");
      if (!sep.startsLine) {
        expect(sep.hitIsItem, `${selector} item ${k} separator painted`).toBe(true);
        painted += 1;
      }
    }
    // Desktop rows keep separators visible between items.
    expect(painted).toBeGreaterThanOrEqual(1);
  }

  // Accessible names are unchanged: copy controls keep their labels.
  await expect(page.locator('[data-testid="copy-contract-address"]').first()).toHaveAttribute(
    "aria-label",
    "Copy contract address",
  );

  await page.goto("/#/");
  await expect(page.getByText("2 new tokens")).toBeVisible();
  // The live table keeps its real inline separators on desktop.
  await expect(page.locator(".live-table").getByText("Uniswap V3 · 1%").first()).toBeVisible();
});
