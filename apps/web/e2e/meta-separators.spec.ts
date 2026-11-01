// Brief 40: separators never start or end a visual line, found generically.
// Every separator row is discovered by walking the DOM for visible "·"
// glyphs (own text nodes or ::before content), grouped by the nearest
// block or flex row ancestor within the page scopes below. For each row
// every visual line must start and end with a real item glyph, never
// "·". A line-starting item must have its ::before separator clipped
// (not painted); a mid-line item must show it painted. Desktop keeps
// the same separators visible between items.
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

type ScanResult = {
  failures: string[];
  rowCount: number;
  wrapped: boolean;
  labels: string[];
};

// Generic separator scan inside the given scope roots. No row class
// names are listed here: any visible element whose own direct text or
// ::before content holds "·" is grouped by its nearest block or flex
// row ancestor, then checked line by line.
async function genericScan(page: Page, scopes: string[]): Promise<ScanResult> {
  return page.evaluate((scopeSelectors: string[]) => {
    const failures: string[] = [];
    const rows = new Map<Element, Element[]>();
    const scopeRoots: Element[] = [];
    for (const sel of scopeSelectors) {
      for (const root of Array.from(document.querySelectorAll(sel))) {
        scopeRoots.push(root);
      }
    }
    const inScope = (el: Element): boolean => scopeRoots.some((root) => root === el || root.contains(el));
    const isRowLike = (cand: Element): boolean => {
      const display = getComputedStyle(cand).display;
      if (display === "none") {
        return false;
      }
      if (display.includes("flex") || display.includes("grid")) {
        return true;
      }
      return display === "block" || display === "list-item";
    };
    const visible = (el: Element): boolean => {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    for (const root of scopeRoots) {
      const candidates = [root, ...Array.from(root.querySelectorAll("*"))];
      for (const el of candidates) {
        if (!(el instanceof HTMLElement)) {
          continue;
        }
        const tag = el.tagName.toLowerCase();
        if (tag === "script" || tag === "style") {
          continue;
        }
        if (el.closest(".sr-only") !== null) {
          continue;
        }
        if (!visible(el)) {
          continue;
        }
        let ownDot = false;
        for (const node of Array.from(el.childNodes)) {
          if (node.nodeType === 3 && (node.textContent ?? "").includes("·")) {
            ownDot = true;
            break;
          }
        }
        let beforeDot = false;
        try {
          const content = getComputedStyle(el, "::before").content;
          if (typeof content === "string" && content.includes("·")) {
            beforeDot = true;
          }
        } catch {
          beforeDot = false;
        }
        if (!ownDot && !beforeDot) {
          continue;
        }
        let start: Element | null = el;
        const elDisplay = getComputedStyle(el).display;
        if (elDisplay.startsWith("inline") || beforeDot) {
          start = el.parentElement;
        }
        let row: Element | null = null;
        let cand: Element | null = start;
        while (cand !== null && cand !== document.body) {
          if (isRowLike(cand) && inScope(cand)) {
            row = cand;
            break;
          }
          cand = cand.parentElement;
        }
        if (row === null) {
          continue;
        }
        if (!visible(row)) {
          continue;
        }
        const list = rows.get(row);
        if (list === undefined) {
          rows.set(row, [el]);
        } else {
          list.push(el);
        }
      }
    }
    const labelOf = (row: Element): string => {
      const cls = (row.getAttribute("class") ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 3).join(".");
      return `${row.tagName.toLowerCase()}${cls === "" ? "" : "." + cls}`;
    };
    const glyphLines = (row: Element): { first: string; last: string; firstLeft: number }[] => {
      const glyphs: { ch: string; top: number; left: number; right: number }[] = [];
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (parent === null) {
            return NodeFilter.FILTER_REJECT;
          }
          if (parent.closest(".sr-only") !== null) {
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
      return Array.from(buckets.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, items]) => {
          const byLeft = [...items].sort((a, b) => a.left - b.left);
          const byRight = [...items].sort((a, b) => b.right - a.right);
          return {
            first: byLeft[0]?.ch ?? "",
            last: byRight[0]?.ch ?? "",
            firstLeft: byLeft[0]?.left ?? 0,
          };
        });
    };
    const labels: string[] = [];
    let wrapped = false;
    for (const [row, seps] of rows) {
      const label = labelOf(row);
      labels.push(label);
      const lines = glyphLines(row);
      if (lines.length > 1) {
        wrapped = true;
      }
      for (const line of lines) {
        if (line.first === "·") {
          failures.push(`${label} visual line starts with separator`);
        }
        if (line.last === "·") {
          failures.push(`${label} visual line ends with separator`);
        }
      }
      void seps;
    }
    // Separator paint state: a line-starting item must have its ::before
    // clipped away, a mid-line item must show it painted. Probe several
    // points across the gap so the check does not depend on the exact
    // dot width or offset.
    for (const [row] of rows) {
      const label = labelOf(row);
      const items = Array.from(row.querySelectorAll(":scope > .meta-item")).filter(
        (item): item is HTMLElement => item instanceof HTMLElement,
      );
      for (let k = 1; k < items.length; k += 1) {
        const item = items[k] as HTMLElement;
        let before = "";
        try {
          before = getComputedStyle(item, "::before").content ?? "";
        } catch {
          before = "";
        }
        if (!before.includes("·")) {
          continue;
        }
        item.scrollIntoView({ block: "center" });
        const rowRect = row.getBoundingClientRect();
        const padLeft = Number.parseFloat(getComputedStyle(row).paddingLeft || "0") || 0;
        const contentLeft = rowRect.left + padLeft;
        const first = item.getClientRects()[0];
        if (!first) {
          failures.push(`${label} item ${k} has no rect`);
          continue;
        }
        const fontSize = Number.parseFloat(getComputedStyle(item).fontSize || "12") || 12;
        const startsLine = Math.abs(first.left - contentLeft) <= 2;
        const midY = first.top + first.height / 2;
        let painted = false;
        for (const factor of [0.5, 0.8, 1.0]) {
          const stack = document.elementsFromPoint(first.left - factor * fontSize, midY);
          if (stack.some((hit) => hit === item || item.contains(hit))) {
            painted = true;
            break;
          }
        }
        if (startsLine && painted) {
          failures.push(`${label} item ${k} separator painted at line start`);
        }
        if (!startsLine && !painted) {
          failures.push(`${label} item ${k} separator missing mid-line`);
        }
      }
    }
    return { failures, rowCount: rows.size, wrapped, labels };
  }, scopes);
}

// First glyph left per visual line for one row selector.
async function rowLineLefts(page: Page, selector: string, index: number): Promise<number[]> {
  return page.evaluate(
    ({ sel, idx }) => {
      const rows = Array.from(document.querySelectorAll(sel));
      const row = rows[idx] as HTMLElement | undefined;
      if (!row) {
        return [];
      }
      const glyphs: { top: number; left: number; ch: string }[] = [];
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent || parent.closest(".sr-only")) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const range = document.createRange();
      let node: Node | null;
      while ((node = walker.nextNode()) !== null) {
        const text = node.textContent ?? "";
        // A copy button reserves room for its longest confirmation label
        // and centers its text, so a button-owning line reports the
        // button box edge: the control itself is left aligned.
        const button = node.parentElement?.closest("button") as HTMLElement | null;
        const buttonLeft = button !== null ? button.getBoundingClientRect().left : null;
        for (let i = 0; i < text.length; i += 1) {
          const ch = text[i] as string;
          if (ch.trim() === "") {
            continue;
          }
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          for (const rect of Array.from(range.getClientRects())) {
            if (rect.width === 0 && rect.height === 0) {
              continue;
            }
            glyphs.push({ top: rect.top, left: buttonLeft ?? rect.left, ch });
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
      return Array.from(buckets.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, items]) => Math.min(...items.map((item) => item.left)));
    },
    { sel: selector, idx: index },
  );
}

async function expectRowAligned(page: Page, selector: string, index: number): Promise<number> {
  const lefts = await rowLineLefts(page, selector, index);
  expect(lefts.length).toBeGreaterThan(0);
  const first = lefts[0] as number;
  for (const left of lefts) {
    expect(Math.abs(left - first), `${selector}#${index} wrapped line offset`).toBeLessThanOrEqual(0.5);
  }
  return first;
}

// First visual line's left edge for one row: compares edges across the
// three feed lines without requiring each line to fit on one line.
async function firstLineLeft(page: Page, selector: string, index: number): Promise<number> {
  const lefts = await rowLineLefts(page, selector, index);
  expect(lefts.length, `${selector}#${index} has a visible first line`).toBeGreaterThan(0);
  return lefts[0] as number;
}

type SepStatus = {
  found: boolean;
  startsLine: boolean;
  beforeContent: string;
  hitIsItem: boolean;
};

async function sepStatus(page: Page, selector: string, rowIndex: number, itemIndex: number): Promise<SepStatus> {
  return page.evaluate(
    ({ sel, rIdx, iIdx }) => {
      const rows = Array.from(document.querySelectorAll(sel));
      const row = rows[rIdx] as HTMLElement | undefined;
      const item = row?.querySelectorAll(":scope > .meta-item")?.[iIdx] as HTMLElement | undefined;
      if (!row || !item) {
        return { found: false, startsLine: false, beforeContent: "", hitIsItem: false };
      }
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
      const midY = first.top + first.height / 2;
      let hitIsItem = false;
      for (const factor of [0.5, 0.8, 1.0]) {
        const stack = document.elementsFromPoint(first.left - factor * fontSize, midY);
        if (stack.some((hit) => hit === item || item.contains(hit))) {
          hitIsItem = true;
          break;
        }
      }
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

test("brief40_mobile_separators_found_generically", async ({ page }) => {
  await mockRest(page);
  await seedRecent(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/#/");
  await expect(page.getByText("2 new tokens")).toBeVisible();
  const recentCount = await page.locator(".recent-meta").count();
  expect(recentCount).toBeGreaterThanOrEqual(1);

  const startScan = await genericScan(page, [
    'section[aria-label="New tokens"]',
    'section[aria-label="Recently analyzed"]',
  ]);
  expect(startScan.labels.length).toBeGreaterThan(0);
  expect(startScan.rowCount).toBeGreaterThanOrEqual(3);
  expect(startScan.failures, startScan.failures.join("; ")).toEqual([]);
  expect(startScan.wrapped).toBe(true);

  // Feed rows share one left text edge per row (DX-1 replaces the old
  // card/table layouts with one FeedRow at every width): the symbol line,
  // the meta line and the address line all start flush.
  const feedRows = page.locator('section[aria-label="New tokens"] .feed-row');
  const feedRowCount = await feedRows.count();
  expect(feedRowCount).toBeGreaterThanOrEqual(2);
  for (let i = 0; i < feedRowCount; i += 1) {
    const line1Left = await firstLineLeft(page, 'section[aria-label="New tokens"] .feed-line1', i);
    const line2Left = await firstLineLeft(page, 'section[aria-label="New tokens"] .feed-line2', i);
    const line3Left = await firstLineLeft(page, 'section[aria-label="New tokens"] .feed-line3', i);
    expect(Math.abs(line2Left - line1Left), `feed row ${i} lines share left edge`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(line3Left - line1Left), `feed row ${i} address shares left edge`).toBeLessThanOrEqual(0.5);
  }

  // The feed meta line keeps real separators between items at phone
  // width (DX-1 points the scan at the new row component's meta line):
  // every meta item after the first draws its own dot, a wrapped line
  // starts with a bare item, and mid-line dots stay painted.
  for (let i = 0; i < feedRowCount; i += 1) {
    const metaItems = await itemCount(page, 'section[aria-label="New tokens"] .feed-line2', i);
    expect(metaItems).toBeGreaterThanOrEqual(2);
    let painted = 0;
    for (let k = 1; k < metaItems; k += 1) {
      const sep = await sepStatus(page, 'section[aria-label="New tokens"] .feed-line2', i, k);
      expect(sep.found).toBe(true);
      expect(sep.beforeContent, `feed meta row ${i} item ${k} separator`).toContain("·");
      if (!sep.startsLine) {
        expect(sep.hitIsItem, `feed meta row ${i} item ${k} separator painted`).toBe(true);
        painted += 1;
      }
    }
    expect(painted).toBeGreaterThanOrEqual(1);
  }

  // Note: hash URLs build by concatenation (see token-symbol-heading).
  await page.goto("/#/token/" + TOKEN_A);
  await expect(page.locator('[data-testid="token-address-full"]').first()).toBeVisible();
  // The DEX age meta arrives with the live feed, after the analysis
  // result that unblocks the wait above. The scan below requires that
  // line (its interior separators are the only hero middots), so wait
  // for it first; otherwise a slow feed reads as zero separator rows.
  await expect(page.locator(".token-meta").first()).toContainText("·");
  const analysisScan = await genericScan(page, ['section[aria-label="Combined score"]']);
  // R2-4: the hero address is a separator-free block (label row plus the
  // grouped value, wrapping between groups) and the DEX meta is one
  // unbreakable unit, so no hero separator row wraps. The scan still
  // finds the DEX line through its interior separators and must report
  // no stranded or missing separators. (The owner-powers strip summary
  // uses sentence stops, never middots, so it stays out of this scan.)
  expect(analysisScan.rowCount).toBeGreaterThanOrEqual(1);
  expect(analysisScan.failures, analysisScan.failures.join("; ")).toEqual([]);
  expect(analysisScan.wrapped).toBe(false);

  // The token meta keeps its own left edge inside the hero.
  await expectRowAligned(page, ".token-meta", 0);

  // No horizontal scroll at 390 px.
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBe(390);

  // The 44 px copy tap target and its focus ring survive the inline-start
  // clip: the button keeps its full height inside the viewport.
  const headerCopy = page.locator('[data-testid="copy-contract-address"]').first();
  await headerCopy.focus();
  const copyBox = await headerCopy.evaluate((element) => {
    const rect = (element as HTMLElement).getBoundingClientRect();
    const row = (element as HTMLElement).closest(".token-addr") as HTMLElement | null;
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

test("brief40_desktop_separators_stay_visible_between_items", async ({ page }) => {
  await mockRest(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Note: hash URLs build by concatenation (see token-symbol-heading).
  await page.goto("/#/token/" + TOKEN_A);
  await expect(page.locator('[data-testid="token-address-full"]').first()).toBeVisible();
  // The DEX age meta arrives with the live feed, after the analysis
  // result that unblocks the wait above: wait for it first, otherwise a
  // slow feed reads as zero separator rows (same race the mobile test
  // guards against).
  await expect(page.locator(".token-meta").first()).toContainText("·");
  // R2-4: the hero meta is a single DEX unit (the name rides the h1 and
  // the address is a separator-free block), so no between-item
  // separators remain; the interior separators stay visible on one line.
  const heroItems = await itemCount(page, ".token-meta", 0);
  expect(heroItems).toBe(1);

  // Accessible names are unchanged: copy controls keep their labels.
  await expect(page.locator('[data-testid="copy-contract-address"]').first()).toHaveAttribute(
    "aria-label",
    "Copy contract address",
  );

  await page.goto("/#/");
  await expect(page.getByText("2 new tokens")).toBeVisible();
  // The feed rows keep their real inline separators on desktop (DX-1
  // replaces the wide live table with FeedRow at every width).
  await expect(page.locator(".feed-row").getByText("Uniswap V3 · 1%").first()).toBeVisible();
  // The feed header keeps separators between its items on desktop.
  const feedItems = await itemCount(page, ".feedhead .feed-count", 0);
  expect(feedItems).toBeGreaterThanOrEqual(3);
  let feedPainted = 0;
  for (let k = 1; k < feedItems; k += 1) {
    const sep = await sepStatus(page, ".feedhead .feed-count", 0, k);
    expect(sep.beforeContent, `feed header item ${k} separator`).toContain("·");
    if (!sep.startsLine) {
      expect(sep.hitIsItem, `feed header item ${k} separator painted`).toBe(true);
      feedPainted += 1;
    }
  }
  expect(feedPainted).toBeGreaterThanOrEqual(1);
});
