// Native disclosure with remembered state: keyboard toggling flips the
// element itself, the toggle handler persists it, and the remembered
// state survives reload. Programmatic toggles stay in sync the same way.
import { expect, test } from "@playwright/test";

const ADDRESS = "0x5ab1e0000000000000000000000000000000e003";

const ANALYZE = {
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
  probabilities: { "rug-pull": 0.1, honeypot: 0.1, "bot-pump": 0.1 },
  score: 10,
  signals: [],
  explanation: { kind: "template", templateVersion: "1.0.0", claims: [] },
  cantTell: [],
};

const PERSONALIZE_STATUS = {
  status: "ok",
  apiVersion: "v1",
  personalize: { provider: "hosted-open-weights", modelId: "meta-models/muse-spark-open-1026" },
};

test("details_toggle_keyboard_and_programmatic_persist_across_reload", async ({ page }) => {
  await page.route("**/health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", apiVersion: "v1", assessment: { disabled: true }, costUnits: "x" }),
    });
  });
  await page.route("**/v1/analyze*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "x-deepening-status": "pending" },
      body: JSON.stringify(ANALYZE),
    });
  });
  await page.route("**/v1/plugins", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plugins: [] }) });
  });
  await page.route("**/v1/personalize/status", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PERSONALIZE_STATUS) });
  });

  // Note: hash URLs build by concatenation (see token-symbol-heading).
  await page.goto("/#/token/" + ADDRESS);
  const customize = page.locator("details.customize");
  await expect(customize).toBeVisible();
  await expect.poll(() => customize.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);

  // Keyboard Enter toggles the element itself open.
  await customize.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => customize.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(true);
  await expect(customize.getByRole("group", { name: "Detail" })).toBeVisible();

  // Remembered state survives reload.
  await page.reload();
  const reopened = page.locator("details.customize");
  await expect.poll(() => reopened.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(true);

  // A programmatic toggle stays in sync and persists too.
  await reopened.evaluate((element) => {
    (element as HTMLDetailsElement).open = false;
  });
  await expect.poll(() => reopened.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
  await page.reload();
  const reclosed = page.locator("details.customize");
  await expect.poll(() => reclosed.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
});
