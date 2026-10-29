// Real-token smoke and eval harness (Task C).
// Run from the repo root with `npm run smoke:real`: reads a JSON fixture of
// labelled tokens whose path comes ONLY from the BK_REAL_TOKENS environment
// variable (no default path exists anywhere in the repo), runs the full
// deterministic offline analysis through the same application service the
// REST and MCP interfaces use, and writes a Markdown report to the path in
// BK_SMOKE_OUT. The report names tokens by SYMBOL ONLY: addresses,
// code hashes and bytecode never reach the report or stdout. If
// extdecomp_BIN is set, the same bytecode is also run through the existing
// extdecomp adapter on local bytecode only (HOME set to a fresh temp dir,
// never -r/RPC/LLM flags) and the decompile outcomes are compared.
// No network access happens anywhere in this script.
import { Ajv } from "ajv";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Address,
  BlockNumber,
  CodeHash,
  IndexVersion,
  ModelVersion,
  RequestId,
  TemplateVersion,
  Timestamp,
} from "../src/domain/types.ts";
import type {
  Address as AddressType,
  BlockNumber as BlockNumberType,
} from "../src/domain/types.ts";
import { extractSelectors } from "../src/domain/selectors.ts";
import { createAppServices } from "../src/application/analyzeToken.ts";
import type { AppServices } from "../src/application/analyzeToken.ts";
import { buildDetectorSet } from "../src/composition/root.ts";
import { verifyArtifactFile } from "../src/domain/artifact.ts";
import type { ModelArtifactError } from "../src/ports/modelArtifact.ts";
import type { LoadedArtifact, ModelArtifactPort } from "../src/ports/modelArtifact.ts";
import type { ModelVersion as ModelVersionType } from "../src/domain/types.ts";
import type { CapabilityCatalogue } from "../src/domain/signals.ts";
import { extdecompAdapter } from "../src/adapters/extdecomp/extdecompAdapter.ts";
import type { Result } from "../src/domain/result.ts";
import type {
  BlockReceipt,
  BytecodeResult,
  CallContext,
  ChainLog,
  RpcError,
  RpcPort,
} from "../src/ports/rpc.ts";
import type { CallData as CallDataType, StorageWord as StorageWordType } from "../src/domain/types.ts";
import { Bytecode as BytecodeValue, StorageWord } from "../src/domain/types.ts";

const PER_TOKEN_TIMEOUT_MS = 30000;
const extdecomp_TIMEOUT_MS = 25000;
const ZERO_WORD = `0x${"0".repeat(64)}`;

// Frozen model, index and template versions the offline run pins (K-102):
// an artifact the repo ships in model/. BK_SMOKE_MODEL_VERSION selects
// another shipped artifact; the default is the documented default artifact.
const DEFAULT_MODEL_VERSION_TEXT = "1.0.1";
const INDEX_VERSION_TEXT = "1.0.0";
const TEMPLATE_VERSION_TEXT = "1.0.0";

export type SmokeLabel = "legit" | "rug" | "honeypot" | "scam" | "unknown";

export type SmokeLabelBasis = "dataset" | "incident-report" | "token-list";

export type SmokeToken = {
  readonly address: string;
  readonly symbol: string;
  readonly name: string;
  readonly label: SmokeLabel;
  readonly labelSource?: string | undefined;
  readonly labelNote?: string | undefined;
  readonly labelBasis?: SmokeLabelBasis | undefined;
  readonly block: number;
  readonly codehash: string;
  readonly bytecode: string;
  readonly features?: unknown;
  readonly implementation?: { readonly address: string; readonly bytecode: string } | undefined;
};

export type InvalidEntry = {
  readonly index: number;
  readonly symbol: string | null;
  readonly errors: readonly string[];
};

export type SmokeBand = "Low" | "Elevated" | "High";

export type extdecompOutcome = {
  readonly success: boolean;
  readonly functions: number;
  readonly ownSelectors: number;
};

export type SmokeOutcome =
  | {
      readonly status: "ok";
      readonly symbol: string;
      readonly label: SmokeLabel;
      readonly proxy: boolean;
      readonly score: number;
      readonly band: SmokeBand;
      readonly topEvidence: readonly string[];
      readonly firedPlugins?: readonly string[] | undefined;
      readonly runtimeMs: number;
      readonly ownSelectors: number;
      readonly extdecomp?: extdecompOutcome | undefined;
    }
  | {
      readonly status: "timeout" | "crash";
      readonly symbol: string;
      readonly label: SmokeLabel;
      readonly proxy: boolean;
      readonly runtimeMs: number;
      readonly error: string;
    };

// Bands match the web UI thresholds (apps/web/src/lib/risk.ts): Low
// 0-29, Elevated 30-59, High 60-100.
export function bandOf(score: number): SmokeBand {
  if (score < 30) {
    return "Low";
  }
  if (score < 60) {
    return "Elevated";
  }
  return "High";
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) {
    return ordered[middle] ?? 0;
  }
  return ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
}

// Never print addresses, code hashes or bytecode: 0x-prefixed 40-hex
// addresses, bare or prefixed 64-hex digests and any other long hex run
// become placeholders. Applied to every error string and every derived
// evidence line before it reaches the report or stdout.
export function sanitize(text: string): string {
  return text
    .replace(/0x[0-9a-fA-F]{64}/g, "[hash]")
    .replace(/\b[0-9a-fA-F]{64}\b/g, "[hash]")
    .replace(/0x[0-9a-fA-F]{40}/g, "[address]")
    .replace(/0x[0-9a-fA-F]{20,}/g, "[bytes]");
}

// Fixture validation with ajv (the repo's validation library): per-entry
// reports instead of a crash, so one bad row never stops the run. The
// shape mirrors the documented contract: address, symbol, name, a closed
// label, block, codehash and bytecode, with an optional proxy
// implementation carrying its own address and bytecode.
const FIXTURE_SCHEMA = {
  type: "object",
  required: ["address", "symbol", "name", "label", "block", "codehash", "bytecode"],
  properties: {
    address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
    symbol: { type: "string", minLength: 1, maxLength: 64 },
    name: { type: "string", minLength: 1, maxLength: 256 },
    label: { enum: ["legit", "rug", "honeypot", "scam", "unknown"] },
    // Long provenance strings (list URLs with query parameters) validate
    // up to 4096 characters; the report never prints these fields, so no
    // display truncation is needed on the report path.
    labelSource: { type: "string", maxLength: 4096 },
    labelNote: { type: "string", maxLength: 4096 },
    labelBasis: { enum: ["dataset", "incident-report", "token-list"] },
    block: { type: "integer", minimum: 0 },
    codehash: { type: "string", pattern: "^0x[0-9a-fA-F]+$" },
    bytecode: { type: "string", pattern: "^0x[0-9a-fA-F]*$" },
    implementation: {
      type: "object",
      required: ["address", "bytecode"],
      properties: {
        address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
        bytecode: { type: "string", pattern: "^0x[0-9a-fA-F]*$" },
      },
    },
  },
} as const;

const ajv = new Ajv({ allErrors: true });
const validateEntry = ajv.compile(FIXTURE_SCHEMA);

export function validateFixture(raw: unknown): { tokens: SmokeToken[]; invalid: InvalidEntry[] } {
  if (!Array.isArray(raw)) {
    return { tokens: [], invalid: [{ index: -1, symbol: null, errors: ["fixture must be an array of token entries"] }] };
  }
  const tokens: SmokeToken[] = [];
  const invalid: InvalidEntry[] = [];
  raw.forEach((entry: unknown, index: number) => {
    const symbol = typeof (entry as { symbol?: unknown } | null)?.symbol === "string" ? (entry as { symbol: string }).symbol : null;
    if (validateEntry(entry)) {
      tokens.push(entry as SmokeToken);
    } else {
      const errors = (validateEntry.errors ?? []).map((error) => sanitize(`${error.instancePath} ${error.message}`));
      invalid.push({ index, symbol, errors: errors.length === 0 ? ["entry failed validation"] : errors });
    }
  });
  return { tokens, invalid };
}

export type ConfusionSummary = {
  readonly counts: Record<"legit" | "bad" | "unknown", Record<SmokeBand, number>>;
  readonly legitHighRisk: readonly string[];
  readonly badLowRisk: readonly string[];
  readonly scored: number;
};

// Confusion over the scored tokens: legit versus bad (rug, honeypot and
// scam). Unknown labels are counted beside, never inside either side.
// High-risk means band High, low-risk means band Low. Misses are named by
// symbol only.
export function confusionSummary(outcomes: readonly SmokeOutcome[]): ConfusionSummary {
  const counts: Record<"legit" | "bad" | "unknown", Record<SmokeBand, number>> = {
    legit: { Low: 0, Elevated: 0, High: 0 },
    bad: { Low: 0, Elevated: 0, High: 0 },
    unknown: { Low: 0, Elevated: 0, High: 0 },
  };
  const legitHighRisk: string[] = [];
  const badLowRisk: string[] = [];
  let scored = 0;
  for (const outcome of outcomes) {
    if (outcome.status !== "ok") {
      continue;
    }
    scored += 1;
    const group = outcome.label === "legit" ? "legit" : outcome.label === "unknown" ? "unknown" : "bad";
    counts[group][outcome.band] += 1;
    if (group === "legit" && outcome.band === "High") {
      legitHighRisk.push(outcome.symbol);
    }
    if (group === "bad" && outcome.band === "Low") {
      badLowRisk.push(outcome.symbol);
    }
  }
  return { counts, legitHighRisk: Object.freeze(legitHighRisk), badLowRisk: Object.freeze(badLowRisk), scored };
}

export type extdecompReport = {
  readonly enabled: boolean;
  readonly successRate: number;
  readonly meanFunctions: number;
  readonly meanOwnSelectors: number;
  readonly deltas: readonly { symbol: string; extdecompFunctions: number; ownSelectors: number; success: boolean }[];
};

function extdecompReportOf(outcomes: readonly SmokeOutcome[]): extdecompReport {
  const rows = outcomes.filter((outcome) => outcome.status === "ok" && outcome.extdecomp !== undefined);
  if (rows.length === 0) {
    return { enabled: false, successRate: 0, meanFunctions: 0, meanOwnSelectors: 0, deltas: [] };
  }
  const successes = rows.filter((row) => row.status === "ok" && row.extdecomp?.success === true);
  const deltas = rows.map((row) => {
    const extdecomp = row.status === "ok" ? row.extdecomp : undefined;
    return {
      symbol: row.symbol,
      extdecompFunctions: extdecomp?.functions ?? 0,
      ownSelectors: extdecomp?.ownSelectors ?? 0,
      success: extdecomp?.success ?? false,
    };
  });
  return {
    enabled: true,
    successRate: successes.length / rows.length,
    meanFunctions: mean(deltas.map((row) => row.extdecompFunctions)),
    meanOwnSelectors: mean(deltas.map((row) => row.ownSelectors)),
    deltas: Object.freeze(deltas),
  };
}

// Pure report builder: the same Markdown the script writes, testable
// without files, binaries or the network. Symbols only; every derived
// line passes through sanitize before it lands in the text.
export function buildReport(input: {
  readonly outcomes: readonly SmokeOutcome[];
  readonly invalid: readonly InvalidEntry[];
  readonly extdecomp: extdecompReport;
  readonly totalMs: number;
  readonly startedAt: string;
}): string {
  const { outcomes, invalid, extdecomp, totalMs, startedAt } = input;
  const confusion = confusionSummary(outcomes);
  const ok = outcomes.filter((outcome) => outcome.status === "ok");
  const lines: string[] = [];
  lines.push("# Real-token smoke report");
  lines.push("");
  lines.push(`Started: ${startedAt}. Tokens listed: ${outcomes.length}. Total runtime: ${(totalMs / 1000).toFixed(1)} s.`);
  lines.push("");
  lines.push("## Per-token results");
  lines.push("");
  lines.push("| Symbol | Label | Proxy | Score | Band | Top evidence | Runtime ms | Error |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const outcome of outcomes) {
    if (outcome.status === "ok") {
      const evidence = outcome.topEvidence.length === 0 ? "-" : outcome.topEvidence.map(sanitize).join("; ");
      lines.push(
        `| ${sanitize(outcome.symbol)} | ${outcome.label} | ${outcome.proxy ? "yes" : "no"} | ${outcome.score} | ${outcome.band} | ${evidence} | ${outcome.runtimeMs} | - |`,
      );
    } else {
      lines.push(
        `| ${sanitize(outcome.symbol)} | ${outcome.label} | ${outcome.proxy ? "yes" : "no"} | - | - | - | ${outcome.runtimeMs} | ${sanitize(outcome.error)} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Confusion summary");
  lines.push("");
  lines.push(`Scored tokens: ${confusion.scored}. Legit versus bad (rug, honeypot, scam).`);
  lines.push("");
  lines.push("| Group | Low | Elevated | High |");
  lines.push("|---|---|---|---|");
  for (const group of ["legit", "bad", "unknown"] as const) {
    lines.push(`| ${group} | ${confusion.counts[group].Low} | ${confusion.counts[group].Elevated} | ${confusion.counts[group].High} |`);
  }
  lines.push("");
  lines.push(`Legit scored high-risk: ${confusion.legitHighRisk.length}. Bad scored low-risk: ${confusion.badLowRisk.length}.`);
  if (confusion.legitHighRisk.length > 0) {
    lines.push(`Obvious misses (legit, high band): ${confusion.legitHighRisk.map(sanitize).join(", ")}.`);
  }
  if (confusion.badLowRisk.length > 0) {
    lines.push(`Obvious misses (bad, low band): ${confusion.badLowRisk.map(sanitize).join(", ")}.`);
  }
  lines.push("");
  lines.push("## Score by label");
  lines.push("");
  lines.push("| Label | Count | Mean | Median |");
  lines.push("|---|---|---|---|");
  for (const label of ["legit", "rug", "honeypot", "scam", "unknown"] as const) {
    const scores = ok.filter((outcome) => outcome.label === label).map((outcome) => (outcome.status === "ok" ? outcome.score : 0));
    lines.push(`| ${label} | ${scores.length} | ${mean(scores).toFixed(1)} | ${median(scores).toFixed(1)} |`);
  }
  lines.push("");
  lines.push(...detectorFireRateLines(ok));
  lines.push("## Crashes and timeouts");
  lines.push("");
  const failures = outcomes.filter((outcome) => outcome.status !== "ok");
  if (failures.length === 0) {
    lines.push("No crashes or timeouts.");
  } else {
    for (const failure of failures) {
      lines.push(`- ${sanitize(failure.symbol)} (${failure.status}): ${sanitize(failure.error)}`);
    }
  }
  lines.push("");
  lines.push("## extdecomp comparison");
  lines.push("");
  if (!extdecomp.enabled) {
    lines.push("extdecomp comparison skipped: extdecomp_BIN is unset.");
  } else {
    lines.push(
      `Decompile success rate: ${(extdecomp.successRate * 100).toFixed(1)}%. Mean functions per token (extdecomp): ${extdecomp.meanFunctions.toFixed(1)}. Mean selectors per token (own pipeline): ${extdecomp.meanOwnSelectors.toFixed(1)}.`,
    );
    lines.push("");
    lines.push("| Symbol | extdecomp functions | Own selectors | Decompiled |");
    lines.push("|---|---|---|---|");
    for (const delta of extdecomp.deltas) {
      lines.push(`| ${sanitize(delta.symbol)} | ${delta.extdecompFunctions} | ${delta.ownSelectors} | ${delta.success ? "yes" : "no"} |`);
    }
  }
  lines.push("");
  lines.push("## Invalid entries");
  lines.push("");
  if (invalid.length === 0) {
    lines.push("No invalid entries.");
  } else {
    for (const entry of invalid) {
      lines.push(`- row ${entry.index} (${entry.symbol === null ? "no symbol" : sanitize(entry.symbol)}): ${entry.errors.map(sanitize).join("; ")}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

// Injected runners keep runSmoke testable: tests pass a mock analyze
// function and a mock decompiler, while main wires the real application
// service and the real extdecomp adapter.
// Per-label share of scored tokens on which each detector plugin reported
// at least one finding.
export function detectorFireRateLines(ok: readonly SmokeOutcome[]): string[] {
  const labels = ["legit", "rug", "honeypot", "scam", "unknown"] as const;
  const plugins = [...new Set(ok.flatMap((outcome) => (outcome.status === "ok" ? (outcome.firedPlugins ?? []) : [])))].sort();
  const lines = ["## Detector fire rates by label", ""];
  if (plugins.length === 0) {
    lines.push("No detector findings were reported.", "");
    return lines;
  }
  lines.push(`| Plugin | ${labels.join(" | ")} |`);
  lines.push(`|---|${labels.map(() => "---").join("|")}|`);
  for (const plugin of plugins) {
    const cells = labels.map((label) => {
      const group = ok.filter((outcome) => outcome.label === label);
      if (group.length === 0) {
        return "-";
      }
      const fired = group.filter((outcome) => outcome.status === "ok" && (outcome.firedPlugins ?? []).includes(plugin)).length;
      return `${fired}/${group.length}`;
    });
    lines.push(`| ${sanitize(plugin)} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  return lines;
}

export type AnalyzeFn = (token: SmokeToken) => Promise<{ score: number; topEvidence: string[]; firedPlugins?: string[] }>;
export type DecompileFn = (bytecodeHex: string) => Promise<{ success: boolean; functions: number }>;

export type RunSmokeDeps = {
  readonly analyze: AnalyzeFn;
  readonly decompile?: DecompileFn | undefined;
  readonly timeoutMs?: number | undefined;
  readonly clock?: (() => number) | undefined;
};

function effectiveBytecodeOf(token: SmokeToken): string {
  return token.implementation?.bytecode ?? token.bytecode;
}

function ownSelectorCount(bytecodeHex: string): number {
  const parsed = BytecodeValue.parse(bytecodeHex);
  if (!parsed.ok) {
    return 0;
  }
  return extractSelectors(parsed.value).length;
}

export async function runSmoke(
  tokens: readonly SmokeToken[],
  deps: RunSmokeDeps,
): Promise<{ outcomes: SmokeOutcome[]; totalMs: number }> {
  const timeoutMs = deps.timeoutMs ?? PER_TOKEN_TIMEOUT_MS;
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const outcomes: SmokeOutcome[] = [];
  for (const token of tokens) {
    const proxy = token.implementation !== undefined;
    const tokenStarted = clock();
    const bytecodeHex = effectiveBytecodeOf(token);
    const ownSelectors = ownSelectorCount(bytecodeHex);
    let timedOut = false;
    try {
      const analyzed = await Promise.race([
        deps.analyze(token),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            timedOut = true;
            reject(new Error(`analysis timed out after ${timeoutMs} ms`));
          }, timeoutMs);
        }),
      ]);
      let extdecomp: extdecompOutcome | undefined;
      if (deps.decompile !== undefined) {
        try {
          const decompiled = await deps.decompile(bytecodeHex);
          extdecomp = { success: decompiled.success, functions: decompiled.functions, ownSelectors };
        } catch {
          extdecomp = { success: false, functions: 0, ownSelectors };
        }
      }
      const score = Math.min(100, Math.max(0, Math.round(analyzed.score)));
      outcomes.push({
        status: "ok",
        symbol: token.symbol,
        label: token.label,
        proxy,
        score,
        band: bandOf(score),
        topEvidence: Object.freeze(analyzed.topEvidence.slice(0, 3).map(sanitize)),
        firedPlugins: Object.freeze([...(analyzed.firedPlugins ?? [])].map(sanitize)),
        runtimeMs: clock() - tokenStarted,
        ownSelectors,
        ...(extdecomp === undefined ? {} : { extdecomp }),
      });
    } catch (error) {
      const runtimeMs = clock() - tokenStarted;
      const message = error instanceof Error ? error.message : "analysis crashed";
      outcomes.push({
        status: timedOut ? "timeout" : "crash",
        symbol: token.symbol,
        label: token.label,
        proxy,
        runtimeMs,
        error: sanitize(message),
      });
    }
  }
  return { outcomes, totalMs: clock() - started };
}

// Offline RpcPort stub: serves the fixture bytecode for known addresses
// and the typed no-code branch otherwise. Storage reads as zero, matching
// chain behaviour for unwritten slots; calls are unsupported offline, and
// the block number is the highest fixture block.
function createFixtureRpc(codes: ReadonlyMap<string, string>, headBlock: BlockNumberType): RpcPort {
  return {
    async getCode(address: AddressType): Promise<Result<BytecodeResult, RpcError>> {
      const raw = codes.get((address as string).toLowerCase());
      if (raw === undefined) {
        return { ok: false, error: { kind: "no-code", message: "no code at the requested address" } };
      }
      const parsed = BytecodeValue.parse(raw);
      if (!parsed.ok) {
        return { ok: false, error: { kind: "invalid-response", message: "fixture bytecode failed validation" } };
      }
      return { ok: true, value: { bytecode: parsed.value, block: headBlock } };
    },
    async getStorageAt(): Promise<Result<StorageWordType, RpcError>> {
      const parsed = StorageWord.parse(ZERO_WORD);
      if (!parsed.ok) {
        return { ok: false, error: { kind: "invalid-response", message: "zero word failed validation" } };
      }
      return { ok: true, value: parsed.value };
    },
    async call(): Promise<Result<CallDataType, RpcError>> {
      return { ok: false, error: { kind: "invalid-response", message: "fixture rpc carries no call support" } };
    },
    async getBlockNumber(): Promise<Result<BlockNumberType, RpcError>> {
      return { ok: true, value: headBlock };
    },
    async getLogs(): Promise<Result<readonly ChainLog[], RpcError>> {
      return { ok: true, value: Object.freeze([]) };
    },
    async getBlockReceipts(): Promise<Result<readonly BlockReceipt[], RpcError>> {
      return { ok: true, value: Object.freeze([]) };
    },
  };
}

function mustParse<T>(parsed: Result<T, { message: string }>, what: string): T {
  if (!parsed.ok) {
    throw new Error(`smoke-real-tokens: invalid ${what}: ${parsed.error.message}`);
  }
  return parsed.value;
}

// File-backed ModelArtifactPort over the frozen repo artifact: reads
// `artifact-<version>.json` from the given directory and verifies shape
// and SHA-256 checksum through the pure domain verifier, mirroring the
// production file adapter without importing it.
function createFileModelArtifactAdapter(directory: string): ModelArtifactPort {
  return {
    load(version: ModelVersionType): Result<LoadedArtifact, ModelArtifactError> {
      const versionText = version as string;
      if (versionText.includes("/") || versionText.includes("\\") || versionText.includes("..")) {
        return { ok: false, error: { kind: "unknown-version", message: `unknown model version: ${versionText}` } };
      }
      let raw: string;
      try {
        raw = readFileSync(join(directory, `artifact-${versionText}.json`), "utf8");
      } catch {
        return { ok: false, error: { kind: "unknown-version", message: `unknown model version: ${versionText}` } };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        return { ok: false, error: { kind: "artifact-malformed", message: `model artifact for ${versionText} is not valid JSON` } };
      }
      const verified = verifyArtifactFile(parsed);
      if (!verified.ok) {
        if (verified.error.kind === "checksum-mismatch") {
          return { ok: false, error: { kind: "checksum-mismatch", message: verified.error.message } };
        }
        return { ok: false, error: { kind: "artifact-malformed", message: verified.error.message } };
      }
      if ((verified.value.artifact.version as string) !== versionText) {
        return { ok: false, error: { kind: "unknown-version", message: `unknown model version: ${versionText}` } };
      }
      return { ok: true, value: { artifact: verified.value.artifact, checksum: verified.value.checksum } };
    },
  };
}

// Operational capability catalogue for the offline run (K-102, K-210):
// the same v1 mapping the composed servers pin, written here so the
// script never imports the server composition graph.
export const OFFLINE_CAPABILITY_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

// The same application service the REST and MCP interfaces use, wired for
// offline fixtures: the fixture stub behind RpcPort, the frozen repo
// artifact behind ModelArtifactPort, a fixed clock, the default detector
// set and no decompiler, assessment providers or network of any kind.
function createOfflineAnalyzer(tokens: readonly SmokeToken[]): AnalyzeFn {
  const codes = new Map<string, string>();
  let headBlock = 0;
  for (const token of tokens) {
    headBlock = Math.max(headBlock, token.block);
    for (const [address, bytecode] of [
      [token.address, token.bytecode],
      ...(token.implementation === undefined
        ? []
        : [[token.implementation.address, token.implementation.bytecode] as const]),
    ]) {
      const parsedAddress = Address.parse(address);
      if (parsedAddress.ok) {
        codes.set((parsedAddress.value as string).toLowerCase(), bytecode);
      }
    }
  }
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = dirname(scriptDir);
  const services: AppServices = createAppServices(
    {
      rpc: createFixtureRpc(codes, mustParse(BlockNumber.of(headBlock), "fixture block")),
      modelArtifacts: createFileModelArtifactAdapter(join(repoRoot, "model")),
      clock: { now: () => mustParse(Timestamp.of(Date.now()), "clock time") },
    },
    (() => {
      const built = buildDetectorSet();
      if (!built.ok) {
        throw new Error(`smoke-real-tokens: detector set failed to build: ${built.error.kind}`);
      }
      return built.value;
    })(),
  );
  const modelVersion = mustParse(ModelVersion.parse(process.env["BK_SMOKE_MODEL_VERSION"] ?? DEFAULT_MODEL_VERSION_TEXT), "model version");
  const indexVersion = mustParse(IndexVersion.parse(INDEX_VERSION_TEXT), "index version");
  const templateVersion = mustParse(TemplateVersion.parse(TEMPLATE_VERSION_TEXT), "template version");
  return async (token: SmokeToken): Promise<{ score: number; topEvidence: string[]; firedPlugins: string[] }> => {
    const target = token.implementation?.address ?? token.address;
    const address = mustParse(Address.parse(target), "token address");
    const block = mustParse(BlockNumber.of(token.block), "token block");
    const requestId = mustParse(
      RequestId.parse(`00000000-0000-4000-8000-${(Math.abs(hashSymbol(token.symbol)) % 0xffffffffffff).toString(16).padStart(12, "0")}`),
      "request id",
    );
    const deadline = mustParse(Timestamp.of(Date.now() + PER_TOKEN_TIMEOUT_MS + 5000), "deadline");
    const analyzed = await services.analyzeToken({
      address,
      block,
      requestId,
      deadline,
      modelVersion,
      indexVersion,
      templateVersion,
      catalogue: OFFLINE_CAPABILITY_CATALOGUE,
    });
    if (!analyzed.ok) {
      if (analyzed.error.kind === "rpc-error" && analyzed.error.error.kind === "no-code") {
        throw new Error("no contract code at the listed address");
      }
      const detail =
        analyzed.error.kind === "rpc-error"
          ? analyzed.error.error.message
          : analyzed.error.kind === "model-artifact-error"
            ? analyzed.error.error.message
            : analyzed.error.error.message;
      throw new Error(`analysis failed: ${detail}`);
    }
    if (analyzed.value.kind === "no-contract") {
      throw new Error("no contract code at the listed address");
    }
    const envelope = analyzed.value.envelope;
    const topEvidence = envelope.signals.slice(0, 3).map((signal) => {
      const first = signal.evidence[0];
      const selector = first === undefined ? "no selector" : (first.selector as string);
      return `${signal.kind}:${signal.risk} via selector ${selector}`;
    });
    const firedPlugins = envelope.pluginResults
      .filter((entry) => entry.findings.length > 0)
      .map((entry) => (entry.pluginId as string).replace(/^dev\.brandklipparen\./, ""));
    return { score: envelope.score as number, topEvidence, firedPlugins };
  };
}

function hashSymbol(symbol: string): number {
  let hash = 0;
  for (let index = 0; index < symbol.length; index += 1) {
    hash = (hash * 31 + (symbol.codePointAt(index) ?? 0)) | 0;
  }
  return hash;
}

// extdecomp on the same bytecode through the existing adapter: local
// bytecode only, HOME set to a fresh temp dir for the run, never -r, RPC
// or LLM flags. The binary path arrives from extdecomp_BIN only.
async function runextdecompOn(bytecodeHex: string, extdecompBin: string): Promise<{ success: boolean; functions: number }> {
  const bytecode = mustParse(BytecodeValue.parse(bytecodeHex), "token bytecode");
  const codeHash = mustParse(CodeHash.of(bytecode), "token code hash");
  const adapter = new extdecompAdapter({ binaryPath: extdecompBin, timeoutMs: extdecomp_TIMEOUT_MS });
  const requestId = mustParse(RequestId.parse("123e4567-e89b-12d3-a456-426614174000"), "request id");
  const deadline = mustParse(Timestamp.of(Date.now() + extdecomp_TIMEOUT_MS + 5000), "deadline");
  const block = mustParse(BlockNumber.of(1), "block");
  const ctx: CallContext = { requestId, deadline, block };
  const home = mkdtempSync(join(tmpdir(), "smoke-extdecomp-home-"));
  const previousHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    const decompiled = await adapter.decompile(bytecode, codeHash, ctx);
    if (!decompiled.ok) {
      return { success: false, functions: 0 };
    }
    return { success: true, functions: decompiled.value.functions.length };
  } catch {
    return { success: false, functions: 0 };
  } finally {
    if (previousHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = previousHome;
    }
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // Best effort: a leftover temp dir never fails the report.
    }
  }
}

function fail(message: string, code: number): never {
  process.stderr.write(`smoke-real-tokens: ${message}\n`);
  process.exit(code);
}

const invokedAsScript = (process.argv[1] ?? "").endsWith("smoke-real-tokens.ts");

if (invokedAsScript) {
  await main();
}

async function main(): Promise<void> {
  const fixturePath = process.env["BK_REAL_TOKENS"];
  if (fixturePath === undefined || fixturePath.length === 0) {
    fail("set BK_REAL_TOKENS to the fixture path (no default fixture path is used)", 2);
  }
  let raw: string;
  try {
    raw = readFileSync(fixturePath, "utf8");
  } catch {
    fail(`cannot read fixture at BK_REAL_TOKENS`, 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    fail("fixture is not valid JSON", 1);
  }
  const { tokens, invalid } = validateFixture(parsed);
  const outPath = process.env["BK_SMOKE_OUT"];
  if (outPath === undefined || outPath.length === 0) {
    fail("set BK_SMOKE_OUT to the report output path", 2);
  }
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = dirname(scriptDir);
  const resolvedOut = resolve(outPath);
  const relativeOut = relative(repoRoot, resolvedOut);
  if (relativeOut === "" || (!relativeOut.startsWith("..") && !isAbsolute(relativeOut))) {
    fail("refuses to write the report inside the repo working tree", 1);
  }
  if (tokens.length === 0) {
    const empty = buildReport({
      outcomes: [],
      invalid,
      extdecomp: { enabled: false, successRate: 0, meanFunctions: 0, meanOwnSelectors: 0, deltas: [] },
      totalMs: 0,
      startedAt: new Date().toISOString(),
    });
    mkdirSync(dirname(resolvedOut), { recursive: true });
    writeFileSync(resolvedOut, empty);
    fail("no valid token entries in the fixture (report still written)", 1);
  }
  const startedAt = new Date().toISOString();
  const analyze = createOfflineAnalyzer(tokens);
  const extdecompBin = process.env["extdecomp_BIN"];
  const decompile: DecompileFn | undefined =
    extdecompBin === undefined || extdecompBin.length === 0
      ? undefined
      : (bytecodeHex: string) => runextdecompOn(bytecodeHex, extdecompBin);
  const started = Date.now();
  const { outcomes } = await runSmoke(tokens, { analyze, decompile });
  const totalMs = Date.now() - started;
  const markdown = buildReport({
    outcomes,
    invalid,
    extdecomp: extdecompReportOf(outcomes),
    totalMs,
    startedAt,
  });
  mkdirSync(dirname(resolvedOut), { recursive: true });
  writeFileSync(resolvedOut, markdown);
  const scored = outcomes.filter((outcome) => outcome.status === "ok");
  const confusion = confusionSummary(outcomes);
  const lines = [
    `smoke-real: ${scored.length}/${outcomes.length} tokens scored, ${invalid.length} invalid entries, ${(totalMs / 1000).toFixed(1)} s total.`,
    `legit high-risk: ${confusion.legitHighRisk.length}; bad low-risk: ${confusion.badLowRisk.length}.`,
    `mean score by label: ${["legit", "rug", "honeypot", "scam", "unknown"]
      .map((label) => {
        const scores = scored.filter((outcome) => outcome.label === label).map((outcome) => (outcome.status === "ok" ? outcome.score : 0));
        return `${label} ${mean(scores).toFixed(1)}`;
      })
      .join(", ")}.`,
    extdecompBin === undefined ? "extdecomp comparison skipped: extdecomp_BIN is unset." : `extdecomp compared on ${scored.length} tokens.`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

