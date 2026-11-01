// VS-2 "Explain this code": one request per button press, read-along
// notes beside the code, cross-function chips, and honest failure
// states. Every REST response is route-mocked; no test reaches the
// network.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { assertLayout } from "./helpers/layoutContract.ts";

const ADDRESS = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const ADD = "0x44337ea1";
const TRANSFER = "0xa9059cbb";
const ENTRY_PC = 200;

const ADD_LINES = [
  "function addBlackList(address a0) {",
  "  require(msg.value == 0);",
  "  require(msg.sender == owner);",
  "  isBlackListed[a0] = true;",
  "  emit AddedBlackList(a0);",
  "}",
];

const TRANSFER_LINES = [
  "function transfer(address a0, uint256 a1) {",
  "  require(!isBlackListed[msg.sender]);",
  "  balances[msg.sender] -= a1;",
  "  balances[a0] += a1;",
  "  emit Transfer(msg.sender, a0, a1);",
  "}",
];

const ANALYZE_FIXTURE = {
  kind: "assessed",
  target: ADDRESS,
  block: 18000000,
  tokenSymbol: "USDT",
  tokenName: "Tether USD",
  proxy: { kind: "none" },
  codeHash: "0xabc",
  modelVersion: "1.0.1",
  artifactChecksum: "checksum",
  indexVersion: "1.0.0",
  templateVersion: "1.0.0",
  assessedAt: 1700000000000,
  probabilities: { "rug-pull": 0.35, honeypot: 0.25, "bot-pump": 0.22 },
  score: 29,
  signals: [],
  explanation: { kind: "template", templateVersion: "1.0.0", claims: [] },
  cantTell: [],
  pluginResults: [
    {
      pluginId: "dev.brandklipparen.blacklist",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [
        {
          id: "dev.brandklipparen.blacklist:blacklist",
          title: "Blocked wallets",
          payload: { feature: "blacklist" },
          evidence: [{ selector: ADD, offset: ENTRY_PC }],
        },
      ],
    },
    {
      pluginId: "dev.brandklipparen.decompiler",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [
        {
          id: `dev.brandklipparen.decompiler:${ADD}`,
          title: `Decompiled function addBlackList (${ADD})`,
          payload: {
            selector: ADD,
            name: "addBlackList",
            signature: "addBlackList(address)",
            entryPc: ENTRY_PC,
            startPc: ENTRY_PC,
            endPc: 3057,
            annotations: [],
            cause: null,
            unresolvedJumps: 0,
          },
          evidence: [{ selector: ADD, offset: ENTRY_PC }],
        },
        {
          id: `dev.brandklipparen.decompiler:${TRANSFER}`,
          title: `Decompiled function transfer (${TRANSFER})`,
          payload: {
            selector: TRANSFER,
            name: "transfer",
            signature: "transfer(address,uint256)",
            entryPc: 320,
            startPc: 320,
            endPc: 900,
            annotations: [],
            cause: null,
            unresolvedJumps: 0,
          },
          evidence: [{ selector: TRANSFER, offset: 320 }],
        },
      ],
    },
    ...[
      "ownership",
      "pause",
      "mint",
      "transfer-fee",
      "transfer-limits",
      "sell-block",
      "transfer-hooks",
      "proxy-upgrade",
      "capability",
      "clone-match",
      "hard-to-analyze",
    ].map((slug) => ({
      pluginId: `dev.brandklipparen.${slug}`,
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [],
    })),
  ],
};

function registryEntry(id: string, weight: number): Record<string, unknown> {
  const short = id.split(".").pop() ?? id;
  return {
    id,
    kind: "detector",
    weight,
    version: "1.0.0",
    displayName: `${short} detector`,
    description: `Reports ${short}.`,
    frontmatter: { tags: ["holder"], audience: ["holder"], severity: { min: "low", max: "high" } },
  };
}

const PLUGINS_FIXTURE = {
  plugins: [
    registryEntry("dev.brandklipparen.blacklist", 3),
    registryEntry("dev.brandklipparen.decompiler", 0),
    ...[
      "ownership",
      "pause",
      "mint",
      "transfer-fee",
      "transfer-limits",
      "sell-block",
      "transfer-hooks",
      "proxy-upgrade",
      "capability",
      "clone-match",
      "hard-to-analyze",
    ].map((slug) => registryEntry(`dev.brandklipparen.${slug}`, 1)),
  ],
};

const HEALTH = {
  status: "ok",
  apiVersion: "v1",
  assessment: { disabled: true },
  explainCode: { provider: "meta-model-api", modelId: "muse-spark-1.3" },
  costUnits: "placeholder-cost-unit",
};

function snippetFor(selector: string): Array<Record<string, unknown>> {
  const texts = selector.toLowerCase() === TRANSFER.toLowerCase() ? TRANSFER_LINES : ADD_LINES;
  return texts.map((text, index) => ({
    selector,
    lineNumber: index + 1,
    text,
    pcs: index === 3 ? [ENTRY_PC] : [],
  }));
}

function explainOk(): Record<string, unknown> {
  return {
    status: "ok",
    apiVersion: "v1",
    codeHash: "0xabc",
    selector: ADD,
    view: "decompiled",
    explainCode: {
      kind: "ok",
      summary: [
        {
          text: "Only the owner can call this function, and no one else can.",
          cites: [{ kind: "line", selector: ADD, view: "decompiled", line: 3 }],
        },
      ],
      notes: [
        { lines: [3, 4], text: "The owner check happens here.", cites: [] },
        {
          lines: [4],
          text: "The block list gains one wallet.",
          cites: [{ kind: "evidence", id: "dev.brandklipparen.blacklist:blacklist" }],
        },
        {
          lines: [6],
          text: "This emits the change that transfer() later reads.",
          cites: [{ kind: "line", selector: TRANSFER, view: "decompiled", line: 2 }],
        },
      ],
      droppedClaims: 0,
      provider: "meta-model-api",
      modelId: "muse-spark-1.3",
    },
  };
}

type ExplainMode = "ok" | "invalid-output";

async function mockRest(page: Page, mode: ExplainMode, counter: { posts: number }): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HEALTH) });
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
  await page.route("**/v1/snippet*", async (route) => {
    const selector = new URL(route.request().url()).searchParams.get("selector") ?? ADD;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "ok",
        apiVersion: "v1",
        codeHash: "0xabc",
        snippet: { selector, entryPc: ENTRY_PC, lines: snippetFor(selector) },
      }),
    });
  });
  await page.route("**/v1/source*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "ok",
        apiVersion: "v1",
        codeHash: "0xabc",
        source: { status: "none", provider: null, match: null, compiler: null, files: [], functions: [] },
      }),
    });
  });
  await page.route("**/v1/explain-code", async (route) => {
    counter.posts += 1;
    const body = mode === "ok" ? explainOk() : { status: "ok", apiVersion: "v1", explainCode: { kind: "invalid-output" } };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

async function openExplained(page: Page, counter: { posts: number }): Promise<void> {
  await mockRest(page, "ok", counter);
  await page.goto(`/#/token/${ADDRESS}/plugins/decompiler/${ADD}/decompiled`);
  await page.getByTestId(`explain-code-${ADD}`).click();
  await expect(page.getByText("Muse explanation ready: 1 summary, 3 notes.")).toHaveCount(1);
  await expect(page.locator(".muse-note")).toHaveCount(3);
}

test("explain posts once per press and restores on reopen with no request", async ({ page }) => {
  const counter = { posts: 0 };
  await openExplained(page, counter);
  expect(counter.posts).toBe(1);

  // The consent line is linked from the button, not repeated on reopen.
  const describedBy = await page.getByTestId(`explain-code-${ADD}`).getAttribute("aria-describedby");
  expect(describedBy).not.toBeNull();
  await expect(page.locator(`[id="${describedBy}"]`)).toContainText("One request.");

  // Collapse and re-open the row: the stored overlay returns with no
  // new request and no consent repeat.
  await page.getByTestId(`decompiler-row-${ADD}`).click();
  await expect(page.getByTestId(`explain-code-${ADD}`)).toHaveCount(0);
  await page.getByTestId(`decompiler-row-${ADD}`).click();
  await expect(page.getByText("Muse explanation ready: 1 summary, 3 notes.")).toHaveCount(1);
  expect(counter.posts).toBe(1);
});

test("the footer stands and the deterministic header and lamps are untouched", async ({ page }) => {
  const counter = { posts: 0 };
  await mockRest(page, "ok", counter);
  await page.goto(`/#/token/${ADDRESS}/plugins/decompiler/${ADD}/decompiled`);
  // Let the deterministic header typewriter and the code lines settle
  // before snapshotting: both type on arrival and are untouched by Muse.
  await expect(page.locator(".code-line").first()).toBeVisible();
  await expect(page.locator(".detail-sentence .cursor")).toHaveCount(0);
  const headBefore = await page.locator(".detail-head").innerHTML();
  const lampsBefore = await page.locator(".code-lamp").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("aria-label") ?? ""),
  );
  await page.getByTestId(`explain-code-${ADD}`).click();
  await expect(page.getByText("Muse explanation ready: 1 summary, 3 notes.")).toHaveCount(1);
  await expect(page.getByText("AI explanation · does not change the score").first()).toBeVisible();
  const headAfter = await page.locator(".detail-head").innerHTML();
  expect(headAfter).toBe(headBefore);
  const lampsAfter = await page.locator(".code-lamp").evaluateAll((elements) =>
    elements
      .map((element) => element.getAttribute("aria-label") ?? "")
      .filter((label) => !label.startsWith("Muse note")),
  );
  expect(lampsAfter).toEqual(lampsBefore);
});

test("a cross-function chip expands transfer and focuses its second line", async ({ page }) => {
  const counter = { posts: 0 };
  await openExplained(page, counter);
  await page.getByRole("button", { name: "Muse note in transfer() L2" }).click();
  await expect(page.getByTestId(`decompiler-row-${TRANSFER}`)).toHaveAttribute("aria-expanded", "true");
  await expect
    .poll(async () => page.evaluate(() => document.activeElement?.id ?? ""), { timeout: 5000 })
    .toContain("-line-2");
  expect(counter.posts).toBe(1);
});

test("invalid output names the cause with no notes rendered", async ({ page }) => {
  const counter = { posts: 0 };
  await mockRest(page, "invalid-output", counter);
  await page.goto(`/#/token/${ADDRESS}/plugins/decompiler/${ADD}/decompiled`);
  await page.getByTestId(`explain-code-${ADD}`).click();
  await expect(page.getByText("cited code that isn't there")).toBeVisible();
  await expect(page.locator(".muse-note")).toHaveCount(0);
  await expect(page.getByText("AI explanation · does not change the score").first()).toBeVisible();
  // Trying again spends another request knowingly.
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("cited code that isn't there")).toBeVisible();
  expect(counter.posts).toBe(2);
});

test("notes interleave at 390 and stand in the margin at 1600", async ({ page }) => {
  const counter = { posts: 0 };
  await openExplained(page, counter);

  await page.setViewportSize({ width: 390, height: 844 });
  // Each note falls between its lines: after its last line, before the
  // next line of code. The width switch remounts the pane (tabs), so
  // wait for the rows to settle: bounding boxes do not retry.
  await expect(page.locator(".code-pane ol.code > li.code-line")).toHaveCount(6);
  await expect(page.locator(".code-note-row")).toHaveCount(3);
  // One synchronous snapshot: the X-1 expands are still settling, so two
  // separate reads could straddle a frame and invert the order.
  const { lines, notes } = await page.evaluate(() => {
    const tops = (selector: string): number[] =>
      Array.from(document.querySelectorAll(selector), (element) => element.getBoundingClientRect().y);
    return {
      lines: tops(".code-pane ol.code > li.code-line"),
      notes: tops(".code-note-row"),
    };
  });
  expect(notes).toHaveLength(3);
  expect(lines.length).toBeGreaterThanOrEqual(6);
  // Notes mount after lines 4, 4 and 6: each sits below its range.
  expect(notes[0]!).toBeGreaterThan(lines[3]!);
  expect(notes[0]!).toBeLessThan(lines[4]!);
  expect(notes[1]!).toBeGreaterThan(lines[3]!);
  expect(notes[1]!).toBeLessThan(lines[4]!);
  expect(notes[2]!).toBeGreaterThan(lines[5]!);

  // At 1600 the notes stand in the margin: no interleaved rows, and no
  // code line changes height compared with before the explanation.
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`/#/token/${ADDRESS}/plugins/decompiler/${ADD}/decompiled`);
  // Same-URL hash navigation keeps the mounted 390 tabs view: the flip
  // to side-by-side panes (and interleaved rows to margin notes) lands
  // asynchronously, so settle before snapshotting line heights.
  await expect(page.locator(".code-panes")).toHaveCount(1);
  await expect(page.locator(".code-note-row")).toHaveCount(0);
  await expect(page.locator(".code-pane ol.code > li.code-line").first()).toBeVisible();
  const before = await page.locator(".code-pane ol.code > li.code-line").evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().height),
  );
  await page.getByTestId(`explain-code-${ADD}`).click();
  await expect(page.getByText("Muse explanation ready: 1 summary, 3 notes.")).toHaveCount(1);
  await expect(page.locator(".code-note-row")).toHaveCount(0);
  await expect(page.locator(".code-margin-note")).toHaveCount(3);
  const after = await page.locator(".code-pane ol.code > li.code-line").evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().height),
  );
  expect(after).toEqual(before);
});

test("any key press during the read-along finishes everything at once", async ({ page }) => {
  const counter = { posts: 0 };
  await mockRest(page, "ok", counter);
  await page.goto(`/#/token/${ADDRESS}/plugins/decompiler/${ADD}/decompiled`);
  await page.getByTestId(`explain-code-${ADD}`).click();
  // While the summary is still typing, the last note is nowhere yet.
  // (.first(): the read-along keeps a screen-reader twin beside the
  // typed copy, so one text matches two spans.)
  await expect(page.getByText("Only the owner can call this function").first()).toBeVisible();
  await expect(page.getByText("This emits the change that transfer() later reads.")).toHaveCount(0);
  await page.keyboard.press("Escape");
  // The key press completes the typing: every note is present at once.
  await expect(page.getByText("This emits the change that transfer() later reads.").first()).toBeVisible();
  await expect(page.locator(".muse-note")).toHaveCount(3);
  // Nothing the read-along started is still running: finished one-shots
  // keep their end state, and page chrome outside this scope keeps its
  // approved loops, so only running/pending animations scoped to the
  // explained code must drain.
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          let running = 0;
          for (const animation of document.getAnimations()) {
            if (animation.playState !== "running" && animation.playState !== "pending") {
              continue;
            }
            const target = (animation.effect as unknown as { target?: unknown } | null)?.target;
            if (target instanceof Element && target.closest(".detail-decompiler") !== null) {
              running += 1;
            }
          }
          return running;
        }),
      { timeout: 5000 },
    )
    .toBe(0);
});

test("reduced motion is static", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const counter = { posts: 0 };
  await openExplained(page, counter);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  await expect(page.getByText("The owner check happens here.").first()).toBeVisible();
});

test("explain layout contract", async ({ page }) => {
  const counter = { posts: 0 };
  await openExplained(page, counter);
  await assertLayout(page, { widths: [320, 390, 768, 1440, 1600, 1920] });
});
