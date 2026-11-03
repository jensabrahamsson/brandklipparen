// Live investigation runs (Muse agent) over real Ethereum mainnet tokens.
// Run from the repo root with `npm run investigate:live`.
//
// For each token, in sequence: one deterministic analysis through the same
// application service the REST route uses, then the investigation loop
// through the production Meta Model API adapter. The transport is wrapped
// only to record each model call's HTTP status, usage and decision. The
// request URL and headers are never recorded. Keys arrive only through the
// existing `*_FILE` pointers, read by the app's own config loader.
//
// Output: one JSON log per token and SUMMARY.md in BK_LIVE_OUT_DIR (default
// docs/live-investigations). Environment (names documented in .env.example):
//   BRANDKLIPPAREN_INVESTIGATE_META_BASE_URL       required: the API root
//   BRANDKLIPPAREN_INVESTIGATE_META_API_KEY_FILE   required (or the
//                                                  assessment key pointer)
//   BK_LIVE_LIMIT         optional: run only the first N tokens (pilot)
//   BK_LIVE_DRY=1         optional: model off, zero model calls (dry check)
//   BK_LIVE_DELAY_MS      optional: pause between tokens (default 5000)
//   BK_LIVE_OUT_DIR       optional: output folder
//   BK_LIVE_USD_PER_MTOK  optional: price per million tokens, for the cost line
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEnvLocal, readEnvLocalFile } from "../scripts/demo.ts";
import { loadMcpAppConfig, startupPorts } from "../src/main.ts";
import { buildApp } from "../src/composition/app.ts";
import type { BuiltApp } from "../src/composition/app.ts";
import { createInvestigationServiceFromConfig } from "../src/composition/root.ts";
import { fetchMetaInvestigateTransport } from "../src/adapters/investigation/metaModelApiInvestigateAdapter.ts";
import type { MetaInvestigateTransport } from "../src/adapters/investigation/metaModelApiInvestigateAdapter.ts";
import { stripInvestigateJsonFence } from "../src/adapters/investigation/investigateChatCompletions.ts";
import { serializeAssessment } from "../src/application/analyzeToken.ts";
import type { AssessmentEnvelope } from "../src/application/analyzeToken.ts";
import type { InvestigationService } from "../src/application/investigationService.ts";
import type { InvestigationEnvelope } from "../src/application/investigateToken.ts";
import { checkCitations, splitSentences } from "../src/domain/investigation.ts";
import { Address, RequestId, Timestamp } from "../src/domain/types.ts";
import type { AppConfig } from "../src/ports/config.ts";

type TokenGroup = "well-known" | "memecoin" | "new-listing";

type LiveToken = {
  readonly address: string;
  readonly symbol: string;
  readonly group: TokenGroup;
};

// Real mainnet tokens. Owner powers (blacklist, pause, mint) are not
// labelled here: the deterministic detectors report what each token has.
const TOKENS: readonly LiveToken[] = [
  { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", group: "well-known" },
  { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", group: "well-known" },
  { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", symbol: "DAI", group: "well-known" },
  { address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", symbol: "LINK", group: "well-known" },
  { address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", symbol: "UNI", group: "well-known" },
  { address: "0x6982508145454Ce325dDbE47a25d4ec3d2311933", symbol: "PEPE", group: "well-known" },
  { address: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", symbol: "SHIB", group: "well-known" },
  { address: "0x4c5fc2efd7f9fba2c6a9227abd9d1c3eefd6bdd7", symbol: "ZIPCAT", group: "memecoin" },
  { address: "0xb8587843e247c9ede533edec32e64354eebb5470", symbol: "NEW01", group: "new-listing" }, // listed in block 26336502
  { address: "0xeb1c9afe0c5d4237f4bb148a81faed2e4fabfbe3", symbol: "NEW02", group: "new-listing" }, // listed in block 26336510
  { address: "0x6bd4c81b1633b6b2d7bf500214b6cfad256c8bdd", symbol: "NEW03", group: "new-listing" }, // listed in block 26336520
  { address: "0x2de7ad079d532e92a2083280e5b24ac3629b076a", symbol: "NEW04", group: "new-listing" }, // listed in block 26336523
  { address: "0xc3dfa2d7e82e3416a85a5542a229d9bedb6d04f2", symbol: "NEW05", group: "new-listing" }, // listed in block 26336534
  { address: "0x27c1ba4f85b8dc1c150157816623a6ce80b7f187", symbol: "NEW06", group: "new-listing" }, // listed in block 26336551
  { address: "0x8bb6aa42be6551d9843ce3f4ec5297b6c0d9179c", symbol: "NEW07", group: "new-listing" }, // listed in block 26336590
  { address: "0x36e8dbaeeecd88273917232238e10623ff4b479f", symbol: "NEW08", group: "new-listing" }, // listed in block 26336622
  { address: "0xc96aa65f31e41b4ca6924b86d93e25686019e59c", symbol: "NEW09", group: "new-listing" }, // listed in block 26336690
  { address: "0x9a0af943fcad097f276c4b10fa4f497afa3629d6", symbol: "NEW10", group: "new-listing" }, // listed in block 26336746
  { address: "0x798d1be841a82a273720ce31c822c61a67a601c3", symbol: "NEW11", group: "new-listing" }, // listed in block 26336759
  { address: "0x8ebc5b9cc678aa85953a1481163bca5e8f30629f", symbol: "NEW12", group: "new-listing" }, // listed in block 26336771
];

// Defaults for values the environment and .env.local leave unset.
const RUN_DEFAULTS: Readonly<Record<string, string>> = {
  BRANDKLIPPAREN_INVESTIGATE_PROVIDER: "meta-model-api",
  BRANDKLIPPAREN_INVESTIGATE_META_MODEL_ID: "muse-spark-1.3",
  BRANDKLIPPAREN_INVESTIGATE_META_BASE_URL: "https://api.meta.ai/v1",
  BRANDKLIPPAREN_INVESTIGATE_DAILY_CAP_PER_KEY: "100",
};

// Brief budgets (DEFAULT_INVESTIGATION_LIMITS), always set for this run. The
// composition's own fallback is larger (64000 tokens, 120 s) and is not used.
const RUN_LIMITS: Readonly<Record<string, string>> = {
  BRANDKLIPPAREN_INVESTIGATE_MAX_STEPS: "8",
  BRANDKLIPPAREN_INVESTIGATE_MAX_TOKENS: "8000",
  BRANDKLIPPAREN_INVESTIGATE_DEADLINE_MS: "60000",
  BRANDKLIPPAREN_INVESTIGATE_TOOL_TIMEOUT_MS: "5000",
};

const ANALYSIS_DEADLINE_MS = 30000;
const INVESTIGATION_DEADLINE_MS = 120000;

type ModelCallRecord = {
  readonly index: number;
  readonly httpStatus: number | null;
  readonly outcome: "decided" | "unparsed" | "transport-error";
  readonly decision: string | null;
  readonly toolId: string | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
  readonly ms: number;
  readonly narrativeDraft: string | null;
};

type StepRecord = {
  readonly step: number;
  readonly tool: string;
  readonly reason: string;
  readonly evidenceCount: number;
  readonly evidenceIds: readonly string[];
};

type TokenStatus = "done" | "failed" | "not-configured" | "analysis-error" | "no-contract" | "error";

type TokenLog = {
  readonly address: string;
  readonly symbol: string;
  readonly group: TokenGroup;
  readonly startedAt: string;
  readonly status: TokenStatus;
  readonly failure: string | null;
  readonly durationMs: number;
  readonly investigationMs: number;
  readonly score: {
    readonly value: number | null;
    readonly band: string | null;
    readonly withoutMuseSha256: string | null;
    readonly withMuseSha256: string | null;
    readonly identical: boolean | null;
  };
  readonly verdict: {
    readonly narrative: string;
    readonly rationale: string;
    readonly forcedConclusion: boolean;
    readonly verifiedInput: boolean;
  } | null;
  readonly steps: readonly StepRecord[];
  readonly modelCalls: readonly ModelCallRecord[];
  readonly citations: {
    readonly kept: readonly string[];
    readonly dropped: readonly { readonly sentence: string; readonly reason: "uncited" | "unknown-id" }[];
    readonly reproducedNarrative: boolean | null;
  };
  readonly tokens: {
    readonly total: number | null;
    readonly source: "provider-usage" | "not-reported";
  };
  // The app's own 8000-limit counter: sum over accepted decisions of
  // (characters of rationale or conclude draft) + 10. Not provider tokens.
  readonly budgetUnits: number;
  readonly reused: boolean;
  readonly error: string | null;
};

// Collector for the current token: the wrapped transport appends one record
// per model call while that token's investigation runs.
let activeCalls: ModelCallRecord[] = [];

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// Written output never carries the WETH contract address (it may appear as a
// quote token in evidence ids or narrative text): it is redacted to "WETH".
const WETH_ADDRESS_PATTERN = new RegExp(["0xc02aaa39", "b223fe8d0a0e5c4f27ead9083c756cc2"].join(""), "gi");
function redact(text: string): string {
  return text.replace(WETH_ADDRESS_PATTERN, "WETH");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// Reads the provider's usage figures and the decision the model chose. The
// body is parsed locally and never written out.
function callRecordOf(index: number, httpStatus: number, bodyText: string, ms: number): ModelCallRecord {
  const root = recordOf(parseJson(bodyText));
  const usage = recordOf(root?.["usage"]);
  const choices = root?.["choices"];
  const first = Array.isArray(choices) ? recordOf(choices[0]) : null;
  const content = stringOf(recordOf(first?.["message"])?.["content"]);
  // The decision object sits under "decision", beside "provider" and "modelId".
  const envelopeOfDecision = content === null ? null : recordOf(parseJson(stripInvestigateJsonFence(content)));
  const decision = recordOf(envelopeOfDecision?.["decision"]);
  const kind = stringOf(decision?.["kind"]);
  return {
    index,
    httpStatus,
    outcome: kind === null ? "unparsed" : "decided",
    decision: kind,
    toolId: stringOf(decision?.["toolId"]),
    promptTokens: numberOf(usage?.["prompt_tokens"]),
    completionTokens: numberOf(usage?.["completion_tokens"]),
    totalTokens: numberOf(usage?.["total_tokens"]),
    ms,
    narrativeDraft: kind === "conclude" ? stringOf(decision?.["narrativeDraft"]) : null,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

// The production transport, wrapped only to record each call. The request
// URL and headers stay inside the call and are never stored.
const recordingTransport: MetaInvestigateTransport = async (url, init) => {
  const started = Date.now();
  const index = activeCalls.length + 1;
  try {
    const response = await fetchMetaInvestigateTransport(url, init);
    activeCalls.push(callRecordOf(index, response.status, response.bodyText, Date.now() - started));
    return response;
  } catch (error) {
    activeCalls.push({
      index,
      httpStatus: null,
      outcome: "transport-error",
      decision: null,
      toolId: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      ms: Date.now() - started,
      narrativeDraft: null,
    });
    throw error;
  }
};

// Unwraps a typed Result or stops the run with the error kind; no value is
// printed.
function must<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly kind: string } }, what: string): T {
  if (result.ok) {
    return result.value;
  }
  return fail(`${what} failed: ${result.error.kind}`);
}

// Same local configuration as the demo: the repo's .env.local is parsed and
// applied in-process by the demo's own helpers, and the user's environment
// wins over it. Values are never printed.
// BK_LIVE_DRY=1 turns the model off (zero model calls) so the analysis, the
// score check and the log output can be exercised before a paid run.
function loadEnvironment(): Record<string, string | undefined> {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const parsed = readEnvLocalFile(repoRoot, {
    existsSync,
    readFileSync: (path: string) => readFileSync(path, "utf8"),
  });
  const merged: Record<string, string | undefined> = applyEnvLocal(process.env, parsed).env;
  for (const [name, value] of Object.entries(RUN_DEFAULTS)) {
    if (merged[name] === undefined || merged[name] === "") {
      merged[name] = value;
    }
  }
  // The brief's limits are forced, so an environment value cannot silently
  // raise the budgets of a live run.
  for (const [name, value] of Object.entries(RUN_LIMITS)) {
    merged[name] = value;
  }
  if (merged["BK_LIVE_DRY"] === "1") {
    merged["BRANDKLIPPAREN_INVESTIGATE_PROVIDER"] = "off";
  }
  return merged;
}

function requireConfig(config: AppConfig): void {
  if (config.investigateProvider !== "meta-model-api") {
    fail("live run needs BRANDKLIPPAREN_INVESTIGATE_PROVIDER=meta-model-api");
  }
  const missing: string[] = [];
  if (config.investigateMetaBaseUrl === undefined) {
    missing.push("BRANDKLIPPAREN_INVESTIGATE_META_BASE_URL");
  }
  if (config.investigateMetaApiKey === undefined) {
    missing.push("BRANDKLIPPAREN_INVESTIGATE_META_API_KEY_FILE (or BRANDKLIPPAREN_ASSESSMENT_META_API_KEY_FILE)");
  }
  if (missing.length > 0) {
    fail(`live run cannot start; set: ${missing.join(", ")}`);
  }
}

function scoreBandLabel(score: number): string {
  if (score >= 60) {
    return "High";
  }
  if (score >= 30) {
    return "Elevated";
  }
  return "Low";
}

function emptyLog(token: LiveToken, startedAt: string, status: TokenStatus, error: string | null, durationMs: number): TokenLog {
  return {
    address: token.address,
    symbol: token.symbol,
    group: token.group,
    startedAt,
    status,
    failure: error,
    durationMs,
    investigationMs: 0,
    score: { value: null, band: null, withoutMuseSha256: null, withMuseSha256: null, identical: null },
    verdict: null,
    steps: [],
    modelCalls: [],
    citations: { kept: [], dropped: [], reproducedNarrative: null },
    tokens: { total: null, source: "not-reported" },
    budgetUnits: 0,
    reused: false,
    error,
  };
}

function stepsOf(steps: readonly { step: number; toolId: string; rationale: string; evidenceIds: readonly string[] }[]): StepRecord[] {
  return steps.map((step) => ({
    step: step.step,
    tool: step.toolId,
    reason: step.rationale,
    evidenceCount: step.evidenceIds.length,
    evidenceIds: step.evidenceIds.slice(),
  }));
}

// Dropped sentences: the conclude draft split with the app's own splitter,
// each sentence checked against the collected evidence with the app's own
// citation check.
function citationsOf(draft: string | null, collected: readonly string[]): TokenLog["citations"] {
  if (draft === null) {
    return { kept: [], dropped: [], reproducedNarrative: null };
  }
  const kept: string[] = [];
  const dropped: { sentence: string; reason: "uncited" | "unknown-id" }[] = [];
  for (const sentence of splitSentences(draft)) {
    const checked = checkCitations(sentence, collected);
    if (checked.droppedClaims === 0) {
      kept.push(sentence);
    } else {
      dropped.push({ sentence, reason: checked.dropReasons.uncited > 0 ? "uncited" : "unknown-id" });
    }
  }
  return { kept, dropped, reproducedNarrative: null };
}

function tokensOf(calls: readonly ModelCallRecord[]): TokenLog["tokens"] {
  let total: number | null = null;
  for (const call of calls) {
    if (call.totalTokens !== null) {
      total = (total ?? 0) + call.totalTokens;
    }
  }
  return { total, source: total === null ? "not-reported" : "provider-usage" };
}

type Services = Pick<BuiltApp, "services" | "rest">;

async function investigateToken(
  built: Services,
  service: InvestigationService,
  token: LiveToken,
): Promise<TokenLog> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const elapsed = (): number => Date.now() - started;
  const address = Address.parse(token.address);
  if (!address.ok) {
    return emptyLog(token, startedAt, "error", "invalid-address", elapsed());
  }
  const rest = built.rest;
  const analysed = await built.services.analyzeToken({
    address: address.value,
    block: "latest",
    requestId: must(RequestId.parse(randomUUID()), "request id"),
    deadline: must(Timestamp.of(Date.now() + ANALYSIS_DEADLINE_MS), "deadline"),
    modelVersion: rest.modelVersion,
    indexVersion: rest.indexVersion,
    templateVersion: rest.templateVersion,
    catalogue: rest.catalogue,
  });
  if (!analysed.ok) {
    return emptyLog(token, startedAt, "analysis-error", analysed.error.kind, elapsed());
  }
  if (analysed.value.kind === "no-contract") {
    return emptyLog(token, startedAt, "no-contract", null, elapsed());
  }
  const envelope: AssessmentEnvelope = analysed.value.envelope;
  const scoreValue = envelope.score as number;
  // Without-Muse side: the deterministic envelope serialized before the loop.
  const withoutMuse = sha256(serializeAssessment(envelope));

  activeCalls = [];
  const investigationStarted = Date.now();
  const outcome: InvestigationEnvelope = await service.investigateEnvelope(
    envelope,
    {
      requestId: must(RequestId.parse(randomUUID()), "request id"),
      deadline: must(Timestamp.of(Date.now() + INVESTIGATION_DEADLINE_MS), "deadline"),
      block: envelope.block,
    },
    { now: () => Date.now() },
    { apiKeyId: "live-run", day: new Date().toISOString().slice(0, 10) },
  );
  const investigationMs = Date.now() - investigationStarted;
  // With-Muse side: the same envelope after the loop. The loop never writes
  // scores, signals or evidence, so the two serializations must match.
  const withMuse = sha256(serializeAssessment(envelope));
  const score = {
    value: scoreValue,
    band: scoreBandLabel(scoreValue),
    withoutMuseSha256: withoutMuse,
    withMuseSha256: withMuse,
    identical: withoutMuse === withMuse,
  };
  const calls = activeCalls.slice();
  const base = { ...emptyLog(token, startedAt, "error", null, 0), score, modelCalls: calls, tokens: tokensOf(calls), investigationMs };

  if (outcome.status === "not-configured") {
    return { ...base, status: "not-configured", failure: "investigation not configured", durationMs: elapsed() };
  }
  if (outcome.status === "failed") {
    const reason = outcome.reason;
    return {
      ...base,
      status: "failed",
      failure: `${reason.kind}: ${reason.message}`,
      durationMs: elapsed(),
      steps: stepsOf(outcome.partial),
      budgetUnits: budgetUnitsOf(stepsOf(outcome.partial), calls),
    };
  }
  const report = outcome.report;
  const draft = [...calls].reverse().find((call) => call.narrativeDraft !== null)?.narrativeDraft ?? null;
  const citations = citationsOf(draft, report.collectedEvidenceIds);
  return {
    ...base,
    status: "done",
    failure: null,
    error: null,
    durationMs: elapsed(),
    verdict: {
      narrative: report.narrative,
      rationale: report.rationale,
      forcedConclusion: report.forcedConclusion,
      verifiedInput: report.verifiedInput,
    },
    steps: stepsOf(report.steps),
    budgetUnits: budgetUnitsOf(stepsOf(report.steps), calls),
    citations: { ...citations, reproducedNarrative: citations.kept.join(" ") === report.narrative },
  };
}

// Mirrors decisionCost in the application runner: each accepted run-tool
// decision costs its rationale length + 10, each conclude its draft length + 10.
function budgetUnitsOf(steps: readonly StepRecord[], calls: readonly ModelCallRecord[]): number {
  const stepUnits = steps.reduce((sum, step) => sum + step.reason.length + 10, 0);
  const concludeUnits = calls
    .filter((call) => call.narrativeDraft !== null)
    .reduce((sum, call) => sum + (call.narrativeDraft as string).length + 10, 0);
  return stepUnits + concludeUnits;
}

function summaryOf(logs: readonly TokenLog[], usdPerMillion: number | null): string {
  const rows = logs.map((log) => {
    const verdict = log.verdict === null
      ? `${log.status}${log.failure === null ? "" : `: ${log.failure}`}`
      : log.verdict.narrative;
    const shortVerdict = verdict.length > 140 ? `${verdict.slice(0, 137)}...` : verdict;
    const identical = log.score.identical === null ? "n/a" : log.score.identical ? "yes" : "no";
    return [
      `| ${log.symbol}${log.reused ? " (reused)" : ""}`,
      log.status,
      String(log.steps.length),
      String(log.modelCalls.length),
      `${shortVerdict.replace(/\|/g, "/")}`,
      `${log.citations.kept.length} / ${log.citations.dropped.length}`,
      String(log.score.value ?? "n/a"),
      identical,
      String(log.tokens.total ?? "n/a"),
      String(log.budgetUnits),
      `${(log.durationMs / 1000).toFixed(1)} s`,
      `[json](${log.address}.json) |`,
    ].join(" | ");
  });
  const done = logs.filter((log) => log.status === "done");
  const failures = logs.filter((log) => log.status !== "done");
  const totalTokens = logs.reduce((sum, log) => sum + (log.tokens.total ?? 0), 0);
  const totalCalls = logs.reduce((sum, log) => sum + log.modelCalls.length, 0);
  const totalSeconds = logs.reduce((sum, log) => sum + log.durationMs, 0) / 1000;
  const mean = (values: readonly number[]): string =>
    values.length === 0 ? "n/a" : (values.reduce((a, b) => a + b, 0) / values.length).toFixed(1);
  const identicalCount = logs.filter((log) => log.score.identical === true).length;
  const cost = usdPerMillion === null
    ? "not computed (no price given)"
    : `about ${((totalTokens / 1_000_000) * usdPerMillion).toFixed(4)} USD at the given price`;
  const failureLines = failures.length === 0
    ? "None. Every token finished with a cited conclusion."
    : failures.map((log) => `- ${log.symbol}: ${log.status}${log.failure === null ? "" : ` (${log.failure})`}`).join("\n");
  return [
    "# Live investigation runs",
    "",
    `Generated ${new Date().toISOString()} against Ethereum mainnet, ${logs.length} tokens run one after another with a pause between them.`,
    "",
    "| Token | Status | Steps used | Model calls | Verdict | Sentences kept / dropped | Score | Score identical with and without Muse | Provider tokens | 8000-limit units | Time | Log |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "## Totals and averages",
    "",
    `- Tokens run: ${logs.length}. Finished with a cited conclusion: ${done.length}. Failed or not finished: ${failures.length}.`,
    `- Model calls: ${totalCalls}. Muse tokens (provider usage): ${totalTokens}.`,
    `- Estimated cost: ${cost}.`,
    `- Score identical with and without Muse: ${identicalCount} of ${logs.length}.`,
    `- Averages over finished runs: ${mean(done.map((log) => log.steps.length))} steps, ${mean(done.map((log) => log.tokens.total ?? 0))} tokens, ${mean(done.map((log) => log.durationMs / 1000))} s per token.`,
    `- Total time for all runs: ${totalSeconds.toFixed(1)} s.`,
    "",
    "## Failures",
    "",
    failureLines,
    "",
    "## Method",
    "",
    "- Analysis: the deterministic analysis runs once per token through the REST route's application service. The score envelope is serialized before and after the Muse loop; a matching hash means the loop left the score and evidence untouched.",
    "- Steps: the investigation trace (tool, reason, evidence ids). Model calls include the conclude call.",
    "- Sentences: the conclude draft is split with the app's splitter and each sentence is checked against the collected evidence with the app's citation check. Dropped sentences are listed in each JSON log.",
    "- Tokens: the provider's own usage figures per call, summed. Shown as n/a when the provider reports none.",
    "- Limits used: 8 steps, 8000 units and 60 s per investigation, plus a 5 s per-tool limit. Set explicitly in the script.",
    "- The 8000 limit is not a provider token count. The app charges each accepted decision its text length (rationale for a tool step, draft for the conclusion) plus 10, and stops at 8000 units. The column 8000-limit units shows that sum. Prompt tokens and model reasoning tokens are not counted against it. The Provider tokens column is the provider's own usage figure, summed over every call of the run, and is not capped by 8000.",
    "- The completion request asks the provider for at most min(8192, units left), so late in a run the allowance can be small.",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const env = loadEnvironment();
  const config = loadMcpAppConfig(env, (path) => readFileSync(path, "utf8"));
  if (env["BK_LIVE_DRY"] !== "1") {
    requireConfig(config);
  }

  const built = buildApp(config, { ports: await startupPorts(config) });
  const app = must(built, "app build");
  const service = must(
    createInvestigationServiceFromConfig(config, app.detectors, { transport: recordingTransport }),
    "investigation service",
  );

  const limitText = env["BK_LIVE_LIMIT"];
  const limit = limitText === undefined || limitText === "" ? TOKENS.length : Number(limitText);
  const selected = TOKENS.slice(0, Math.max(0, Math.min(TOKENS.length, limit)));
  const delayMs = Number(env["BK_LIVE_DELAY_MS"] ?? "5000");
  const priceText = env["BK_LIVE_USD_PER_MTOK"];
  const usdPerMillion = priceText === undefined || priceText === "" ? null : Number(priceText);
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const outDir = resolve(env["BK_LIVE_OUT_DIR"] ?? join(repoRoot, "docs", "live-investigations"));
  mkdirSync(outDir, { recursive: true });

  const logs: TokenLog[] = [];
  // BK_LIVE_SKIP_EXISTING=1 keeps a log already in the output folder
  // (from an earlier verified run of the same code) instead of paying again.
  const skipExisting = env["BK_LIVE_SKIP_EXISTING"] === "1";
  for (const [index, token] of selected.entries()) {
    const logPath = join(outDir, `${token.address}.json`);
    if (skipExisting && existsSync(logPath)) {
      const earlier = JSON.parse(readFileSync(logPath, "utf8")) as TokenLog;
      const reusedLog: TokenLog = {
        ...earlier,
        reused: true,
        budgetUnits: earlier.budgetUnits ?? budgetUnitsOf(earlier.steps, earlier.modelCalls),
      };
      logs.push(reusedLog);
      process.stdout.write(`[${index + 1}/${selected.length}] ${token.symbol}: ${reusedLog.status}, reused existing log\n`);
      continue;
    }
    let log: TokenLog;
    try {
      log = await investigateToken(app, service, token);
    } catch (error) {
      activeCalls = [];
      log = emptyLog(token, new Date().toISOString(), "error", error instanceof Error ? error.name : "unknown-error", 0);
    }
    logs.push(log);
    writeFileSync(logPath, redact(`${JSON.stringify(log, null, 2)}\n`));
    process.stdout.write(
      `[${index + 1}/${selected.length}] ${token.symbol}: ${log.status}, steps ${log.steps.length}, tokens ${log.tokens.total ?? "n/a"}, ${(log.durationMs / 1000).toFixed(1)} s\n`,
    );
    if (index < selected.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }
  const price = usdPerMillion !== null && Number.isFinite(usdPerMillion) ? usdPerMillion : null;
  writeFileSync(join(outDir, "SUMMARY.md"), redact(summaryOf(logs, price)));
  process.stdout.write(`wrote ${logs.length} logs and SUMMARY.md to ${outDir}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  void main().catch((error: unknown) => {
    fail(error instanceof Error ? error.message : "live run failed");
  });
}
