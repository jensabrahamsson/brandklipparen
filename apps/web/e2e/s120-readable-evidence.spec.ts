// S-120: readable evidence. Claims render as one short summary with the
// raw detail on demand: a "Can change" chip, a truncated account chip
// with copy, and the locations inside a keyboard-operable disclosure.
// Checks without findings collapse to a single line, with one Explain
// trigger per finding group instead of one per PC row.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const ADDRESS = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const CHANGER = "0x5ab1e0000000000000000000000000000000beef";
// The account chip shows the EIP-55 form of the claim account.
const C_CHANGER = "0x5Ab1E0000000000000000000000000000000BeEF";

function longClaim(risk: string, selector: string, account: string): string {
  const head =
    risk === "rug-pull"
      ? "The contract code lets an account move funds out of the contract. This raises the rug-pull risk (severity high). "
      : risk === "honeypot"
        ? "The owner can stop you from selling. This raises the honeypot risk (severity high). "
        : "Launch mechanics favor one trade over another. This raises the bot-pump risk (severity medium). ";
  const pointers: string[] = [];
  for (let row = 0; row < 26; row += 1) {
    const offset = 500 + row;
    pointers.push(
      `selector ${selector} at byte offset ${offset} (decompiled line 50 reads "Unresolved_${selector.slice(2, 6)}()")`,
    );
  }
  return `${head}Can change: account ${account} can activate this later. Evidence: ${pointers.join("; ")}.`;
}

const SIGNALS = [
  {
    kind: "capability",
    id: "mintable",
    risk: "rug-pull",
    direction: "raises",
    severity: "high",
    evidence: [100, 101, 102, 103, 104].map((offset) => ({ selector: "0x40c10f19", offset })),
  },
  {
    kind: "capability",
    id: "owner-blacklist",
    risk: "honeypot",
    direction: "raises",
    severity: "high",
    evidence: [200, 201, 202, 203, 204].map((offset) => ({ selector: "0x44337ea1", offset })),
  },
  {
    kind: "capability",
    id: "pausable",
    risk: "bot-pump",
    direction: "raises",
    severity: "medium",
    evidence: [300, 301, 302, 303, 304].map((offset) => ({ selector: "0x8456cb59", offset })),
  },
];

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
  probabilities: { "rug-pull": 0.62, honeypot: 0.35, "bot-pump": 0.1 },
  score: 84,
  signals: SIGNALS,
  explanation: {
    kind: "template",
    templateVersion: "1.0.0",
    claims: [
      {
        text: longClaim("rug-pull", "0x40c10f19", CHANGER),
        signalLinks: ["mintable"],
        temporality: { kind: "can-change" },
      },
      {
        text: longClaim("honeypot", "0x44337ea1", CHANGER),
        signalLinks: ["owner-blacklist"],
        temporality: { kind: "can-change" },
      },
      {
        text: longClaim("bot-pump", "0x8456cb59", CHANGER),
        signalLinks: ["pausable"],
        temporality: { kind: "can-change" },
      },
    ],
  },
  cantTell: [{ question: "Who holds the liquidity?", dataSource: "liquidity locks" }],
  pluginResults: [
    ...["ownership", "pause", "blacklist", "mint", "transfer-fee", "transfer-limits", "sell-block", "transfer-hooks", "proxy-upgrade", "hard-to-analyze"].map(
      (slug) => ({
        pluginId: `dev.brandklipparen.${slug}`,
        pluginVersion: "1.0.0",
        outcome: "ok",
        findings: [],
      }),
    ),
    {
      pluginId: "dev.brandklipparen.capability",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [
        {
          id: "dev.brandklipparen.capability:call",
          title: "Contract can forward calls",
          payload: { capability: "call" },
          evidence: Array.from({ length: 10 }, (_, row) => ({
            selector: "0x12345678",
            offset: 1000 + row,
          })),
        },
      ],
    },
    {
      pluginId: "dev.brandklipparen.clone-match",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [
        {
          id: "dev.brandklipparen.clone-match:drain-template",
          title: "Bytecode matches a known trap template",
          payload: { similarity: 0.9, group: "drain-template", priorCount: 3 },
          evidence: Array.from({ length: 10 }, (_, row) => ({
            selector: "0x44337ea1",
            offset: 2000 + row,
          })),
        },
      ],
    },
    {
      pluginId: "dev.brandklipparen.decompiler",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [
        {
          id: "dev.brandklipparen.decompiler:0x70a08231",
          title: "Decompiled function balanceOf (0x70a08231)",
          payload: { selector: "0x70a08231", name: "balanceOf", cause: null, unresolvedJumps: 0 },
          evidence: Array.from({ length: 10 }, (_, row) => ({
            selector: "0x70a08231",
            offset: 3000 + row,
          })),
        },
      ],
    },
  ],
};

function registryEntry(
  id: string,
  displayName: string,
  description: string,
  max: "low" | "medium" | "high" | null = null,
): Record<string, unknown> {
  return {
    id,
    version: "1.0.0",
    displayName,
    description,
    ...(max === null
      ? {}
      : { frontmatter: { tags: ["holder"], audience: ["holder"], severity: { min: "low", max } } }),
  };
}

const PLUGINS_FIXTURE = {
  plugins: [
    registryEntry(
      "dev.brandklipparen.capability",
      "Capability detector",
      "Reports structural bytecode capabilities.",
      "high",
    ),
    registryEntry(
      "dev.brandklipparen.clone-match",
      "Clone-match detector",
      "Matches known trap templates.",
      "high",
    ),
    registryEntry(
      "dev.brandklipparen.decompiler",
      "Decompiler detector",
      "Reads functions back from bytecode.",
      "medium",
    ),
    ...[
      "ownership",
      "pause",
      "blacklist",
      "mint",
      "transfer-fee",
      "transfer-limits",
      "sell-block",
      "transfer-hooks",
      "proxy-upgrade",
      "hard-to-analyze",
    ].map((slug) =>
      registryEntry(
        `dev.brandklipparen.${slug}`,
        `${slug} detector`,
        "Reports nothing on this token.",
      ),
    ),
  ],
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
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PLUGINS_FIXTURE) });
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

test("s120_evidence_summaries_and_collapsed_plugins", async ({ page }) => {
  await mockRest(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#/token/${ADDRESS}`);
  await expect(page.getByRole("img", { name: /Combined score 84 of 100, High risk/ })).toBeVisible();
  const explanation = page.locator('section[aria-label="Why this score"]');
  await expect(explanation).toBeVisible();

  // Simple-mode height stays within budget on a wide viewport. The
  // board replaces the raw plugin dumps with 13 tiles, which still reads
  // taller than the 3400 estimate (measured 4149 at 1440): W-8 removed the
  // customize block and the AI order bar, so keep the 4300 cap only until
  // W-9 lands the hero strip, then re-tighten to 3400.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(height).toBeLessThanOrEqual(4300);

  // Few Explain triggers: one per group, never one per PC row.
  const triggers = await page.locator(".explain-trigger").count();
  expect(triggers).toBeLessThanOrEqual(40);

  // The first visible text of each claim fits in a short summary.
  for (const summary of await page.locator(".claim-text").all()) {
    expect(((await summary.textContent()) ?? "").length).toBeLessThanOrEqual(200);
  }

  // "Can change" renders as a chip; the account shows in full with
  // copy (S-134, P-1).
  await expect(explanation.getByText("can change it").first()).toBeVisible();
  await expect(explanation).not.toContainText("Owner can turn this on later");
  await expect(explanation).toContainText(C_CHANGER);

  // Evidence lives in a disclosure that opens and closes from the keyboard.
  const evidence = explanation.locator("details").first();
  await expect(evidence.locator("summary")).toContainText("Evidence · 5 places");
  const summary = evidence.locator("summary");
  await summary.focus();
  await expect(evidence).not.toHaveAttribute("open", "");
  await page.keyboard.press("Enter");
  await expect(evidence).toHaveAttribute("open", "");
  await expect(evidence).toContainText("0x40c10f19");
  await page.keyboard.press("Enter");
  await expect(evidence).not.toHaveAttribute("open", "");

  // The board shows one tile per detector with a status word; quiet
  // checks read as quiet tiles with a board summary, not a raw dump.
  const board = page.getByTestId("plugin-board");
  await expect(board.getByRole("heading", { name: "Checks" })).toBeVisible();
  await expect(board.getByTestId("plugin-board-summary")).toContainText("9 owner powers checked");
  await expect(board.locator("a[data-tile-slug]")).toHaveCount(13);
  await expect(board.getByText("Found · High", { exact: true })).toHaveCount(0);
  await expect(board.getByText("Found · Medium", { exact: true })).toHaveCount(0);
  const tools = board.locator("details.board-tools");
  await expect(tools).not.toHaveAttribute("open", "");
  await tools.locator("summary").click();
  await expect(tools).toHaveAttribute("open", "");
  // Tools read neutrally (R3 D-8): ran, with no severity.
  // Capability ran with "Ran"; clone-match reads "Match found"; the
  // readability check with no output reads "Readable"; the nine owner
  // checks read "Not found".
  await expect(board.getByText("Ran", { exact: true })).toHaveCount(1);
  await expect(board.getByText("Ran · 1 function")).toHaveCount(1);
  await expect(board.getByText("Not found", { exact: true })).toHaveCount(9);

  // Technical details show every structured offset.
  await expect(page.locator("details.customize")).toHaveCount(0);
  await page.locator("details.tech-details > summary", { hasText: "Technical details" }).click();
  const selectors = page.getByTestId("expert-selectors");
  await expect(selectors.locator("li")).toHaveCount(15);
  await expect(selectors).toContainText("0x64");
  await expect(selectors).toContainText("0x12c");
});
