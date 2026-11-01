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
    await expect(header).toContainText("Honey 91%");
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
    await expect(page.getByRole("switch", { name: "Expert view" })).toBeVisible();
    await expect(page.getByTestId("expert-switch")).toHaveAttribute("aria-checked", "false");
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

    // The Expert switch persists in local storage and restores on reload
    // (K-034, covered in full by adaptive.spec.ts).
    await page.getByRole("switch", { name: "Expert view" }).click();
    await expect(page.getByTestId("expert-detail")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("brandklipparen-ui-mode")))
      .toBe("expert");
    await page.reload();
    await expect(page.getByTestId("expert-switch")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("expert-detail")).toBeVisible();
  }
});
