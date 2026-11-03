// W-1 quick wins (UI v2 §4, §6.1, §6.2): the shared layout contract on
// start and token pages, the copy tooltip causing no layout shift, the
// sentence-case typography rule, and the rewritten gauge help texts.
// The REST API is route-mocked: no live chain or provider calls.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { assertLayout } from "./helpers/layoutContract.ts";

const TOKEN_A = "0x5ab1e0000000000000000000000000000000a001";
const ACCOUNT = "0x5ab1e0000000000000000000000000000000c301";

const HEALTH = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  costUnits: "x",
};

const ANALYZE = {
  kind: "assessed",
  target: TOKEN_A,
  tokenSymbol: "AAA",
  tokenName: "Aaa Token",
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
  explanation: {
    kind: "template",
    templateVersion: "1.0.0",
    claims: [
      {
        text: `The owner account ${ACCOUNT} can pause trading.`,
        signalLinks: [],
        temporality: { kind: "applies-now" },
      },
    ],
  },
  cantTell: [],
  pluginResults: [],
};

async function stubClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __copied: string[] }).__copied = [];
    const writeText = async (text: string): Promise<void> => {
      (window as unknown as { __copied: string[] }).__copied.push(text);
    };
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });
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
      body: JSON.stringify({ status: "not-configured", source: "none", updatedAt: 1, items: [] }),
    });
  });
}

// Feed filter chips keep their pre-W-1 sizing; a later unit owns them.
const ALLOW = [".feedhead .chip"];

test("w1_layout_contract_holds_on_start_and_token_pages", async ({ page }) => {
  await mockRest(page);
  await page.goto("/");
  // The mock reports live-tokens as not-configured, so the start page
  // renders the "New tokens" unavailable section instead of the feed.
  await expect(page.getByRole("heading", { name: "New tokens" })).toBeVisible();
  await assertLayout(page, { allow: ALLOW });

  // Note: hash URLs build by concatenation (see token-symbol-heading).
  await page.goto("/#/token/" + TOKEN_A);
  await expect(page.locator('[data-testid="token-address-full"]').first()).toBeVisible();
  await assertLayout(page, { allow: ALLOW });
});

test("w1_copy_tooltip_shifts_no_layout", async ({ page }) => {
  await stubClipboard(page);
  await mockRest(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  // Note: hash URLs build by concatenation (see token-symbol-heading).
  await page.goto("/#/token/" + TOKEN_A);
  const headerCopy = page.locator('[data-testid="copy-contract-address"]').first();
  await expect(headerCopy).toBeVisible();

  // The tooltip is absolutely positioned inside .copy-wrap, so layout
  // shift reads on the surrounding boxes: the address label row and the
  // button itself must not move between idle, bubble and copied states.
  const boxesOf = (): Promise<{ meta: unknown; button: unknown } | null> =>
    page.evaluate(() => {
      const meta = document.querySelector(".token-addr") as HTMLElement | null;
      const button = document.querySelector('[data-testid="copy-contract-address"]') as HTMLElement | null;
      if (meta === null || button === null) {
        return null;
      }
      const metaRect = meta.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      return {
        meta: { x: metaRect.x, y: metaRect.y, width: metaRect.width, height: metaRect.height },
        button: { x: buttonRect.x, y: buttonRect.y, width: buttonRect.width, height: buttonRect.height },
      };
    });
  const before = await boxesOf();
  expect(before).not.toBeNull();

  // Keyboard focus opens the absolutely positioned bubble.
  await headerCopy.focus();
  await expect(page.locator(".token-addr .copy-wrap [role='tooltip']").first()).toHaveText("Copy");
  expect(await boxesOf()).toEqual(before);

  // Copy confirms through the same bubble; nothing around it moves.
  await page.keyboard.press("Enter");
  await expect(headerCopy).toHaveAttribute("data-state", "copied");
  await expect(page.locator(".token-addr .copy-wrap [role='tooltip']").first()).toHaveText("Copied");
  expect(await boxesOf()).toEqual(before);
});

test("w1_long_text_never_inherits_uppercase", async ({ page }) => {
  await mockRest(page);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "New tokens" })).toBeVisible();
    // Note: hash URLs build by concatenation (see token-symbol-heading).
    await page.goto("/#/token/" + TOKEN_A);
    await expect(page.locator('[data-testid="token-address-full"]').first()).toBeVisible();
    const upper = await page.evaluate(() => {
      const hits: string[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node !== null) {
        const text = (node.textContent ?? "").trim();
        if (text.length > 16) {
          const parent = node.parentElement;
          if (parent !== null) {
            const rect = parent.getBoundingClientRect();
            const style = getComputedStyle(parent);
            const shown = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
            if (shown && style.textTransform !== "none") {
              hits.push(`${text.slice(0, 40)} [${style.textTransform}]`);
            }
          }
        }
        node = walker.nextNode();
      }
      return hits;
    });
    expect(upper, `uppercase long text at ${width}px`).toEqual([]);
  }
});

test("w1_breakdown_tooltip_uses_the_new_copy", async ({ page }) => {
  await mockRest(page);
  // Note: hash URLs build by concatenation (see token-symbol-heading).
  await page.goto(`/#/token/${TOKEN_A}`);
  // R2-5 (D-17): the three per-gauge triggers are gone. The single
  // "Rug · Honeypot · Bot pump" trigger carries the same help for all three gauges.
  const trigger = page.getByTestId("explain-score:gauges");
  await expect(trigger).toBeVisible();
  await trigger.focus();
  const tooltip = page.locator('[role="tooltip"]');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("Risk breakdown");
  for (const sentence of [
    "owner can take the money",
    "buy but not sell",
    "bots dump on late buyers",
  ]) {
    await expect(tooltip).toContainText(sentence);
  }
  await expect(tooltip).not.toContainText("gauge");
  await expect(tooltip).not.toContainText("arc");
  await page.keyboard.press("Escape");
  await expect(page.locator('[role="tooltip"]')).toHaveCount(0);
  // No per-gauge trigger survives beside the gauges.
  for (const key of ["score:gauge:rug-pull", "score:gauge:honeypot", "score:gauge:bot-pump"]) {
    await expect(page.getByTestId(`explain-${key}`)).toHaveCount(0);
  }
});

test("w1_topbar_shows_network_mark_with_pictogram_fallback", async ({ page }) => {
  await mockRest(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const net = page.locator(".topbar .net");
  await expect(net).toContainText("Ethereum mainnet");
  await expect(net.locator("svg").first()).toBeVisible();
  await expect(page.getByText("bytecode only")).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(net.locator("svg").first()).toBeVisible();
  const labelBox = await net.locator(".net-text").boundingBox();
  expect(labelBox).not.toBeNull();
  // Pictogram only: the label collapses to screen-reader size.
  expect(labelBox?.width ?? 99).toBeLessThanOrEqual(2);
  expect(labelBox?.height ?? 99).toBeLessThanOrEqual(2);
});
