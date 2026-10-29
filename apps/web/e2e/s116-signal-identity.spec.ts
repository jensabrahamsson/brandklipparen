// S-116: signals have unique keys and human titles. The mocked response
// carries 7 signals with only 3 distinct ids (6 share 2 ids), like the
// audited live token. One click must toggle exactly one signal, DOM ids
// must be unique, and no title, gauge reason or recent-row text may show
// hex. Every signal's template line must mention its own risk kind.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const ADDRESS = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const HEX_ID = `0x${"ab".repeat(32)}`;

function signal(
  id: string,
  risk: "rug-pull" | "honeypot" | "bot-pump",
  severity: "low" | "medium" | "high",
  selector: string,
  offset: number | null,
): Record<string, unknown> {
  return { kind: "capability", id, risk, direction: "raises", severity, evidence: [{ selector, offset }] };
}

function claim(text: string, signalLinks: readonly string[]): Record<string, unknown> {
  return { text, signalLinks, temporality: { kind: "can-change" } };
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
  probabilities: { "rug-pull": 0.2, honeypot: 0.35, "bot-pump": 0.1 },
  score: 24,
  signals: [
    signal("owner-blacklist", "honeypot", "high", "0x44337ea1", 2623),
    signal("owner-blacklist", "honeypot", "high", "0x44337ea1", 2700),
    signal("owner-blacklist", "honeypot", "medium", "0x12345678", 100),
    signal("mintable", "rug-pull", "high", "0x40c10f19", 500),
    signal("mintable", "rug-pull", "low", "0x40c10f19", null),
    signal("mintable", "rug-pull", "medium", "0x70a08231", 42),
    signal(HEX_ID, "bot-pump", "medium", "0xabcdef01", 7),
  ],
  explanation: {
    kind: "template",
    templateVersion: "1.0.0",
    claims: [
      claim("The owner can stop you from selling. This raises the honeypot risk (severity high).", ["owner-blacklist"]),
      // Shared claim: the old id-keyed lookup hands this honeypot sentence
      // to rug-pull signals as well.
      claim("The owner can stop you from selling. This raises the honeypot risk (severity high).", [
        "owner-blacklist",
        "mintable",
      ]),
      claim("The owner can stop you from selling. This raises the honeypot risk (severity medium).", [
        "owner-blacklist",
      ]),
      claim("The contract code lets an account move funds out of the contract. This raises the rug-pull risk (severity high).", [
        "mintable",
      ]),
      claim("The contract code lets an account move funds out of the contract. This raises the rug-pull risk (severity low).", [
        "mintable",
      ]),
      claim("The contract code lets an account move funds out of the contract. This raises the rug-pull risk (severity medium).", [
        "mintable",
      ]),
      claim("Launch mechanics favor one trade over another. This raises the bot-pump risk (severity medium).", [HEX_ID]),
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
}

test("s116_duplicate_signal_ids_toggle_one_each", async ({ page }) => {
  await mockRest(page);
  await page.goto(`/#/token/${ADDRESS}`);
  const section = page.locator('section[aria-label="Signals"]');
  await expect(section).toBeVisible();
  const toggles = section.locator("article > button[aria-expanded]");
  await expect(toggles).toHaveCount(7);

  // Collapse whatever starts open, then open exactly the second signal.
  for (const toggle of await toggles.all()) {
    if ((await toggle.getAttribute("aria-expanded")) === "true") {
      await toggle.click();
    }
  }
  await expect(section.locator('article > button[aria-expanded="true"]')).toHaveCount(0);
  await toggles.nth(1).click();
  await expect(section.locator('article > button[aria-expanded="true"]')).toHaveCount(1);

  // No duplicate DOM ids anywhere on the page.
  const duplicates = await page.evaluate(() => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    document.querySelectorAll("[id]").forEach((element) => {
      if (seen.has(element.id)) {
        dupes.push(element.id);
      } else {
        seen.add(element.id);
      }
    });
    return dupes;
  });
  expect(duplicates).toEqual([]);

  // No hex in titles, gauge reasons or recent rows.
  const hex = /0x[0-9a-f]{16,}/i;
  const titles = await section.locator("article > button").allTextContents();
  expect(titles.length).toBe(7);
  for (const title of titles) {
    expect(title).not.toMatch(hex);
  }
  const gauges = page.locator(".gauges section");
  await expect(gauges).toHaveCount(3);
  for (const gauge of await gauges.all()) {
    const reason = (await gauge.locator("p").last().textContent()) ?? "";
    expect(reason).not.toMatch(hex);
  }
  await page.goto("/");
  const recentTop = await page.locator(".recent-top").allTextContents();
  expect(recentTop.length).toBeGreaterThan(0);
  for (const text of recentTop) {
    expect(text).not.toMatch(hex);
  }

  // Each signal's own template line mentions its own risk kind.
  await page.goto(`/#/token/${ADDRESS}`);
  await expect(section).toBeVisible();
  for (const article of await section.locator("article").all()) {
    const meta = (await article.locator("p.quiet").first().textContent()) ?? "";
    const risk = meta.split("·")[0]?.trim() ?? "";
    expect(["rug-pull", "honeypot", "bot-pump"]).toContain(risk);
    const template = (await article.getByText(/^Template:/).textContent()) ?? "";
    expect(template.toLowerCase()).toContain(risk);
  }
});
