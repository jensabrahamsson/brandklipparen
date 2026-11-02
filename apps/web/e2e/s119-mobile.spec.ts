// S-119: every view fits the phone. No horizontal scrolling at 390 px
// and 320 px on the start page, the token page (all tabs, Simple and
// Expert) and the error pages; the live list renders as stacked cards
// below 640 px; badges stay fully visible; every tap target is 44 px.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const ADDRESS = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const ANALYZE_FIXTURE = {
  kind: "assessed",
  target: ADDRESS,
  block: 18000000,
  proxy: { kind: "none" },
  codeHash: `0x${"cd".repeat(32)}`,
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

const LIVE_FIXTURE = {
  source: "etherscan",
  status: "live",
  updatedAt: 1700000000000,
  items: [
    {
      tokenAddress: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbee1",
      symbol: "PEPE",
      name: "Pepe",
      pairAddress: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbee2",
      dex: "Uniswap V2",
      block: 18000000,
      createdAt: 1700000000,
      blockTimestampMs: 1700000000000,
      ageSeconds: 45,
      initialLiquidityWeth: "12.5",
      state: "done",
      riskBand: "High",
      score: 84,
    },
    {
      tokenAddress: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbee3",
      symbol: null,
      name: null,
      pairAddress: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbee4",
      dex: "Uniswap V3",
      feeTier: 3000,
      block: 18000000,
      createdAt: 1700000000,
      blockTimestampMs: null,
      ageSeconds: null,
      initialLiquidityWeth: null,
      state: "cant-tell",
      reason: "missing data",
    },
  ],
};

async function mockRest(page: Page, analyzeStatus: number, analyzeBody: unknown): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH_DISABLED) });
  });
  await page.route("**/v1/analyze*", async (route) => {
    await route.fulfill({ status: analyzeStatus, contentType: "application/json", body: JSON.stringify(analyzeBody) });
  });
  await page.route("**/v1/plugins", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plugins: [] }) });
  });
  await page.route("**/v1/live-tokens*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(LIVE_FIXTURE) });
  });
}

async function expectFitsViewport(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
}

async function expectBadgesVisible(page: Page): Promise<void> {
  for (const badge of await page.locator(".risk-badge").all()) {
    if (!(await badge.isVisible())) {
      continue;
    }
    const box = await badge.boundingBox();
    expect(box).not.toBeNull();
    const viewport = page.viewportSize() ?? { width: 390, height: 844 };
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
  }
}

async function expectTapTargets(page: Page): Promise<void> {
  const small = await page.evaluate(() => {
    const bad: string[] = [];
    const viewportWidth = window.innerWidth;
    document.querySelectorAll("a, button, input, select, textarea, summary").forEach((element) => {
      if ((element as HTMLElement).offsetParent === null) {
        return;
      }
      if (element instanceof HTMLButtonElement && element.disabled) {
        return;
      }
      // U-12: feed symbol links stretch over their whole row (::after
      // inset 0), so the row box is the hit area and the anchor text is
      // compact. Rows are checked separately below.
      if (element instanceof HTMLAnchorElement && element.classList.contains("feed-link")) {
        return;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || rect.right < 0 || rect.left > viewportWidth) {
        return;
      }
      if (rect.width < 44 || rect.height < 44) {
        bad.push(`${element.tagName}<${element.className ?? ""}> ${Math.round(rect.width)}x${Math.round(rect.height)}`);
      }
    });
    return bad;
  });
  expect(small).toEqual([]);
}

test("s119_no_horizontal_scroll_at_390_and_320", async ({ page }) => {
  await mockRest(page, 200, ANALYZE_FIXTURE);
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Scan before you swap." })).toBeVisible();
    await expectFitsViewport(page);

    // The live list renders as shared rows at every width: no table,
    // no separate card layout, no horizontal overflow.
    const live = page.locator('section[aria-label="New tokens"]');
    await expect(live).toBeVisible();
    await expect(live.locator(".feed-row").first()).toContainText("PEPE");
    expect(await live.locator(".live-table").count()).toBe(0);
    expect(await live.locator(".live-cards").count()).toBe(0);
    // U-12: each stretched row is the link target, so every row box
    // meets the 44 px target even though the anchor text is compact.
    for (const box of await live.locator(".feed-row").evaluateAll((rows) =>
      rows.map((row) => {
        const rect = (row as HTMLElement).getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height) };
      }),
    )) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await expectFitsViewport(page);
    await expectBadgesVisible(page);
    await expectTapTargets(page);

    await page.goto(`/#/token/${ADDRESS}`);
    await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();
    await expectFitsViewport(page);
    await expectBadgesVisible(page);
    await expectTapTargets(page);

    // S-132: the verdict "?" stays inline at the end of the headline
    // with its 44x44 tap box, and keyboard focus still opens its text.
    const meaning = page.locator(".risk-meaning");
    const help = page.getByTestId("explain-score:combined");
    const meaningBox = await meaning.boundingBox();
    const helpBox = await help.boundingBox();
    expect(meaningBox).not.toBeNull();
    expect(helpBox).not.toBeNull();
    expect(helpBox?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(helpBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect((helpBox?.x ?? 0) - (meaningBox?.x ?? 0)).toBeGreaterThan(40);
    await help.focus();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await page.keyboard.press("Escape");

    for (const name of ["Explain this result", "Investigate"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await expectFitsViewport(page);
      await expectTapTargets(page);
    }

    // Expert mode with every section on. The switch persists across
    // reloads (W-8 keeps the K-034 key) and this loop reuses one
    // context, so the second width may start checked: only press when
    // it is off.
    const expertSwitch = page.getByTestId("expert-switch");
    if ((await expertSwitch.getAttribute("aria-checked")) !== "true") {
      await expertSwitch.click();
    }
    await expect(expertSwitch).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("expert-detail")).toBeVisible();
    await expectFitsViewport(page);
    await expectTapTargets(page);

    // S-132: compact legend stays readable on phones with the same
    // three bands, and recent rows read as two-line cards.
    await page.evaluate(() =>
      sessionStorage.setItem(
        "brandklipparen-recent",
        JSON.stringify([
          {
            address: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbee1",
            score: 84,
            word: "High",
            probabilities: { "rug-pull": 0.62, honeypot: 0.91, "bot-pump": 0.34 },
            topSignal: "The owner can stop you from selling.",
            symbol: "LONGTOKENSYMBOL",
            name: "Long Token Symbol",
          },
        ]),
      ),
    );
    await page.goto("/");
    const legend = page.locator(".legend");
    await expect(legend).toBeVisible();
    await expect(legend).toContainText("0–29");
    await expect(legend).toContainText("LOW");
    await expect(legend).toContainText("lowest band on this scale");
    await expect(legend).toContainText("not a promise");
    const recentRow = page.locator(".recent-row").first();
    await expect(recentRow).toBeVisible();
    expect((await recentRow.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    const riskCell = recentRow.locator(".numeric").first();
    await expect(riskCell).toContainText("High");
    expect(await riskCell.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    const titleBox = await recentRow.locator(".recent-title").boundingBox();
    const barsBox = await recentRow.locator(".recent-bars").boundingBox();
    expect(titleBox).not.toBeNull();
    expect(barsBox).not.toBeNull();
    expect(barsBox?.y ?? 0).toBeGreaterThanOrEqual((titleBox?.y ?? 0) + (titleBox?.height ?? 0) - 1);
    const rowBox = await recentRow.boundingBox();
    const view = page.viewportSize() ?? { width: 390, height: 844 };
    expect((rowBox?.x ?? 0) + (rowBox?.width ?? 0)).toBeLessThanOrEqual(view.width);
    await expectFitsViewport(page);
    await expectTapTargets(page);

    // The invalid-address error page fits too.
    await page.goto("/#/token/not-an-address");
    await expect(page.getByRole("alert")).toBeVisible();
    await expectFitsViewport(page);
    await expectTapTargets(page);
  }
});

test("s119_error_pages_have_no_horizontal_scroll", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await mockRest(page, 503, { status: 503, code: "upstream-unavailable", message: "Down for maintenance." });
  await page.goto(`/#/token/${ADDRESS}`);
  await expect(page.getByRole("alert")).toBeVisible();
  await expectFitsViewport(page);
  await expectTapTargets(page);
});

test("s119_muse_controls_fit_at_phone_widths", async ({ page }) => {
  await mockRest(page, 200, ANALYZE_FIXTURE);
  await page.goto(`/#/token/${ADDRESS}`);
  const explain = page.getByRole("button", { name: "Explain this result", exact: true });
  const investigate = page.getByRole("button", { name: "Investigate", exact: true });
  const ask = page.getByLabel("Ask about this token");
  await expect(explain).toBeVisible();
  await expect(investigate).toBeVisible();
  await expect(ask).toBeVisible();
  for (const width of [320, 360, 390, 479]) {
    await page.setViewportSize({ width, height: 900 });
    // The Explain button reads the full label on exactly one line at 44 px.
    const label = await explain.evaluate((node) => {
      const text = Array.from(node.childNodes).find(
        (child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim() !== "",
      );
      if (text === undefined) {
        return { lines: -1, name: "" };
      }
      const range = document.createRange();
      range.selectNodeContents(text);
      return { lines: range.getClientRects().length, name: text.textContent?.trim() ?? "" };
    });
    expect(label.name).toBe("Explain this result");
    expect(label.lines).toBe(1);
    expect((await explain.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    // The Ask field spans the full row with Ask below it.
    const stacked = await page.evaluate(() => {
      const row = document.querySelector(".muse-ask-row");
      const field = document.querySelector(".muse-ask-field");
      const button = document.querySelector<HTMLButtonElement>(".muse-ask-row .button");
      if (row === null || field === null || button === null) {
        return null;
      }
      const rowBox = row.getBoundingClientRect();
      const fieldBox = field.getBoundingClientRect();
      const buttonBox = button.getBoundingClientRect();
      return {
        columns: getComputedStyle(row).gridTemplateColumns.split(" ").length,
        fieldWidth: fieldBox.width,
        rowWidth: rowBox.width,
        buttonBelow: buttonBox.top >= fieldBox.bottom - 1,
        buttonFull: buttonBox.width >= rowBox.width - 2,
      };
    });
    expect(stacked?.columns).toBe(1);
    expect(stacked?.fieldWidth ?? 0).toBeGreaterThanOrEqual((stacked?.rowWidth ?? 0) - 2);
    expect(stacked?.buttonBelow).toBe(true);
    expect(stacked?.buttonFull).toBe(true);
    // The placeholder fits the input's content width.
    const fit = await page.evaluate(() => {
      const input = document.getElementById("muse-ask-input") as HTMLInputElement | null;
      if (input === null) {
        return null;
      }
      const style = getComputedStyle(input);
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (context === null) {
        return null;
      }
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const text = context.measureText(input.placeholder).width;
      const content = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return { placeholder: input.placeholder, text, content };
    });
    expect(fit?.placeholder).toBe("Type your question");
    expect(fit?.text ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(fit?.content ?? -1);
    // Every example chip is a 44 px target.
    for (const chip of await page.getByTestId("ask-example").all()) {
      expect((await chip.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await expectFitsViewport(page);
    await expectTapTargets(page);
  }
  // At 480 px and up Explain sits beside Investigate.
  await page.setViewportSize({ width: 480, height: 900 });
  const explainBox = await explain.boundingBox();
  const investigateBox = await investigate.boundingBox();
  expect(explainBox).not.toBeNull();
  expect(investigateBox).not.toBeNull();
  const explainBottom = (explainBox?.y ?? 0) + (explainBox?.height ?? 0);
  const investigateBottom = (investigateBox?.y ?? 0) + (investigateBox?.height ?? 0);
  const verticalOverlap =
    Math.min(explainBottom, investigateBottom) - Math.max(explainBox?.y ?? 0, investigateBox?.y ?? 0);
  expect(verticalOverlap).toBeGreaterThan(0);
  expect(explainBox?.right ?? 0).toBeLessThanOrEqual(investigateBox?.x ?? 0);
  await expectFitsViewport(page);
  await expectTapTargets(page);
});
