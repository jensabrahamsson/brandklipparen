// Click-every-control sweep: every visible enabled button, same-origin
// link, tab, switch and disclosure on each page is clicked once, and
// after every click the page must stay quiet (no console error, no
// pageerror, no developer strings in visible text) and hold the layout
// contract via assertLayout. Full sweeps run at 390 and 1440; 320 and
// 768 get layout-only checks. Every REST response is route-mocked with
// the synthetic fixtures in ./helpers/clickSweep.ts; no test reaches the
// network, follows an external link, or triggers a download.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { assertLayout } from "./helpers/layoutContract.ts";
import {
  ADDR_MANY,
  ADDR_PROXY,
  ADDR_ZERO,
  SELECTOR_ADD,
  checkQuiet,
  collectErrors,
  installClickMocks,
  sweepControls,
} from "./helpers/clickSweep.ts";
import type { ErrorBucket } from "./helpers/clickSweep.ts";

async function readyStart(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "Scan before you swap." })).toBeVisible();
}

async function readyToken(page: Page, score: number): Promise<void> {
  await expect(page.getByRole("img", { name: new RegExp(`Combined score ${score} of 100`) })).toBeVisible();
}

async function readyDetail(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
}

async function readyCode(page: Page): Promise<void> {
  await expect(page.locator(".code-view").first()).toBeVisible();
}

// The Ask field needs a question before its submit can fire the mocked
// chat endpoint during the sweep.
async function prefillAsk(page: Page): Promise<void> {
  const ask = page.getByLabel("Ask about this token");
  if ((await ask.count()) > 0) {
    await ask.fill("Can the owner stop transfers?");
  }
}

async function sweepAtWidths(
  page: Page,
  bucket: ErrorBucket,
  label: string,
  goto: () => Promise<void>,
  ready: () => Promise<void>,
  prefill: () => Promise<void>,
  widths: readonly number[],
): Promise<number> {
  let total = 0;
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    // A same-hash goto does not reload, so the previous width's clicks
    // (expanded rows, chosen tabs, filters) would leak into the next
    // width's ready check. Leave the page first so each width starts
    // from the route's initial state.
    await page.goto("about:blank");
    await goto();
    await ready();
    await prefill();
    await checkQuiet(page, bucket, `${label} ready at ${width}`);
    total += await sweepControls(page, bucket, width, `${label} at ${width}`);
  }
  expect(total, `controls clicked on ${label}`).toBeGreaterThan(0);
  return total;
}

test("start page sweep at 390 and 1440", async ({ page }) => {
  const bucket = collectErrors(page);
  await installClickMocks(page, "many");
  await sweepAtWidths(
    page,
    bucket,
    "start",
    () => page.goto("/"),
    () => readyStart(page),
    () => page.getByRole("textbox", { name: "Contract address" }).fill("not-an-address"),
    [390, 1440],
  );
});

test("token page with many findings sweep at 390", async ({ page }) => {
  const bucket = collectErrors(page);
  await installClickMocks(page, "many");
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`/#/token/${ADDR_MANY}`);
  await readyToken(page, 29);
  await prefillAsk(page);
  await checkQuiet(page, bucket, "many ready at 390");
  const clicks = await sweepControls(page, bucket, 390, "many at 390");
  expect(clicks).toBeGreaterThan(0);
});

test("token page with many findings sweep at 1440", async ({ page }) => {
  test.setTimeout(90_000);
  const bucket = collectErrors(page);
  await installClickMocks(page, "many");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#/token/${ADDR_MANY}`);
  await readyToken(page, 29);
  await prefillAsk(page);
  await checkQuiet(page, bucket, "many ready at 1440");
  const clicks = await sweepControls(page, bucket, 1440, "many at 1440");
  expect(clicks).toBeGreaterThan(0);
});

test("token page with zero findings sweep at 390 and 1440", async ({ page }) => {
  test.setTimeout(90_000);
  const bucket = collectErrors(page);
  await installClickMocks(page, "zero");
  await sweepAtWidths(
    page,
    bucket,
    "zero",
    () => page.goto(`/#/token/${ADDR_ZERO}`),
    async () => {
      await readyToken(page, 8);
      // All owner powers read "can't tell" while the score still stands.
      await expect(page.getByTestId("plugin-board-summary")).toContainText("can't tell");
    },
    () => prefillAsk(page),
    [390, 1440],
  );
});

test("proxy token page sweep at 390 and 1440", async ({ page }) => {
  test.setTimeout(90_000);
  const bucket = collectErrors(page);
  await installClickMocks(page, "proxy");
  await sweepAtWidths(
    page,
    bucket,
    "proxy",
    () => page.goto(`/#/token/${ADDR_PROXY}`),
    async () => {
      await readyToken(page, 62);
      // The implementation address renders in full with its own copy.
      await expect(page.getByLabel("Copy implementation address")).toBeVisible();
    },
    () => prefillAsk(page),
    [390, 1440],
  );
});

// Every plugin detail page reachable from the many-findings board,
// split into two tests so each stays well under the time budget.
async function boardHrefs(page: Page): Promise<string[]> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#/token/${ADDR_MANY}`);
  await readyToken(page, 29);
  const hrefs = await page
    .locator("section[aria-label='What we checked'] a.tile")
    .evaluateAll((elements) => elements.map((element) => element.getAttribute("href") ?? ""));
  return [...new Set(hrefs.filter((href) => href.startsWith("#/token/")))];
}

async function sweepDetails(page: Page, bucket: ErrorBucket, hrefs: readonly string[], batch: string): Promise<void> {
  for (const href of hrefs) {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/${href}`);
      await readyDetail(page);
      await checkQuiet(page, bucket, `${batch} ${href} ready at ${width}`);
      const clicks = await sweepControls(page, bucket, width, `${batch} ${href} at ${width}`);
      expect(clicks, `controls clicked on ${href}`).toBeGreaterThan(0);
    }
  }
}

test("plugin detail pages batch A sweep at 390 and 1440", async ({ page }) => {
  const bucket = collectErrors(page);
  await installClickMocks(page, "many");
  const hrefs = await boardHrefs(page);
  expect(hrefs.length).toBeGreaterThan(0);
  await sweepDetails(page, bucket, hrefs.slice(0, Math.ceil(hrefs.length / 2)), "batch A");
});

test("plugin detail pages batch B sweep at 390 and 1440", async ({ page }) => {
  // Two full detail sweeps stay under the shared budget per batch; the
  // history return now waits for the hash to commit (see clickSweep).
  test.setTimeout(180_000);
  const bucket = collectErrors(page);
  await installClickMocks(page, "many");
  const hrefs = await boardHrefs(page);
  expect(hrefs.length).toBeGreaterThan(0);
  await sweepDetails(page, bucket, hrefs.slice(Math.ceil(hrefs.length / 2)), "batch B");
});

test("decompiler page with function expanded and code view tabs", async ({ page }) => {
  // Two full sweeps of the heaviest page (both code panes at 1440)
  // outrun the shared 30 s budget; the clicks stay as fast as elsewhere.
  // 180 s so a loaded gate runner still finishes the up-to-160 clicks.
  test.setTimeout(180_000);
  const bucket = collectErrors(page);
  await installClickMocks(page, "many");
  const url = `/#/token/${ADDR_MANY}/plugins/decompiler/${SELECTOR_ADD}/decompiled`;
  await sweepAtWidths(
    page,
    bucket,
    "decompiler",
    () => page.goto(url),
    async () => {
      await readyCode(page);
      await expect(page.getByRole("button", { name: `Copy decompiled addBlackList(address)` })).toBeVisible();
    },
    () => Promise.resolve(),
    [390, 1440],
  );
  // The tabbed layout below 1100 px switches panes without navigating.
  // Fresh load first: the sweep above collapsed the route function, so
  // a same-hash goto would keep that state and hide the tablist.
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("about:blank");
  await page.goto(url);
  await readyCode(page);
  await expect(page.getByRole("tablist", { name: "Code views for addBlackList(address)" })).toBeVisible();
});

test("layout-only checks at 320 and 768", async ({ page }) => {
  const bucket = collectErrors(page);
  await installClickMocks(page, "many");
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/");
  await readyStart(page);
  await page.getByRole("textbox", { name: "Contract address" }).fill("not-an-address");
  await checkQuiet(page, bucket, "start layout");
  await assertLayout(page, { widths: [320, 768] });
  for (const [address, score] of [
    [ADDR_MANY, 29],
    [ADDR_ZERO, 8],
    [ADDR_PROXY, 62],
  ] as const) {
    await page.goto(`/#/token/${address}`);
    await readyToken(page, score);
    await checkQuiet(page, bucket, `token ${address} layout`);
    await assertLayout(page, { widths: [320, 768] });
  }
  const hrefs = await boardHrefs(page);
  for (const href of hrefs) {
    await page.goto(`/${href}`);
    await readyDetail(page);
    await checkQuiet(page, bucket, `${href} layout`);
    await assertLayout(page, { widths: [320, 768] });
  }
  await page.goto(`/#/token/${ADDR_MANY}/plugins/decompiler/${SELECTOR_ADD}/decompiled`);
  await readyCode(page);
  await checkQuiet(page, bucket, "decompiler layout");
  await assertLayout(page, { widths: [320, 768] });
});
