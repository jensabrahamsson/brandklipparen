// S-118: verdict-first token header. The token page leads with a header
// card (h1, score ring, truthful headline, probability mini row) and the
// toolbar row above it holds Search and the Expert switch (W-8: the
// Customize view is gone).
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
  await page.route("**/v1/live-tokens*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ source: "none", status: "live", updatedAt: 0, items: [] }),
    });
  });
}

test("s118_verdict_header_first_paint_and_customize", async ({ page }) => {
  await mockRest(page);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    // Round-trip through the start page so the token page always mounts
    // fresh (a same-URL goto would keep the previous React tree alive).
    await page.goto("/");
    await page.evaluate(() => localStorage.removeItem("brandklipparen-ui-mode"));
    await page.goto(`/#/token/${ADDRESS}`);
    const header = page.locator('section[aria-label="Combined score"]');
    await expect(header).toBeVisible();

    // Dial, number, band badge and headline are fully visible without
    // scrolling. The 50-tick dial keeps the accessible combined-score
    // name; the number counts up once and the HIGH badge reads inverse.
    for (const target of [
      page.getByRole("img", { name: /Combined score 84 of 100, High risk/ }),
      header.locator(".score-dial .num"),
      header.locator(".score-dial .bandtag"),
      header.locator(".risk-meaning"),
    ]) {
      const box = await target.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(viewport.height);
    }
    await expect(header.locator("h1")).toContainText("0xdead");
    // W-9: the hero no longer repeats the breakdown, so "Honey 91%" is
    // gone from the verdict card. The dial keeps the score and the
    // gauges own the percents.
    await expect(page.getByText("Rug pull", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Honeypot", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Bot pump", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("91%", { exact: true }).first()).toBeVisible();
    // The dial number counts up once to the score; the badge names the band.
    await expect(header.locator(".score-dial .num")).toHaveText("84");
    await expect(header.locator(".score-dial .bandtag")).toHaveText("HIGH");

    // Exactly one h1 and no skipped heading levels across the page.
    await expect(page.locator("h1")).toHaveCount(1);
    const outline = await page.evaluate(() => {
      const levels: number[] = [];
      document.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((element) => {
        if ((element as HTMLElement).offsetParent !== null) {
          levels.push(Number(element.tagName.slice(1)));
        }
      });
      return levels;
    });
    expect(outline[0]).toBe(1);
    for (let index = 1; index < outline.length; index += 1) {
      expect((outline[index] as number) - (outline[index - 1] as number)).toBeLessThanOrEqual(1);
    }

    // The Customize view is gone: no details.customize anywhere. The
    // toolbar holds one Search button and one Expert switch, and the Ask
    // field lives in the Muse console under the hero.
    await expect(page.locator("details.customize")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "← Search" })).toBeVisible();
    await expect(page.getByTestId("expert-switch")).toHaveCount(0);
    await expect(page.getByLabel("Ask about this token")).toBeVisible();

    // S-132: verdict copy sits near the top under the token meta with
    // the dial beside it, never vertically centred in a tall box.
    const meaningBox = await header.locator(".risk-meaning").boundingBox();
    const dialBox = await header.locator(".score-dial").boundingBox();
    expect(meaningBox).not.toBeNull();
    expect(dialBox).not.toBeNull();
    expect(meaningBox?.y ?? 0).toBeLessThanOrEqual((dialBox?.y ?? 0) + 8);
    // S-132: the headline caret takes the verdict's risk colour, here
    // high red, from the same risk band as the badge.
    const caretColor = await header
      .locator(".headline-marker")
      .evaluate((element) => getComputedStyle(element).color);
    expect(caretColor).toBe("rgb(255, 90, 82)");

    // The score Explain stays keyboard-reachable a few Tab stops after
    // the toolbar.
    await page.getByRole("button", { name: "← Search" }).focus();
    let reached = false;
    for (let stop = 0; stop < 8; stop += 1) {
      await page.keyboard.press("Tab");
      const testId = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
      if (testId === "explain-score:combined") {
        reached = true;
        break;
      }
    }
    expect(reached).toBe(true);

    // Technical details open with one click, no mode switch.
    await page.locator("details.tech-details > summary", { hasText: "Technical details" }).click();
    await expect(page.getByTestId("expert-detail")).toBeVisible();
  }
});

// W-9: PEPE-like fixture, 0 signals plus 1 extended finding. The strip
// names the unscored pattern ("No scored pattern. 1 owner power the
// score doesn't count yet.") so the quiet signal list never contradicts
// it, and every chip is a 44 px link to the detail view.
const PEPE_PLUGINS = {
  plugins: [
    "ownership",
    "pause",
    "blacklist",
    "mint",
    "transfer-fee",
    "transfer-limits",
    "sell-block",
    "transfer-hooks",
    "proxy-upgrade",
  ].map((slug) => ({
    id: `dev.brandklipparen.${slug}`,
    kind: "detector",
    weight: 1,
    version: "1.0.0",
    displayName: `${slug} detector`,
    description: `Reports ${slug}.`,
    frontmatter: { tags: ["holder"], audience: ["holder"], severity: { min: "low", max: "high" } },
  })),
};

const PEPE_ANALYZE = {
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
  probabilities: { "rug-pull": 0.26, honeypot: 0.2, "bot-pump": 0.12 },
  score: 19,
  signals: [],
  explanation: { kind: "template", templateVersion: "1.0.0", claims: [] },
  cantTell: [],
  pluginResults: [
    "ownership",
    "pause",
    "blacklist",
    "transfer-fee",
    "transfer-limits",
    "sell-block",
    "transfer-hooks",
    "proxy-upgrade",
  ].map((slug) => ({
    pluginId: `dev.brandklipparen.${slug}`,
    pluginVersion: "1.0.0",
    outcome: "ok",
    findings: [],
  })).concat([
    {
      pluginId: "dev.brandklipparen.mint",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [
        {
          id: "dev.brandklipparen.mint:mint-extended",
          title: "Mint, extended",
          payload: { fact: "mint", proof: "extended", capped: false },
          evidence: [{ selector: "0x40c10f19", offset: 100 }],
        },
      ],
    },
  ]),
};

async function mockPepeRest(page: Page): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH_DISABLED) });
  });
  await page.route("**/v1/analyze*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PEPE_ANALYZE) });
  });
  await page.route("**/v1/plugins", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PEPE_PLUGINS) });
  });
  await page.route("**/v1/live-tokens*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ source: "none", status: "live", updatedAt: 0, items: [] }),
    });
  });
}

test("s118_pepe_like_quiet_signals_with_extended_strip", async ({ page }) => {
  await mockPepeRest(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.goto(`/#/token/${ADDRESS}`);
  const header = page.locator('section[aria-label="Combined score"]');
  await expect(header).toBeVisible();

  // The dial, number, band tag and verdict stay fully in the viewport.
  for (const target of [
    page.getByRole("img", { name: /Combined score 19 of 100, Low risk/ }),
    header.locator(".score-dial .num"),
    header.locator(".score-dial .bandtag"),
    header.locator(".risk-meaning"),
  ]) {
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(844);
  }
  await expect(header.locator(".score-dial .num")).toHaveText("19");
  await expect(header.locator(".score-dial .bandtag")).toHaveText("LOW");
  await expect(header.locator(".risk-meaning")).toContainText("Low risk.");
  // R3 D-10: the verdict names the extended finding in plain words,
  // never as "more (not in score)".
  const verdict = header.locator(".risk-meaning");
  await expect(verdict).toContainText("Extended analysis found 1 owner power the score doesn't count yet");
  await expect(verdict).not.toContainText("more (not");

  // The strip names the unscored pattern with its not-in-score label,
  // and the chip is a 44 px link to the mint detail view.
  const strip = page.getByTestId("powers-strip");
  await expect(strip).toContainText("No scored pattern. 1 owner power the score doesn't count yet.");
  await expect(strip).toContainText("Not in score");
  const chip = page.getByTestId("power-chip-mint");
  await expect(chip).toBeVisible();
  expect(await chip.getAttribute("href")).toContain("/plugins/mint");
  const chipBox = await chip.boundingBox();
  expect(chipBox).not.toBeNull();
  expect(chipBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(chipBox?.height ?? 0).toBeGreaterThanOrEqual(44);

  // R3 D-10: "extended analysis" reads at most twice on the PEPE page.
  const bodyText = await page.evaluate(() => document.body.innerText);
  expect(bodyText.match(/extended analysis/gi)?.length ?? 0).toBeLessThanOrEqual(2);

  // The strip "?" explains when an extended finding sets the floor.
  await page.getByTestId("explain-powers:extended").focus();
  await expect(page.getByRole("tooltip")).toContainText("sets a minimum score");
});

test("score4_floor_blacklist_chip_agrees_with_high_score", async ({ page }) => {
  const floored = {
    ...PEPE_ANALYZE,
    score: 60,
    probabilities: { "rug-pull": 0.26, honeypot: 0.2, "bot-pump": 0.12 },
    scoreFloor: {
      rule: "owner-can-block-holders",
      minimum: 60,
      label: "floor: owner can block holders (blacklist)",
      facts: ["blacklist"],
    },
    pluginResults: PEPE_ANALYZE.pluginResults.map((entry) =>
      entry.pluginId === "dev.brandklipparen.blacklist"
        ? {
            pluginId: "dev.brandklipparen.blacklist",
            pluginVersion: "1.0.0",
            outcome: "ok",
            findings: [
              {
                id: "dev.brandklipparen.blacklist:blacklist-extended",
                title: "Blocked wallets, extended",
                payload: { fact: "blacklist", proof: "extended" },
                evidence: [{ selector: "0x44337ea1", offset: 200 }],
              },
            ],
          }
        : entry.pluginId === "dev.brandklipparen.mint"
          ? { ...entry, findings: [] }
          : entry,
    ),
  };
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH_DISABLED) });
  });
  await page.route("**/v1/analyze*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(floored) });
  });
  await page.route("**/v1/plugins", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PEPE_PLUGINS) });
  });
  await page.route("**/v1/live-tokens*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ source: "none", status: "live", updatedAt: 0, items: [] }),
    });
  });
  await page.goto("/");
  await page.goto(`/#/token/${ADDRESS}`);
  const strip = page.getByTestId("powers-strip");
  await expect(strip).toContainText("Sets minimum score");
  await expect(strip).not.toContainText("Not in score");
  await expect(page.getByTestId("power-chip-blacklist")).toBeVisible();
  const cards = page.locator(".gauges-hero > section");
  await expect(cards.first()).toHaveAttribute("data-testid", "floor-card");
  await expect(cards.first()).toHaveClass(/\bhigh\b/);
  await expect(cards.first()).toContainText("Owner can block holders: blacklist");
  await expect(page.getByText("Pattern model · history-based estimate")).toBeVisible();
  await expect(page.locator('section[aria-label="Why this score"]')).toContainText(
    "Owner can block holders (blacklist) — that sets the minimum score of 60.",
  );
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const bot = page.locator('section[aria-label="Bot pump: 12 percent"]');
    await expect(bot).toHaveClass(/\bfloor-muted\b/);
    const title = bot.getByText("Bot pump", { exact: true });
    const prior = bot.getByText("Prior · uncalibrated", { exact: true });
    const geometry = await title.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return { lines: range.getClientRects().length, bottom: element.getBoundingClientRect().bottom };
    });
    const priorBox = await prior.boundingBox();
    expect(geometry.lines).toBe(1);
    expect(priorBox?.y ?? 0).toBeGreaterThanOrEqual(geometry.bottom);
  }
});
