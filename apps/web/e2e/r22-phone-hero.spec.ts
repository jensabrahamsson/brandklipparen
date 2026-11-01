// R2-2 acceptance: phone hero fold, gauge rows, gauges always in hero.
// USDT-like (3 found + 2 extended + 4 can't tell) and PEPE-like (2 extended
// + 7 can't tell) fixtures stress the strip the way the review screenshots
// do, so the fold assertion is meaningful and not an empty-plugins pass.
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

function hardToAnalyzeResult(): Record<string, unknown> {
  return {
    pluginId: "dev.brandklipparen.hard-to-analyze",
    pluginVersion: "1.0.0",
    outcome: "ok",
    findings: [
      {
        id: "dev.brandklipparen.hard-to-analyze:timeout",
        title: "Slow read",
        payload: { cause: "timeout" },
        evidence: [{ selector: "0x12345678", offset: 1 }],
      },
    ],
  };
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
    hardToAnalyzeResult(),
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
    hardToAnalyzeResult(),
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
  await expect(hero.locator(".gauges .gauge").first()).toBeVisible();
}

type Box = { x: number; y: number; width: number; height: number };

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test("r22_bandtag_above_fold_on_phones", async ({ page }) => {
  for (const [target, score] of [
    [USDT, 29],
    [PEPE, 19],
  ] as const) {
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 320, height: 844 },
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
      expect(bottom ?? 1000).toBeLessThan(844);
    }
  }
});

test("r22_gauge_label_and_percent_do_not_overlap", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openToken(page, USDT, 29);
  for (const viewport of [{ width: 320 }, { width: 390 }, { width: 639 }]) {
    await page.setViewportSize({ width: viewport.width, height: 844 });
    const gauges = page.locator('section[aria-label="Combined score"] .gauge');
    await expect(gauges).toHaveCount(3);
    for (let index = 0; index < 3; index += 1) {
      const gauge = gauges.nth(index);
      const lab = await gauge.locator(".lab").boundingBox();
      const pct = await gauge.locator(".pct").boundingBox();
      expect(lab).not.toBeNull();
      expect(pct).not.toBeNull();
      if (lab !== null && pct !== null) {
        expect(intersects(lab, pct)).toBe(false);
      }
    }
  }
});

test("u1_phone_chips_no_overlap_no_sideways_scroll", async ({ page }) => {
  // D-1 layout contract: a USDT-shaped strip (3 found + 3 extended,
  // including Transfer fee and Transfer limits) and a PEPE-shaped strip
  // stay inside the hero card with no overlapping rows at 320-639 px.
  for (const [target, score] of [
    [USDT, 29],
    [PEPE, 19],
  ] as const) {
    for (const width of [320, 390, 480, 639]) {
      await page.setViewportSize({ width, height: 844 });
      await openToken(page, target, score);
      const metrics = await page.evaluate(() => {
        const rectOf = (element: Element): Box => {
          const box = element.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        };
        const hero = document.querySelector('section[aria-label="Combined score"]');
        return {
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          hero: hero === null ? null : rectOf(hero),
          chips: [...document.querySelectorAll(".power-chip")].map(rectOf),
        };
      });
      expect(metrics.scrollWidth).toBe(metrics.clientWidth);
      expect(metrics.chips.length).toBeGreaterThan(0);
      if (metrics.hero === null) {
        throw new Error("hero card missing");
      }
      const hero = metrics.hero;
      for (const [outer, chip] of metrics.chips.entries()) {
        expect(chip.x).toBeGreaterThanOrEqual(hero.x - 1);
        expect(chip.x + chip.width).toBeLessThanOrEqual(hero.x + hero.width + 1);
        for (const other of metrics.chips.slice(outer + 1)) {
          expect(intersects(chip, other)).toBe(false);
        }
      }
    }
  }
});

test("r22_hero_gauges_muse_dom_order", async ({ page }) => {
  await openToken(page, USDT, 29);
  for (const viewport of [{ width: 320 }, { width: 390 }, { width: 768 }, { width: 1440 }]) {
    await page.setViewportSize({ width: viewport.width, height: 844 });
    const order = await page.evaluate(() => {
      const hero = document.querySelector('section[aria-label="Combined score"]');
      const gauges = hero?.querySelector(".gauges") ?? null;
      const muse = document.querySelector('[data-testid="muse-console"]');
      if (hero === null || gauges === null || muse === null) {
        return null;
      }
      const heroBeforeMuse =
        (hero.compareDocumentPosition(muse) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      const gaugesInsideHero = hero.contains(gauges);
      const gaugesBeforeMuse =
        (gauges.compareDocumentPosition(muse) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      return { heroBeforeMuse, gaugesInsideHero, gaugesBeforeMuse };
    });
    expect(order).not.toBeNull();
    expect(order?.gaugesInsideHero).toBe(true);
    expect(order?.heroBeforeMuse).toBe(true);
    expect(order?.gaugesBeforeMuse).toBe(true);
  }
});

test("u3_ai_in_first_viewport", async ({ page }) => {
  // D-4 hero diet: at laptop widths the hero ends by y 720, the Muse
  // console head and the Explain button sit in the first viewport, and
  // can't-tell chips collapse into one "+N can't tell ›" link.
  for (const [target, score, linkText] of [
    [USDT, 29, "+3 can't tell ›"],
    [PEPE, 19, "+7 can't tell ›"],
  ] as const) {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 1920, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await openToken(page, target, score);
      const metrics = await page.evaluate(() => {
        const rectOf = (selector: string): Box | null => {
          const element = document.querySelector(selector);
          if (element === null) {
            return null;
          }
          const box = element.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        };
        return {
          hero: rectOf('section[aria-label="Combined score"]'),
          museHead: rectOf('[data-testid="muse-console"] .muse-head'),
          explain: rectOf('[data-testid="muse-console"] .muse-actions .button'),
          moreLinks: [...document.querySelectorAll(".powers-more")].map(
            (link) => link.textContent ?? "",
          ),
          cantTellChips: document.querySelectorAll(".power-chip.state-cant-tell").length,
          summary: document.querySelector(".powers-summary"),
        };
      });
      expect(metrics.hero).not.toBeNull();
      expect((metrics.hero?.y ?? 1000) + (metrics.hero?.height ?? 0)).toBeLessThanOrEqual(720);
      expect(metrics.museHead).not.toBeNull();
      expect((metrics.museHead?.y ?? 1000) + (metrics.museHead?.height ?? 0)).toBeLessThanOrEqual(900);
      expect(metrics.explain).not.toBeNull();
      expect(metrics.explain?.y ?? 1000).toBeGreaterThanOrEqual(0);
      expect((metrics.explain?.y ?? 1000) + (metrics.explain?.height ?? 0)).toBeLessThanOrEqual(900);
      expect(metrics.cantTellChips).toBe(0);
      expect(metrics.moreLinks).toEqual([linkText]);
      expect(metrics.summary).toBeNull();
    }
  }
  // The console head stays visible at 1280x800, and the single link
  // holds at every width including phones.
  for (const [target, score] of [
    [USDT, 29],
    [PEPE, 19],
  ] as const) {
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 1024, height: 800 },
      { width: 768, height: 844 },
      { width: 390, height: 844 },
      { width: 320, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await openToken(page, target, score);
      const metrics = await page.evaluate(() => ({
        headTop: document
          .querySelector('[data-testid="muse-console"] .muse-head')
          ?.getBoundingClientRect().top ?? null,
        links: document.querySelectorAll(".powers-more").length,
        chips: document.querySelectorAll(".power-chip.state-cant-tell").length,
      }));
      if (viewport.width === 1280) {
        expect(metrics.headTop).not.toBeNull();
        expect(metrics.headTop ?? 1000).toBeLessThanOrEqual(800);
      }
      expect(metrics.links).toBe(1);
      expect(metrics.chips).toBe(0);
    }
  }
});

test("u2_phone_risk_rows_single_line_no_card", async ({ page }) => {
  // D-3 layout contract: phone gauge rows read as one line each with no
  // card-in-card frame, so labels never ellipsize and numbers clear the bar.
  for (const [target, score] of [
    [USDT, 29],
    [PEPE, 19],
  ] as const) {
    for (const width of [320, 390, 639]) {
      await page.setViewportSize({ width, height: 844 });
      await openToken(page, target, score);
      const rows = await page.evaluate(() => {
        const rectOf = (element: Element): Box => {
          const box = element.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        };
        return [...document.querySelectorAll('section[aria-label="Combined score"] .gauge')].map(
          (gauge) => {
            const label = gauge.querySelector(".t");
            const pct = gauge.querySelector(".pct");
            const bar = gauge.querySelector(".bar20");
            const style = window.getComputedStyle(gauge);
            return {
              height: gauge.getBoundingClientRect().height,
              clipped:
                label === null ? null : label.scrollWidth - label.clientWidth,
              pct: pct === null ? null : rectOf(pct),
              bar: bar === null ? null : rectOf(bar),
              borderTop: style.borderTopWidth,
              borderLeft: style.borderLeftWidth,
              shadow: style.boxShadow,
            };
          },
        );
      });
      expect(rows.length).toBe(3);
      for (const row of rows) {
        expect(row.clipped).not.toBeNull();
        expect(row.clipped ?? 1).toBeLessThanOrEqual(0);
        expect(row.height).toBeLessThanOrEqual(44);
        expect(row.borderTop).toBe("0px");
        expect(row.borderLeft).toBe("0px");
        expect(row.shadow).toBe("none");
        expect(row.pct).not.toBeNull();
        expect(row.bar).not.toBeNull();
        if (row.pct !== null && row.bar !== null) {
          expect(intersects(row.pct, row.bar)).toBe(false);
        }
      }
    }
  }
});
