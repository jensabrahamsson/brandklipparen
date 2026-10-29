// S-118: verdict-first token header. The token page leads with a header
// card (h1, score ring, truthful headline, probability mini row) and the
// Detail / AI / section / priority controls live in a collapsed,
// session-remembered "Customize view" disclosure after the tabs.
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
      body: JSON.stringify({ mapping: { disabled: true } }),
    });
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
    await page.evaluate(() => sessionStorage.removeItem("brandklipparen-customize-open"));
    await page.goto(`/#/token/${ADDRESS}`);
    const header = page.locator('section[aria-label="Combined score"]');
    await expect(header).toBeVisible();

    // Ring, number and headline are fully visible without scrolling.
    for (const target of [
      page.getByRole("img", { name: /Combined score 84 of 100, High risk/ }),
      header.getByText("84 High", { exact: true }),
      header.locator(".risk-meaning"),
    ]) {
      const box = await target.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(viewport.height);
    }
    await expect(header.locator("h1")).toContainText("0xdead");
    await expect(header).toContainText("Honey 91%");

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

    // Detail, AI personalize, section picker and priorities all live in
    // the collapsed Customize view.
    const customize = page.locator("details.customize");
    await expect(customize).toBeVisible();
    await expect(customize.locator("summary")).toContainText("Customize view");
    expect(await customize.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
    await expect(customize.locator('input[name="ui-mode"]')).toHaveCount(2);
    await expect(customize.locator('[data-testid="ai-personalize-toggle"]')).toHaveCount(1);
    await expect(customize.locator("legend")).toContainText("Choose sections");
    await expect(customize.locator('[data-testid="priorities-field"]')).toHaveCount(1);

    // The score Explain is within 3 Tab stops after Back.
    await page.getByRole("button", { name: "← Back to search" }).focus();
    let reached = false;
    for (let stop = 0; stop < 3; stop += 1) {
      await page.keyboard.press("Tab");
      const testId = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
      if (testId === "explain-score:combined") {
        reached = true;
        break;
      }
    }
    expect(reached).toBe(true);

    // The panel remembers its state for the session.
    await customize.locator("summary").click();
    expect(await customize.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(true);
    const stored = await page.evaluate(() => sessionStorage.getItem("brandklipparen-customize-open"));
    expect(stored).toBe("1");
    await page.reload();
    await expect(page.locator("details.customize")).toBeVisible();
    expect(await page.locator("details.customize").evaluate((element) => (element as HTMLDetailsElement).open)).toBe(
      true,
    );
  }
});
