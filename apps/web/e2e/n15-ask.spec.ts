// N-15 Ask Muse e2e (UI v2 §1.4, W-8, Option A): the Ask field answers
// through /v1/chat with the checked-sentence envelope. The output names
// its source, carries the drop count and the advisory footer, and the
// deterministic result beside it never moves. Every REST response is
// route-mocked; no test reaches the network.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { assertLayout } from "./helpers/layoutContract.ts";

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
  pluginResults: [],
};

const PLUGINS_FIXTURE = {
  plugins: [],
};

function chatOkBody(): Record<string, unknown> {
  return {
    status: "ok",
    apiVersion: "v1",
    codeHash: "0xabc",
    chat: {
      kind: "ok",
      answers: ["The owner can stop chosen wallets from sending tokens.", "Pause and blacklist are owner-only."],
      droppedClaims: 2,
      provider: "test-adapter",
      modelId: "test-explain-1",
    },
  };
}

async function mockRest(
  page: Page,
  chat: "ok" | "not-configured" | "failed" = "ok",
  chatPosts: { count: number } | null = null,
): Promise<void> {
  await page.route("**/health", async (route) => {
    const body =
      chat === "not-configured"
        ? {
            status: "ok",
            apiVersion: "v1",
            assessment: { disabled: true },
            chat: { disabled: true },
            explain: { provider: "test-adapter", modelId: "test-explain-1" },
            costUnits: "placeholder-cost-unit",
          }
        : {
            status: "ok",
            apiVersion: "v1",
            assessment: { disabled: true },
            chat: { provider: "test-adapter", modelId: "test-explain-1" },
            costUnits: "placeholder-cost-unit",
          };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.route("**/v1/analyze*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "x-deepening-status": "ready" },
      body: JSON.stringify(ANALYZE_FIXTURE),
    });
  });
  await page.route("**/v1/plugins", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PLUGINS_FIXTURE) });
  });
  await page.route("**/v1/chat", async (route) => {
    if (chatPosts !== null) {
      chatPosts.count += 1;
    }
    if (chat === "failed") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ status: 500, code: "chat-failed", message: "Chat failed." }),
      });
      return;
    }
    const body =
      chat === "not-configured"
        ? { status: "ok", apiVersion: "v1", codeHash: "0xabc", chat: { kind: "not-configured" } }
        : chatOkBody();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

test("n15_ask_renders_sentences_dropped_count_and_advisory", async ({ page }) => {
  const chatPosts = { count: 0 };
  await mockRest(page, "ok", chatPosts);
  await page.goto(`/#/token/${ADDRESS}`);
  await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();
  const hero = page.locator('section[aria-label="Combined score"]');
  await expect(page.locator(".score-dial .num")).toHaveText("84");
  const before = await hero.innerText();
  // The Ask field carries the one-line consent and an enabling hint.
  await expect(page.getByLabel("Ask about this token")).toBeVisible();
  await expect(page.getByTestId("ask-submit")).toHaveAttribute("aria-disabled", "true");
  await page.getByLabel("Ask about this token").fill("Can the owner stop me selling?");
  await expect(page.getByTestId("ask-submit")).toHaveAttribute("aria-disabled", "false");
  await page.getByTestId("ask-submit").click();
  const output = page.getByTestId("muse-output");
  await expect(output.getByText("The owner can stop chosen wallets from sending tokens.").first()).toBeVisible();
  await expect(output.getByTestId("explain-dropped")).toContainText("2 unsupported claims dropped.");
  await expect(output.getByTestId("muse-advisory")).toContainText("Advisory. The score above did not change.");
  // The fulfilled answer proves the route ran, so the count is settled.
  expect(chatPosts.count).toBe(1);
  // Scores, gauges and hero text are byte-identical before and after Ask.
  expect(await hero.innerText()).toBe(before);
  // The toolbar, the Ask row and the matched tiles hold the layout
  // contract at phone widths. Desktop widths stay out of scope here: the
  // pre-existing signal-toggle hit-area pattern (S-120) measures under
  // 44 px at >=641 px and belongs to a later unit.
  await assertLayout(page, { widths: [320, 390] });
});

test("n15_ask_not_configured_hides_the_form", async ({ page }) => {
  await mockRest(page, "not-configured");
  await page.goto(`/#/token/${ADDRESS}`);
  await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Explain this result" })).toBeVisible();
  await expect(page.getByLabel("Ask about this token")).toHaveCount(0);
  await expect(page.getByTestId("ask-submit")).toHaveCount(0);
  // The deterministic score stands untouched beside the console: the
  // dial keeps the number and the band word (W-9 removed the repeated
  // score line).
  await expect(page.locator('section[aria-label="Combined score"] .score-dial .num')).toHaveText("84");
  await expect(page.locator('section[aria-label="Combined score"] .score-dial .bandtag')).toHaveText("HIGH");
});

test("n15_ask_failure_offers_retry_without_moving_score", async ({ page }) => {
  await mockRest(page, "failed");
  await page.goto(`/#/token/${ADDRESS}`);
  const hero = page.locator('section[aria-label="Combined score"]');
  await expect(page.locator(".score-dial .num")).toHaveText("84");
  const before = await hero.innerText();
  await page.getByLabel("Ask about this token").fill("Can the owner stop me selling?");
  await page.getByTestId("ask-submit").click();
  const output = page.getByTestId("muse-output");
  await expect(output).toContainText("The answer failed to load; the page result above stands.");
  await expect(output.getByRole("button", { name: "Try again" })).toBeVisible();
  expect(await hero.innerText()).toBe(before);
});
