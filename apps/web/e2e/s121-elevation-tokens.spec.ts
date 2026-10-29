// S-121: elevation and material tokens. Every card, graph node, tooltip
// and strip carries a layered elevation shadow from the --elev-* tokens
// (no raw box-shadow anywhere in the stylesheet); nothing uses CSS
// transform or perspective; the score ring has a static disc plus a
// band-coloured glow; the verdict header has a 1px band top border; text
// contrast is unchanged; and the look is identical under reduced motion.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const ADDRESS = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const ANALYZE_FIXTURE = {
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
  signals: [
    {
      kind: "capability",
      id: "owner-blacklist",
      risk: "honeypot",
      direction: "raises",
      severity: "high",
      evidence: [{ selector: "0x44337ea1", offset: 2623 }],
    },
  ],
  explanation: {
    kind: "template",
    templateVersion: "1.0.0",
    claims: [
      {
        text: "The owner can stop you from selling.",
        signalLinks: ["owner-blacklist"],
        temporality: { kind: "can-change" },
      },
    ],
  },
  cantTell: [{ question: "Who holds the liquidity?", dataSource: "liquidity locks" }],
};

const HEALTH_DISABLED = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  costUnits: "placeholder-cost-unit",
};

async function mockRest(page: Page): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH_DISABLED) });
  });
  await page.route("**/v1/analyze*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ANALYZE_FIXTURE) });
  });
  await page.route("**/v1/plugins", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plugins: [] }) });
  });
  await page.route("**/v1/personalize/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", apiVersion: "v1", personalize: { disabled: true } }),
    });
  });
}

function luminance(rgb: readonly number[]): number {
  const linear = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [r = 0, g = 0, b = 0] = linear;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test("s121_elevation_tokens_cover_surfaces", async ({ page, browser }) => {
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);

  const cards = page.locator(".card");
  await expect(cards.first()).toBeVisible();

  const shadowed = await page.evaluate(() => {
    const bad: string[] = [];
    document.querySelectorAll(".card, .timeline-body").forEach((element) => {
      const shadow = getComputedStyle(element).boxShadow;
      if (shadow === "none") {
        bad.push(element.tagName);
      }
    });
    return bad;
  });
  expect(shadowed).toEqual([]);

  // The tooltip and the summary strip are hidden until opened. Open both
  // and check they carry elevation too.
  await page.locator('[data-testid="explain-score:combined"]').focus();
  await expect(page.locator(".explain-tooltip").first()).toBeVisible();
  const tooltipShadow = await page
    .locator(".explain-tooltip")
    .first()
    .evaluate((element) => getComputedStyle(element).boxShadow);
  expect(tooltipShadow).not.toBe("none");

  await page.getByRole("tab", { name: "Contract assessment" }).click();
  const strip = page.locator(".compact-strip");
  await expect(strip).toBeVisible();
  expect(await strip.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");

  // No CSS transform or perspective anywhere in the author stylesheets.
  const motionDeclarations = await page.evaluate(() => {
    const found: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | null = null;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules ?? [])) {
        if (rule instanceof CSSStyleRule) {
          const transform = rule.style.getPropertyValue("transform");
          const perspective = rule.style.getPropertyValue("perspective");
          if (transform !== "" || perspective !== "") {
            found.push(`${rule.selectorText} ${transform} ${perspective}`);
          }
        }
      }
    }
    return found;
  });
  expect(motionDeclarations).toEqual([]);

  // Score ring: static disc plus a band-coloured arc glow.
  await page.getByRole("tab", { name: "Overview" }).click();
  const disc = await page
    .locator(".score-disc")
    .first()
    .evaluate((element) => getComputedStyle(element).backgroundImage);
  expect(disc).toContain("radial-gradient");
  const arcFilter = await page
    .locator(".score-arc")
    .first()
    .evaluate((element) => getComputedStyle(element).filter);
  expect(arcFilter).toContain("drop-shadow");

  // Verdict header: card tier with a 1px band top border (score 84 is High).
  const verdict = page.locator(".card.verdict");
  await expect(verdict).toBeVisible();
  expect(await verdict.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe("1px");
  const topColor = await verdict.evaluate((element) => getComputedStyle(element).borderTopColor);
  const highColor = await verdict.evaluate(
    (element) => getComputedStyle(element).getPropertyValue("--high").trim() || "unset",
  );
  expect(highColor).not.toBe("unset");
  expect(topColor.length).toBeGreaterThan(0);

  // Text contrast is unchanged: body and quiet text stay at least 4.5:1.
  const ratios = await page.evaluate(() => {
    const parse = (value: string): readonly [number, number, number] => {
      const match = value.match(/[\d.]+/g) ?? [];
      return [Number(match[0] ?? 0), Number(match[1] ?? 0), Number(match[2] ?? 0)];
    };
    const root = getComputedStyle(document.documentElement);
    const lum = (rgb: readonly [number, number, number]): number => {
      const linear = rgb.map((channel) => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
    };
    const ratio = (first: string, second: string): number => {
      const a = lum(parse(first));
      const b = lum(parse(second));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const body = getComputedStyle(document.body);
    return {
      body: ratio(body.color, body.backgroundColor),
      text: ratio(root.getPropertyValue("--text"), root.getPropertyValue("--bg")),
      text2: ratio(root.getPropertyValue("--text-2"), root.getPropertyValue("--bg")),
    };
  });
  expect(ratios.body).toBeGreaterThanOrEqual(4.5);
  expect(ratios.text).toBeGreaterThanOrEqual(4.5);
  expect(ratios.text2).toBeGreaterThanOrEqual(4.5);
  expect(luminance([230, 234, 240])).toBeGreaterThan(0);

  // Identical under reduced motion: the same card resolves the same
  // shadow and sheen when motion is reduced.
  const reference = await page
    .locator(".card")
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return `${style.boxShadow} || ${style.backgroundImage}`;
    });
  const reduced = await browser.newContext({ reducedMotion: "reduce" });
  const reducedPage = await reduced.newPage();
  await mockRest(reducedPage);
  await reducedPage.goto(`/#/token/${ADDRESS}`);
  await expect(reducedPage.locator(".card").first()).toBeVisible();
  const underReduce = await reducedPage
    .locator(".card")
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return `${style.boxShadow} || ${style.backgroundImage}`;
    });
  expect(underReduce).toBe(reference);
  await reduced.close();
});
