// Shared mocks and click-sweep driver for click-every-control.spec.ts.
// Every REST response is route-mocked with hand-assembled synthetic
// fixtures; no test reaches the network. Synthetic addresses only.
import { expect, type Page } from "@playwright/test";
import { assertLayout } from "./layoutContract.ts";

export const ADDR_MANY = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
export const ADDR_ZERO = "0xcafecafecafecafecafecafecafecafecafecafe";
export const ADDR_PROXY = "0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed";
const ADDR_IMPL = "0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0";

export const SELECTOR_ADD = "0x44337ea1";
export const SELECTOR_MINT = "0x40c10f19";
export const SELECTOR_TRANSFER = "0xa9059cbb";
const ENTRY_PC = 200;

export type ClickScenario = "many" | "zero" | "proxy";

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
    registryEntry("dev.brandklipparen.ownership", 2),
    registryEntry("dev.brandklipparen.blacklist", 3),
    registryEntry("dev.brandklipparen.mint", 0),
    ...["pause", "transfer-fee", "transfer-limits", "sell-block", "transfer-hooks", "proxy-upgrade"].map((slug) =>
      registryEntry(`dev.brandklipparen.${slug}`, 1),
    ),
    ...["capability", "decompiler", "clone-match", "hard-to-analyze"].map((slug) =>
      registryEntry(`dev.brandklipparen.${slug}`, 0),
    ),
  ],
};

function emptyResult(pluginId: string): Record<string, unknown> {
  return { pluginId, pluginVersion: "1.0.0", outcome: "ok", findings: [] };
}

const OWNER_SLUGS = [
  "ownership",
  "pause",
  "blacklist",
  "mint",
  "transfer-fee",
  "transfer-limits",
  "sell-block",
  "transfer-hooks",
  "proxy-upgrade",
];

const TOOL_SLUGS = ["capability", "decompiler", "clone-match", "hard-to-analyze"];

function decompilerFinding(selector: string, name: string, signature: string, entryPc: number): Record<string, unknown> {
  return {
    id: `dev.brandklipparen.decompiler:${selector}`,
    title: `Decompiled function ${name} (${selector})`,
    payload: {
      selector,
      name,
      signature,
      entryPc,
      startPc: entryPc,
      endPc: entryPc + 2857,
      annotations: [],
      cause: null,
      unresolvedJumps: 0,
    },
    evidence: [{ selector, offset: entryPc }],
  };
}

// (a) A token with many findings: two signals, two template claims and
// scored findings on the ownership, blacklist, mint and decompiler tiles.
const ANALYZE_MANY = {
  kind: "assessed",
  target: ADDR_MANY,
  block: 18000000,
  tokenSymbol: "SYN",
  tokenName: "Synthetic Token",
  proxy: { kind: "none" },
  codeHash: "0xabc",
  modelVersion: "1.0.1",
  artifactChecksum: "checksum",
  indexVersion: "1.0.0",
  templateVersion: "1.0.0",
  assessedAt: 1700000000000,
  probabilities: { "rug-pull": 0.35, honeypot: 0.25, "bot-pump": 0.22 },
  score: 29,
  signals: [
    {
      kind: "capability",
      id: "owner-blacklist",
      risk: "honeypot",
      direction: "raises",
      severity: "high",
      evidence: [{ selector: SELECTOR_ADD, offset: 2623 }],
    },
    {
      kind: "capability",
      id: "owner-mint",
      risk: "rug-pull",
      direction: "raises",
      severity: "medium",
      evidence: [{ selector: SELECTOR_MINT, offset: 512 }],
    },
  ],
  explanation: {
    kind: "template",
    templateVersion: "1.0.0",
    claims: [
      {
        text: "The owner can stop chosen wallets from sending tokens.",
        signalLinks: ["owner-blacklist"],
        temporality: { kind: "can-change" },
      },
      {
        text: "The owner can create new tokens for any wallet.",
        signalLinks: ["owner-mint"],
        temporality: { kind: "can-change" },
      },
    ],
  },
  cantTell: [
    { question: "Who holds the liquidity?", dataSource: "liquidity locks" },
    { question: "Is the contract upgradeable?", dataSource: "proxy admin" },
  ],
  pluginResults: [
    {
      pluginId: "dev.brandklipparen.ownership",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [
        {
          id: "dev.brandklipparen.ownership:owner-slot",
          title: "Owner slot compared against the caller",
          payload: { feature: "owner-slot", slot: 0, privilegedFunctions: 11 },
          evidence: [{ selector: "0x8da5cb5b", offset: 64 }],
        },
      ],
    },
    {
      pluginId: "dev.brandklipparen.blacklist",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [
        {
          id: "dev.brandklipparen.blacklist:blacklist",
          title: "Blocked wallets",
          payload: { feature: "blacklist" },
          evidence: [200, 300, 400, 500, 600, 700, 800].map((offset) => ({
            selector: SELECTOR_ADD,
            offset,
          })),
        },
      ],
    },
    {
      pluginId: "dev.brandklipparen.mint",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [
        {
          id: "dev.brandklipparen.mint:mint-extended",
          title: "Mint, extended",
          payload: { fact: "mint", proof: "extended", capped: false },
          evidence: [
            { selector: SELECTOR_MINT, offset: 100 },
            { selector: SELECTOR_MINT, offset: 900 },
          ],
        },
      ],
    },
    {
      pluginId: "dev.brandklipparen.decompiler",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [
        decompilerFinding(SELECTOR_ADD, "addBlackList", "addBlackList(address)", ENTRY_PC),
        decompilerFinding(SELECTOR_TRANSFER, "transfer", "transfer(address,uint256)", 320),
      ],
    },
    ...["pause", "transfer-fee", "transfer-limits", "sell-block", "transfer-hooks", "proxy-upgrade"].map((slug) =>
      emptyResult(`dev.brandklipparen.${slug}`),
    ),
    ...["capability", "clone-match", "hard-to-analyze"].map((slug) =>
      emptyResult(`dev.brandklipparen.${slug}`),
    ),
  ],
};

// (b) A token with ZERO findings: no signals, no template claims and
// empty results on every owner power, with the hard-to-analyze detector
// fired so every owner tile reads "can't tell".
const ANALYZE_ZERO = {
  kind: "assessed",
  target: ADDR_ZERO,
  block: 18000000,
  tokenSymbol: "ZRO",
  tokenName: "Zero Synthetic Token",
  proxy: { kind: "none" },
  codeHash: "0xabc",
  modelVersion: "1.0.1",
  artifactChecksum: "checksum",
  indexVersion: "1.0.0",
  templateVersion: "1.0.0",
  assessedAt: 1700000000000,
  probabilities: { "rug-pull": 0.08, honeypot: 0.05, "bot-pump": 0.03 },
  score: 8,
  signals: [],
  explanation: { kind: "template", templateVersion: "1.0.0", claims: [] },
  cantTell: [
    { question: "Who holds the liquidity?", dataSource: "liquidity locks" },
    { question: "Can the owner mint?", dataSource: "owner powers" },
    { question: "Is the contract upgradeable?", dataSource: "proxy admin" },
  ],
  pluginResults: [
    ...OWNER_SLUGS.map((slug) => emptyResult(`dev.brandklipparen.${slug}`)),
    ...["capability", "decompiler", "clone-match"].map((slug) =>
      emptyResult(`dev.brandklipparen.${slug}`),
    ),
    {
      pluginId: "dev.brandklipparen.hard-to-analyze",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [
        {
          id: "dev.brandklipparen.hard-to-analyze:low-coverage",
          title: "Low coverage read",
          payload: { cause: "low-coverage" },
          evidence: [{ selector: SELECTOR_ADD, offset: 100 }],
        },
      ],
    },
  ],
};

// (c) A proxy token: the implementation address renders beside the proxy
// flag with its own copy button.
const ANALYZE_PROXY = {
  kind: "assessed",
  target: ADDR_PROXY,
  block: 18000000,
  tokenSymbol: "PXN",
  tokenName: "Proxy Synthetic Token",
  proxy: { kind: "eip1967", implementation: ADDR_IMPL },
  codeHash: "0xabc",
  modelVersion: "1.0.1",
  artifactChecksum: "checksum",
  indexVersion: "1.0.0",
  templateVersion: "1.0.0",
  assessedAt: 1700000000000,
  probabilities: { "rug-pull": 0.4, honeypot: 0.35, "bot-pump": 0.2 },
  score: 62,
  signals: [
    {
      kind: "capability",
      id: "proxy-admin",
      risk: "rug-pull",
      direction: "raises",
      severity: "medium",
      evidence: [{ selector: SELECTOR_ADD, offset: 100 }],
    },
  ],
  explanation: {
    kind: "template",
    templateVersion: "1.0.0",
    claims: [
      {
        text: "The proxy admin can replace the code behind this token.",
        signalLinks: ["proxy-admin"],
        temporality: { kind: "can-change" },
      },
    ],
  },
  cantTell: [{ question: "Who holds the liquidity?", dataSource: "liquidity locks" }],
  pluginResults: [
    {
      pluginId: "dev.brandklipparen.ownership",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [
        {
          id: "dev.brandklipparen.ownership:owner-slot",
          title: "Owner slot compared against the caller",
          payload: { feature: "owner-slot", slot: 0, privilegedFunctions: 4 },
          evidence: [{ selector: "0x8da5cb5b", offset: 64 }],
        },
      ],
    },
    {
      pluginId: "dev.brandklipparen.proxy-upgrade",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [
        {
          id: "dev.brandklipparen.proxy-upgrade:proxy",
          title: "Upgradeable proxy",
          payload: { feature: "proxy-upgrade", proxyKind: "eip1967" },
          evidence: [{ selector: SELECTOR_ADD, offset: 100 }],
        },
      ],
    },
    {
      pluginId: "dev.brandklipparen.decompiler",
      pluginVersion: "1.0.0",
      outcome: "ok",
      findings: [decompilerFinding(SELECTOR_ADD, "addBlackList", "addBlackList(address)", ENTRY_PC)],
    },
    ...["pause", "blacklist", "mint", "transfer-fee", "transfer-limits", "sell-block", "transfer-hooks"].map(
      (slug) => emptyResult(`dev.brandklipparen.${slug}`),
    ),
    ...TOOL_SLUGS.filter((slug) => slug !== "decompiler").map((slug) =>
      emptyResult(`dev.brandklipparen.${slug}`),
    ),
  ],
};

const ANALYZE_BY_ADDRESS: Record<string, unknown> = {
  [ADDR_MANY.toLowerCase()]: ANALYZE_MANY,
  [ADDR_ZERO.toLowerCase()]: ANALYZE_ZERO,
  [ADDR_PROXY.toLowerCase()]: ANALYZE_PROXY,
};

const HEALTH_FULL = {
  status: "ok",
  apiVersion: "v1",
  assessment: { provider: "test-adapter", modelId: "test-assessment-1" },
  explain: { provider: "test-adapter", modelId: "test-explain-1" },
  chat: { provider: "test-adapter", modelId: "test-explain-1" },
  investigation: { provider: "test-adapter", modelId: "test-investigation-1" },
  rug: { provider: "test-adapter", modelId: "test-rug-1" },
  explainCode: { provider: "test-adapter", modelId: "test-explain-1" },
  personalize: { disabled: true },
  onchain: { disabled: true },
  costUnits: "placeholder-cost-unit",
};

// The zero-findings page answers through the assessment source instead:
// explain and rug stay disabled while assessment is configured, so the
// Explain button runs the assessment request path.
const HEALTH_ASSESS = {
  ...HEALTH_FULL,
  explain: { disabled: true },
  rug: { disabled: true },
};

function explainBody(scenario: ClickScenario): Record<string, unknown> {
  if (scenario === "zero") {
    // Cant-tell citations: markers the page cannot link to a signal
    // render as plain text chips beside the sentences.
    return {
      status: "ok",
      apiVersion: "v1",
      codeHash: "0xabc",
      explain: {
        kind: "ok",
        narrative: [
          "No owner powers were found in the code we could read. [E:cant-tell:liquidity locks]",
          "Whether upgrades are possible is also unclear. [E:cant-tell:proxy admin]",
        ],
        droppedClaims: 1,
        provider: "test-adapter",
        modelId: "test-explain-1",
      },
    };
  }
  if (scenario === "proxy") {
    return {
      status: "ok",
      apiVersion: "v1",
      codeHash: "0xabc",
      explain: {
        kind: "ok",
        narrative: ["The proxy admin can replace the code behind this token. [E:signal:proxy-admin]"],
        droppedClaims: 0,
        provider: "test-adapter",
        modelId: "test-explain-1",
      },
    };
  }
  return {
    status: "ok",
    apiVersion: "v1",
    codeHash: "0xabc",
    explain: {
      kind: "ok",
      narrative: [
        "The owner can stop chosen wallets from sending tokens. [E:signal:owner-blacklist]",
        "Pause and blacklist are owner-only.",
      ],
      droppedClaims: 2,
      provider: "test-adapter",
      modelId: "test-explain-1",
    },
  };
}

function chatBody(): Record<string, unknown> {
  return {
    status: "ok",
    apiVersion: "v1",
    codeHash: "0xabc",
    chat: {
      kind: "ok",
      answers: [
        "The owner can stop chosen wallets from sending tokens.",
        "Pause and blacklist are owner-only.",
      ],
      droppedClaims: 2,
      provider: "test-adapter",
      modelId: "test-explain-1",
    },
  };
}

function investigationDone(scenario: ClickScenario): Record<string, unknown> {
  const analyze = scenario === "zero" ? ANALYZE_ZERO : scenario === "proxy" ? ANALYZE_PROXY : ANALYZE_MANY;
  const steps =
    scenario === "many"
      ? [
          {
            step: 1,
            toolId: "evidence.list",
            rationale: "List the frozen evidence first.",
            evidenceIds: ["signal:owner-blacklist"],
            elapsedMs: 0,
          },
          {
            step: 2,
            toolId: "detector.capability",
            rationale: "Read the capability behind the blacklist signal.",
            evidenceIds: ["signal:owner-blacklist"],
            elapsedMs: 0,
          },
        ]
      : [
          {
            step: 1,
            toolId: "evidence.list",
            rationale: "List the frozen evidence first.",
            evidenceIds: [],
            elapsedMs: 0,
          },
        ];
  return {
    ...analyze,
    investigation: {
      status: "done",
      report: {
        narrative:
          scenario === "many"
            ? "The frozen evidence shows the transfer guard. [E:signal:owner-blacklist]"
            : "The frozen evidence shows no owner-controlled transfer blocks.",
        droppedClaims: 0,
        steps,
        collectedEvidenceIds: scenario === "many" ? ["signal:owner-blacklist"] : [],
      },
      limits: { maxSteps: 8, maxTokens: 8000, deadlineMs: 60000, toolTimeoutMs: 5000 },
    },
    investigationProvider: "test-adapter",
    investigationModel: "test-investigation-1",
  };
}

function investigationEvents(scenario: ClickScenario): string {
  const done = investigationDone(scenario) as {
    investigation: unknown;
  };
  const steps = (
    done.investigation as {
      report: { steps: Array<Record<string, unknown>> };
    }
  ).report.steps.map((step) => {
    const { elapsedMs: _elapsedMs, ...rest } = step;
    void _elapsedMs;
    return { kind: "step", ...rest };
  });
  const report = {
    kind: "report",
    investigation: done.investigation,
    investigationProvider: "test-adapter",
    investigationModel: "test-investigation-1",
  };
  return [...steps, report].map((entry) => `data: ${JSON.stringify(entry)}\n\n`).join("");
}

function explainCodeBody(): Record<string, unknown> {
  return {
    status: "ok",
    apiVersion: "v1",
    codeHash: "0xabc",
    selector: SELECTOR_ADD,
    view: "decompiled",
    explainCode: {
      kind: "ok",
      summary: [
        {
          text: "Only the owner can call this function, and no one else can.",
          cites: [{ kind: "line", selector: SELECTOR_ADD, view: "decompiled", line: 3 }],
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
          cites: [{ kind: "line", selector: SELECTOR_TRANSFER, view: "decompiled", line: 2 }],
        },
      ],
      droppedClaims: 0,
      provider: "test-adapter",
      modelId: "test-explain-1",
    },
  };
}

function snippetBody(selector: string): Record<string, unknown> {
  const texts = [
    `function f_${selector.slice(2, 6)}(address a0) {`,
    "  require(msg.value == 0);",
    "  require(msg.sender == owner);",
    "  store[a0] = true;",
    "  emit Changed(a0);",
    "}",
  ];
  return {
    status: "ok",
    apiVersion: "v1",
    codeHash: "0xabc",
    snippet: {
      selector,
      entryPc: ENTRY_PC,
      lines: texts.map((text, index) => ({
        selector,
        lineNumber: index + 1,
        text,
        pcs: index === 3 ? [ENTRY_PC] : [],
      })),
    },
  };
}

function sourceBody(): Record<string, unknown> {
  const content = Array.from({ length: 20 }, (_, index) => `line ${index + 1} of Token.sol`).join("\n");
  return {
    status: "ok",
    apiVersion: "v1",
    codeHash: "0xabc",
    source: {
      status: "verified",
      provider: "Sourcify",
      match: "full",
      compiler: "v0.8.20",
      files: [{ path: "contracts/Token.sol", content }],
      functions: [
        {
          selector: SELECTOR_ADD,
          signature: "addBlackList(address)",
          name: "addBlackList",
          file: "contracts/Token.sol",
          startLine: 12,
          endLine: 16,
        },
        {
          selector: SELECTOR_TRANSFER,
          signature: "transfer(address,uint256)",
          name: "transfer",
          file: "contracts/Token.sol",
          startLine: 12,
          endLine: 16,
        },
      ],
      pcToLine: {
        [String(ENTRY_PC)]: { file: "contracts/Token.sol", line: 14 },
        ["320"]: { file: "contracts/Token.sol", line: 14 },
      },
    },
  };
}

// Track requests that reach no specific mock: the catch-all below
// records the pathname so the failure names the unmocked route.
const unmockedByPage = new WeakMap<Page, string[]>();

export function unmockedRequests(page: Page): readonly string[] {
  return unmockedByPage.get(page) ?? [];
}

// Install every route the sweep can touch. Specific patterns use the
// proven string globs from the other suites: exact for no-query routes,
// trailing * for query routes. The stream, events and explain-code
// routes precede their broader siblings. The final predicate catch-all
// only matches /v1 paths outside the known list, so it never shadows a
// specific mock; it records the pathname and answers 500 so the sweep
// fails with the unmocked name instead of a generic network error.
const KNOWN_V1 = [
  "/v1/analyze/stream",
  "/v1/analyze",
  "/v1/investigate/events",
  "/v1/investigate",
  "/v1/explain-code",
  "/v1/explain",
  "/v1/chat",
  "/v1/assessment",
  "/v1/rug",
  "/v1/plugins",
  "/v1/personalize/status",
  "/v1/personalize",
  "/v1/live-tokens",
  "/v1/market-new",
  "/v1/snippet",
  "/v1/source",
  "/v1/proof",
  "/v1/onchain-features",
];
export async function installClickMocks(page: Page, scenario: ClickScenario): Promise<void> {
  const health = scenario === "zero" ? HEALTH_ASSESS : HEALTH_FULL;
  unmockedByPage.set(page, []);
  await page.route("**/health", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(health) });
  });
  await page.route("**/v1/analyze/stream*", async (route) => {
    const address = new URL(route.request().url()).searchParams.get("address")?.toLowerCase() ?? "";
    const analyze = ANALYZE_BY_ADDRESS[address] ?? ANALYZE_MANY;
    const body = `data: ${JSON.stringify(analyze)}\n\ndata: ${JSON.stringify({ kind: "deepening", status: "pending" })}\n\n`;
    await route.fulfill({ status: 200, contentType: "text/event-stream", body });
  });
  await page.route("**/v1/investigate/events*", async (route) => {
    // The many-findings page streams steps; the other pages exercise the
    // completed-report fallback when the events transport is absent.
    // A 200 JSON body (not an error status and not event-stream) simulates
    // that absence: the app sees the wrong content-type, throws, and falls
    // back the same way, without any browser-level "Failed to load
    // resource" console error. Both an abort and an HTTP error status
    // would log such an error that no app code can prevent and that is not
    // a page defect.
    if (scenario === "many") {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: investigationEvents(scenario) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", note: "events transport unavailable" }),
    });
  });
  await page.route("**/v1/explain-code", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(explainCodeBody()) });
  });
  await page.route("**/v1/analyze*", async (route) => {
    const address = new URL(route.request().url()).searchParams.get("address")?.toLowerCase() ?? "";
    const analyze = ANALYZE_BY_ADDRESS[address] ?? ANALYZE_MANY;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "x-deepening-status": "pending" },
      body: JSON.stringify(analyze),
    });
  });
  await page.route("**/v1/investigate*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(investigationDone(scenario)) });
  });
  await page.route("**/v1/explain*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(explainBody(scenario)) });
  });
  await page.route("**/v1/chat", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(chatBody()) });
  });
  await page.route("**/v1/assessment*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "ok",
        apiVersion: "v1",
        assessment: {
          text: "The bytecode shows caller-gated transfers with no sign of an owner mint. This reading is advisory only.",
          provider: "test-adapter",
          modelId: "test-assessment-1",
        },
      }),
    });
  });
  await page.route("**/v1/rug*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "ok",
        apiVersion: "v1",
        rug: {
          kind: "ok",
          narrative: ["The top risk reads like an owner-controlled transfer block."],
          droppedClaims: 0,
          provider: "test-adapter",
          modelId: "test-rug-1",
        },
      }),
    });
  });
  await page.route("**/v1/plugins", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PLUGINS_FIXTURE) });
  });
  await page.route("**/v1/personalize/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", apiVersion: "v1", personalize: { disabled: true } }),
    });
  });
  await page.route("**/v1/personalize", async (route) => {
    await route.fulfill({
      status: 501,
      contentType: "application/json",
      body: JSON.stringify({ status: 501, code: "personalize-not-configured", message: "Personalize is not configured." }),
    });
  });
  await page.route("**/v1/live-tokens", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ source: "none", status: "live", updatedAt: 0, items: [] }),
    });
  });
  await page.route("**/v1/market-new*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ updatedAt: 0, items: [] }),
    });
  });
  await page.route("**/v1/snippet*", async (route) => {
    const selector = new URL(route.request().url()).searchParams.get("selector") ?? SELECTOR_ADD;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snippetBody(selector)) });
  });
  await page.route("**/v1/source*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sourceBody()) });
  });
  await page.route("**/v1/proof*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", apiVersion: "v1", codeHash: "0xabc", proofs: [] }),
    });
  });
  await page.route("**/v1/onchain-features*", async (route) => {
    await route.fulfill({
      status: 501,
      contentType: "application/json",
      body: JSON.stringify({ status: 501, code: "onchain-not-configured", message: "On-chain reads are not configured." }),
    });
  });
  // Catch-all: any other /v1 path is an explicit gap. The predicate
  // only matches paths outside KNOWN_V1, so it never shadows a specific
  // mock. It records the pathname and answers 500 so the sweep fails
  // with the unmocked name instead of a generic network error.
  await page.route(
    (url) => url.pathname.startsWith("/v1/") && !KNOWN_V1.includes(url.pathname),
    async (route) => {
      const url = new URL(route.request().url());
      const path = `${url.pathname}${url.search}`;
      const seen = unmockedByPage.get(page);
      if (seen !== undefined && !seen.includes(path)) {
        seen.push(path);
      }
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ status: 500, code: "unmocked-route", message: `Unmocked route: ${path}` }),
      });
    },
  );
}

export type ErrorBucket = { readonly consoleErrors: string[]; readonly pageErrors: string[] };

// Attach before the first navigation: every later check drains the same
// bucket, so each click is judged on the errors it caused.
export function collectErrors(page: Page): ErrorBucket {
  const bucket: { consoleErrors: string[]; pageErrors: string[] } = { consoleErrors: [], pageErrors: [] };
  page.on("console", (message) => {
    if (message.type() === "error") {
      bucket.consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    bucket.pageErrors.push(String(error));
  });
  return bucket;
}

// Developer strings that must never reach visible text.
const BANNED = /failed the evidence check|Template:|undefined|NaN|\[object|\(4\d\d\)|\(5\d\d\)|stack trace/i;

export async function checkQuiet(page: Page, bucket: ErrorBucket, where: string): Promise<void> {
  expect(unmockedRequests(page), `unmocked requests ${where}`).toEqual([]);
  expect(bucket.consoleErrors, `console errors ${where}`).toEqual([]);
  expect(bucket.pageErrors, `page errors ${where}`).toEqual([]);
  const text = await page.evaluate(() => document.body.innerText);
  expect(text, `developer strings ${where}`).not.toMatch(BANNED);
}

// Mark the first visible, enabled, not-yet-clicked control with
// [data-sweep] and return its key, or null when the page is exhausted.
// Digits fold out of the key so count-up numbers cannot retarget a tile.
async function markNext(page: Page, seen: readonly string[]): Promise<string | null> {
  return page.evaluate((seenKeys: readonly string[]) => {
    const seenSet = new Set(seenKeys);
    for (const marked of Array.from(document.querySelectorAll("[data-sweep]"))) {
      marked.removeAttribute("data-sweep");
    }
    const counts = new Map<string, number>();
    const matches = document.querySelectorAll(
      "button:not([disabled]), a[href^='#'], a[href^='/'], [role='tab'], [role='switch'], summary",
    );
    for (const element of Array.from(matches)) {
      const node = element as HTMLElement;
      if (node.closest(".sr-only") !== null) {
        continue;
      }
      // Skip links sit off-screen until focused and Playwright cannot
      // click them while hidden: they are navigation aids, not sweep
      // targets.
      if (node.classList.contains("skip-link") || node.closest(".skip-link") !== null) {
        continue;
      }
      if (node.getAttribute("aria-hidden") === "true" || node.getAttribute("aria-disabled") === "true") {
        continue;
      }
      if (node.tagName === "A") {
        const anchor = node as HTMLAnchorElement;
        if (anchor.target === "_blank" || anchor.hasAttribute("download")) {
          continue;
        }
        const href = anchor.getAttribute("href") ?? "";
        if (/^https?:/i.test(href)) {
          continue;
        }
      }
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }
      const style = getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none") {
        continue;
      }
      // Closed disclosures and other hidden subtrees report a rect but
      // are not clickable: skip anything the platform calls invisible.
      // Skip links are already excluded above; this covers details and
      // similar containers.
      try {
        const visible = (node as unknown as { checkVisibility?: (options?: object) => boolean }).checkVisibility;
        if (typeof visible === "function" && !visible.call(node, { checkOpacity: true, checkVisibilityCSS: true })) {
          continue;
        }
      } catch {
        // checkVisibility is a convenience only; the rect and style
        // checks above already passed.
      }
      const name = (node.getAttribute("aria-label") ?? node.innerText ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[0-9]+/g, "#")
        .slice(0, 80);
      const href = node.tagName === "A" ? (node.getAttribute("href") ?? "") : "";
      const base = `${node.tagName}|${name}|${href}`;
      const occurrence = counts.get(base) ?? 0;
      counts.set(base, occurrence + 1);
      const key = `${base}|${occurrence}`;
      if (seenSet.has(key)) {
        continue;
      }
      node.setAttribute("data-sweep", "1");
      return key;
    }
    return null;
  }, seen);
}

// Click every visible enabled control once: buttons, same-origin links
// (external links and downloads are never followed), tabs, switches and
// disclosure summaries. After each click the page must stay quiet and
// hold the layout contract; a click that navigates goes back afterwards.
export async function sweepControls(page: Page, bucket: ErrorBucket, width: number, label: string): Promise<number> {
  const seen = new Set<string>();
  let clicks = 0;
  for (let step = 0; step < 80; step += 1) {
    const before = new URL(page.url()).hash;
    const key = await markNext(page, [...seen]);
    if (key === null) {
      break;
    }
    // Capture the marked node as a handle immediately: background
    // re-renders (deepening polls, count-ups, the read-along timer)
    // can replace the node between listing and clicking, and waiting
    // on the [data-sweep] locator would then stall the sweep instead
    // of failing fast. A null handle means the mark went stale; the
    // key stays unseen so the control is retried when visible again.
    const handle = await page.$("[data-sweep]");
    if (handle === null) {
      continue;
    }
    // Controls inside a fixed strip need no scrolling: Playwright's
    // scroll-into-view would scroll the page under them, the strip's
    // IntersectionObserver would unmount it, and the click would chase
    // a detached node. Click the on-screen box directly instead.
    let inFixed = false;
    try {
      inFixed = await handle.evaluate((node) => {
        let current: HTMLElement | null = node as HTMLElement;
        while (current !== null) {
          const position = getComputedStyle(current).position;
          if (position === "fixed" || position === "sticky") {
            return true;
          }
          current = current.parentElement;
        }
        return false;
      });
    } catch {
      await handle.dispose().catch(() => undefined);
      continue;
    }
    try {
      if (inFixed) {
        const box = await handle.boundingBox();
        if (box !== null) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        } else {
          await handle.dispose().catch(() => undefined);
          continue;
        }
      } else {
        await handle.click({ timeout: 10000 });
      }
    } catch (error) {
      // Name the control: without the key the timeout names only the
      // [data-sweep] selector and the stall cannot be attributed.
      throw new Error(`sweep click failed on ${key}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await handle.dispose().catch(() => undefined);
    }
    seen.add(key);
    clicks += 1;
    await checkQuiet(page, bucket, `${label} after click ${clicks} (${key})`);
    await assertLayout(page, { widths: [width] });
    if (new URL(page.url()).hash !== before) {
      await checkQuiet(page, bucket, `${label} after navigation (${key})`);
      await page.goBack();
    }
  }
  return clicks;
}



