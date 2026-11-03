// U-13 loading and error (R3 D-16): layout shift from loading to
// result, the per-second elapsed counter, and the flat red error card
// with auto-retry countdown and Retry now. Every REST response is
// route-mocked; no live chain. Behavior only: rendered text, roles,
// measured layout shift and computed styles.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { assertLayout } from "./helpers/layoutContract.ts";

const ADDRESS = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function signal(id: string, risk: string, severity: string): Record<string, unknown> {
  return {
    kind: "capability",
    id,
    risk,
    direction: "raises",
    severity,
    evidence: [{ selector: "0x44337ea1", offset: 2623 }],
  };
}

function finding(id: string, title: string, payload: Record<string, unknown>): Record<string, unknown> {
  return { id, title, payload, evidence: [{ selector: "0x5c975abb", offset: 41 }] };
}

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
  probabilities: { "rug-pull": 0.35, honeypot: 0.25, "bot-pump": 0.22 },
  score: 29,
  signals: [
    signal("owner-blacklist", "honeypot", "medium"),
    signal("mintable", "rug-pull", "medium"),
    signal("fee-on-transfer", "bot-pump", "low"),
  ],
  explanation: {
    kind: "template",
    templateVersion: "1.0.0",
    claims: [
      {
        text: "The owner can block chosen wallets.",
        signalLinks: ["owner-blacklist"],
        temporality: { kind: "can-change" },
      },
    ],
  },
  cantTell: [
    { question: "Who holds the liquidity?", dataSource: "liquidity locks" },
    { question: "Who are the largest holders?", dataSource: "holder list" },
  ],
  pluginResults: [
    {
      pluginId: "dev.brandklipparen.pause",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [finding("dev.brandklipparen.pause:pause", "Pause", { mode: "pause" })],
    },
    {
      pluginId: "dev.brandklipparen.blacklist",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [finding("dev.brandklipparen.blacklist:block", "Blacklist", { mode: "block" })],
    },
    {
      pluginId: "dev.brandklipparen.transfer-limits",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [finding("dev.brandklipparen.transfer-limits:limits", "Transfer limits", { fact: "limits", proof: "extended" })],
    },
    { pluginId: "dev.brandklipparen.mint", pluginVersion: "1.0.0", outcome: "ok", findings: [] },
    {
      pluginId: "dev.brandklipparen.decompiler",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [finding("dev.brandklipparen.decompiler:fn", "pause()", { selectors: 32 })],
    },
  ],
};

const HEALTH_DISABLED = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  costUnits: "placeholder-cost-unit",
};

function pluginEntry(id: string, displayName: string): Record<string, unknown> {
  return {
    id,
    version: "1.0.0",
    displayName,
    description: "Test detector.",
    outputSchema: { type: "array" },
  };
}

const PLUGINS_FIXTURE = {
  plugins: [
    pluginEntry("dev.brandklipparen.pause", "Pause detector"),
    pluginEntry("dev.brandklipparen.blacklist", "Blacklist detector"),
    pluginEntry("dev.brandklipparen.transfer-limits", "Transfer limits detector"),
    pluginEntry("dev.brandklipparen.mint", "Mint detector"),
    pluginEntry("dev.brandklipparen.decompiler", "Decompiler"),
    pluginEntry("dev.brandklipparen.ownership", "Ownership detector"),
  ],
};

const LIVE_EMPTY = {
  source: "test",
  status: "live",
  updatedAt: 1700000000000,
  items: [],
};

async function mockBase(page: Page): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH_DISABLED) });
  });
  await page.route("**/v1/plugins", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PLUGINS_FIXTURE) });
  });
  await page.route("**/v1/live-tokens", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(LIVE_EMPTY) });
  });
}

type ShiftRecord = {
  readonly value: number;
  readonly sources: readonly string[];
};

async function installShiftProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __shifts: ShiftRecord[] }).__shifts = [];
    const label = (node: Node | null): string => {
      if (node === null) {
        return "null";
      }
      const element = node as HTMLElement;
      const testid = element.getAttribute?.("data-testid") ?? "";
      const aria = element.getAttribute?.("aria-label") ?? "";
      const cls = typeof element.className === "string" ? element.className.split(" ").slice(0, 2).join(".") : "";
      return `${element.tagName?.toLowerCase() ?? "?"}${cls === "" ? "" : `.${cls}`}${testid === "" ? "" : `#${testid}`}${aria === "" ? "" : `[${aria}]`}`;
    };
    new PerformanceObserver((list) => {
      const target = window as unknown as { __shifts: ShiftRecord[] };
      for (const entry of list.getEntries()) {
        const shift = entry as LayoutShift;
        if (!shift.hadRecentInput) {
          target.__shifts.push({
            value: shift.value,
            sources: shift.sources.map(
              (source) =>
                `${label(source.node)} dx=${Math.round(source.currentRect.left - source.previousRect.left)} dy=${Math.round(source.currentRect.top - source.previousRect.top)}`,
            ),
          });
        }
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
}

async function shiftSum(page: Page): Promise<number> {
  return page.evaluate(() => {
    const shifts = (window as unknown as { __shifts: ShiftRecord[] }).__shifts;
    return shifts.reduce((total, record) => total + record.value, 0);
  });
}

async function resetShifts(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __shifts: number[] }).__shifts = [];
  });
}

async function counterSeconds(page: Page): Promise<number> {
  const text = await page.evaluate(
    () => document.querySelector('[data-testid="loading-status"] > span[aria-hidden="true"]')?.textContent ?? "",
  );
  const match = text.match(/(\d+) s/);
  return match === null ? -1 : Number.parseInt(match[1] as string, 10);
}

test("u13_loading_to_result_shift_stays_small_and_counter_ticks", async ({ page }) => {
  await installShiftProbe(page);
  await mockBase(page);
  await page.route("**/v1/analyze*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3500));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "x-deepening-status": "pending" },
      body: JSON.stringify(ANALYZE_FIXTURE),
    });
  });
  let firstVisit = true;
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    if (firstVisit) {
      await page.goto("/#/token/" + ADDRESS);
      firstVisit = false;
    } else {
      // Same hash URL twice is a no-op navigation: reload instead so
      // the analysis fetch (and the loading state) runs again.
      await page.reload();
    }
    const status = page.getByTestId("loading-status");
    await expect(status).toBeVisible();
    await resetShifts(page);
    // The counter is text only: no animation on the status line.
    const animation = await status.evaluate((node) => getComputedStyle(node).animationName);
    expect(animation, `status line animation at ${width}px`).toBe("none");
    const first = await counterSeconds(page);
    expect(first, `counter starts near zero at ${width}px`).toBeGreaterThanOrEqual(0);
    await page.waitForTimeout(2200);
    const second = await counterSeconds(page);
    expect(second, `counter ticks once per second at ${width}px`).toBeGreaterThan(first);
    await expect(page.getByRole("img", { name: /Combined score 29 of 100/ })).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(1200);
    const cls = await shiftSum(page);
    expect(cls, `CLS loading to result at ${width}px`).toBeLessThan(0.05);
  }
});

test("u13_slow_scan_sets_expectations_after_eight_seconds", async ({ page }) => {
  await mockBase(page);
  await page.route("**/v1/analyze*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 9500));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "x-deepening-status": "pending" },
      body: JSON.stringify(ANALYZE_FIXTURE),
    });
  });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/#/token/" + ADDRESS);
  await expect(page.getByTestId("loading-status")).toBeVisible();
  await expect(page.getByTestId("loading-status")).toContainText("Still reading. First scan takes ~15 s.", { timeout: 15000 });
  await expect(page.getByRole("img", { name: /Combined score 29 of 100/ })).toBeVisible({ timeout: 15000 });
});

test("u13_error_card_retries_with_countdown_and_retry_now", async ({ page }) => {
  await mockBase(page);
  let calls = 0;
  await page.route("**/v1/analyze*", async (route) => {
    calls += 1;
    if (calls === 1) {
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ code: "rate-limited", message: "Raw-Backend-Boom-9f3" }),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "x-deepening-status": "pending" },
        body: JSON.stringify(ANALYZE_FIXTURE),
      });
    }
  });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/#/token/" + ADDRESS);
  const card = page.getByTestId("token-error");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("role", "alert");
  await expect(card).toContainText("Busy.");
  await expect(card).toContainText("Retry now");
  // No status code and none of the raw backend message.
  await expect(card).not.toContainText("429");
  await expect(card).not.toContainText("Raw-Backend-Boom-9f3");
  // Flat red 1 px border with no glow.
  expect(await card.evaluate((node) => getComputedStyle(node).borderTopWidth)).toBe("1px");
  expect(await card.evaluate((node) => getComputedStyle(node).borderTopColor)).toBe("rgb(255, 90, 82)");
  expect(await card.evaluate((node) => getComputedStyle(node).boxShadow)).toBe("none");
  // The countdown ticks down once per second.
  const countdownText = async (): Promise<number> => {
    const text = (await card.innerText()).match(/Retrying automatically in (\d+) s/);
    return text === null ? -1 : Number.parseInt(text[1] as string, 10);
  };
  await expect(card).toContainText(/Retrying automatically in \d+ s\./);
  const before = await countdownText();
  expect(before).toBeGreaterThan(0);
  await page.waitForTimeout(1300);
  const after = await countdownText();
  expect(after).toBeLessThan(before);
  // Retry now refetches and lands the result.
  await card.getByRole("button", { name: "Retry now" }).click();
  await expect(page.getByRole("img", { name: /Combined score 29 of 100/ })).toBeVisible({ timeout: 15000 });
});

test("u13_loading_and_error_states_hold_the_layout_contract", async ({ page }) => {
  await mockBase(page);
  await page.route("**/v1/analyze*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 25000));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "x-deepening-status": "pending" },
      body: JSON.stringify(ANALYZE_FIXTURE),
    });
  });
  await page.goto("/#/token/" + ADDRESS);
  await expect(page.getByTestId("loading-status")).toBeVisible();
  await expect(page.locator("section.loading-frame")).toBeVisible();
  await assertLayout(page);
});
