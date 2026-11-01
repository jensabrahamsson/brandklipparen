// S-126: themed form controls, disabled and invalid states, non-text
// contrast. Control edges measure at least 3:1, no native control renders
// white, disabled buttons read as off, and an invalid address turns the
// field red with the message linked by aria-describedby.
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
  await page.route("**/v1/live-tokens", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ source: "etherscan", status: "live", updatedAt: 1700000000000, items: [] }),
    });
  });
}

test("s126_control_boundaries_and_invalid_state", async ({ page }) => {
  await mockRest(page);
  await page.goto("/#/");

  // The dark scheme is declared, so native controls match the theme.
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("dark");
  await expect(page.getByText("Waiting for new pairs…")).toBeVisible();

  // Control edges measure at least 3:1 against their backgrounds.
  const boundaries = await page.evaluate(() => {
    const parse = (value: string): readonly [number, number, number, number] => {
      const match = value.match(/[\d.]+/g) ?? [];
      return [Number(match[0] ?? 0), Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 1)];
    };
    const luminance = (rgb: readonly [number, number, number]): number => {
      const linear = rgb.map((channel) => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
    };
    const effectiveBackground = (element: Element): readonly [number, number, number] => {
      let current: Element | null = element;
      while (current !== null) {
        const background = parse(getComputedStyle(current).backgroundColor);
        if (background[3] > 0) {
          return [background[0], background[1], background[2]];
        }
        current = current.parentElement;
      }
      return [14, 17, 22];
    };
    const ratio = (edge: string, face: readonly [number, number, number]): number => {
      const a = luminance(parse(edge).slice(0, 3) as readonly [number, number, number]);
      const b = luminance(face);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const input = document.getElementById("address-search");
    const chip = document.querySelector(".chip");
    if (input === null || chip === null) {
      return { ok: false as const };
    }
    return {
      ok: true as const,
      inputRatio: ratio(getComputedStyle(input).borderColor, effectiveBackground(input)),
      chipRatio: ratio(getComputedStyle(chip).borderColor, effectiveBackground(chip)),
      inputBackground: getComputedStyle(input).backgroundColor,
    };
  });
  expect(boundaries.ok).toBe(true);
  if (boundaries.ok) {
    expect(boundaries.inputRatio).toBeGreaterThanOrEqual(3);
    expect(boundaries.chipRatio).toBeGreaterThanOrEqual(3);
    // No white native controls: the search field sits on the dark page.
    expect(boundaries.inputBackground).not.toContain("255");
  }

  // Submitting "hello world" turns the field border red, with the message
  // linked through aria-describedby and a visible error icon.
  await page.getByPlaceholder("Paste contract address, 0x…").fill("hello world");
  await page.getByRole("button", { name: "Analyze" }).click();
  const search = page.locator("#address-search");
  await expect(search).toHaveAttribute("aria-invalid", "true");
  expect(await search.evaluate((element) => getComputedStyle(element).borderColor)).toContain("255, 90, 82");
  const describedBy = await search.getAttribute("aria-describedby");
  expect(describedBy).toBe("address-error");
  await expect(page.locator(`#${describedBy ?? ""}`)).toContainText("Invalid address");
  await expect(page.locator(".field-error-icon")).toBeVisible();

  // Ghost buttons: the empty Clear control reads as off next to enabled ones.
  await page.goto(`/#/token/${ADDRESS}`);
  await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();
  const back = page.getByRole("button", { name: "← Search" });
  expect(await back.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  expect(await back.evaluate((element) => getComputedStyle(element).borderStyle)).toBe("solid");
  // The Expert switch follows the brand tone instead of system blue.
  const expert = page.getByTestId("expert-switch");
  expect(await expert.evaluate((element) => getComputedStyle(element).accentColor)).not.toContain("0, 122, 255");
  // R2-8: the Ask button always looks enabled, and the clear icon
  // is absent while the field is empty.
  const ask = page.getByTestId("ask-submit");
  await expect(ask).not.toHaveAttribute("aria-disabled", "true");
  expect(await ask.evaluate((element) => getComputedStyle(element).borderStyle)).not.toBe("dashed");
  expect(await ask.evaluate((element) => getComputedStyle(element).cursor)).toBe("pointer");
  await expect(page.getByTestId("ask-clear")).toHaveCount(0);
  await expect(page.getByTestId("ask-hint")).toHaveCount(0);

  // The gauge segment track keeps a 3:1 boundary on the card surface:
  // an unlit segment against the gauge card.
  const trackRatio = await page.evaluate(() => {
    const parse = (value: string): readonly [number, number, number] => {
      const match = value.match(/[\d.]+/g) ?? [];
      return [Number(match[0] ?? 0), Number(match[1] ?? 0), Number(match[2] ?? 0)];
    };
    const luminance = (rgb: readonly [number, number, number]): number => {
      const linear = rgb.map((channel) => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
    };
    const track = document.querySelector(".gauge .bar20 i:not(.lit)");
    const card = document.querySelector(".gauge");
    if (track === null || card === null) {
      return 0;
    }
    const edge = luminance(parse(getComputedStyle(track as Element).backgroundColor));
    const face = luminance(parse(getComputedStyle(card).backgroundColor));
    return (Math.max(edge, face) + 0.05) / (Math.min(edge, face) + 0.05);
  });
  expect(trackRatio).toBeGreaterThanOrEqual(3);

  // R2-6 removed the dead "Open in bytecode" shortcut: the merged card
  // carries evidence rows with names instead of a disabled shortcut.
  const summary = page.locator('section[aria-label="Why this score"] article details > summary').first();
  await summary.click();
  await expect(page.getByRole("button", { name: /Open .* in bytecode/ })).toHaveCount(0);
  await expect(page.locator('section[aria-label="Why this score"]')).not.toContainText("Open in bytecode");
});
