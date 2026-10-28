// Differential eval harness: own pipeline versus extdecomp on the frozen
// ERC-20 corpus (S-082, K-038, K-521, D-09, D-10, M-47). Dev/eval only:
// no runtime code imports this module and the runtime suite passes with
// `extdecomp_BIN` unset. The harness invokes only the binary named by
// `extdecomp_BIN` with `extdecomp decompile <hex-or-file> --include-sol`
// over local corpus files, checks `extdecomp --version` against the pinned expected
// `0.9.1`, runs each invocation with its working directory set to a fresh
// temp dir (and `HOME` set to a second fresh temp dir), reads the
// generated files from under the work dir's `output/` directory besides
// stdout, deletes both temp dirs afterwards, and never passes RPC,
// target-address, LLM or naming flags of any kind. The
// binary's location on the operator machine is operator-local: tracked
// files name only the `extdecomp_BIN` variable, never a path. Usage:
//   extdecomp_BIN=/path/to/extdecomp node --experimental-strip-types scripts/eval-decompiler.ts
// Without `extdecomp_BIN` the harness evaluates the own pipeline, marks
// every extdecomp column `not-run`, and exits 0.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Bytecode } from "../src/domain/types.ts";
import { decompileContract } from "../src/domain/evmSsa.ts";
import { lift } from "../src/domain/evmLift.ts";
import { nameForSelector } from "../src/domain/evmNames.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const CORPUS_DIR = join(repoRoot, "tests", "fixtures", "evm", "corpus");
const RESULTS_DOC = join(repoRoot, "docs", "eval-decompiler-results.md");

// Pinned expected extdecomp version (D-10). A mismatch fails the eval
// with both strings named; nothing here installs or upgrades a binary.
export const EXPECTED_extdecomp_VERSION = "0.9.1";
export const EVAL_PASS_TOLERANCE_POINTS = 3;

// Local-bytecode-only invocation (D-09, M-47): `decompile` plus the
// local hex or file input plus `--include-sol` so the run also writes
// `output/local/decompiled.sol` locally (the default run writes only
// `output/local/abi.json`, which carries names without selector hex).
// No RPC flag, no address, no network option, no LLM or naming flag
// exists on this path by construction.
export function buildextdecompArgs(input: string): readonly string[] {
  return Object.freeze(["decompile", input, "--include-sol"]);
}

// Selector matching over extdecomp output text (stdout plus every file
// under the work dir `output/`). extdecomp 0.9.1 emits selectors as
// `/// @custom:selector 0x...` lines in `decompiled.sol`, as
// `Unresolved_<bare>` function names for unresolved entries, and as
// bare hex inside `.yul` output; `abi.json` alone carries names without
// hex. Matching is case-insensitive and accepts the bare form, so each
// wanted entry matches its `0x` form or its bare form anywhere.
export function findMentionedSelectors(combined: string, wanted: readonly string[]): readonly string[] {
  const lowered = combined.toLowerCase();
  return Object.freeze(
    wanted.filter((item) => {
      const norm = item.toLowerCase();
      const bare = norm.startsWith("0x") ? norm.slice(2) : norm;
      if (bare.length === 0) {
        return false;
      }
      return lowered.includes(`0x${bare}`) || lowered.includes(bare);
    }),
  );
}

export function checkextdecompVersion(reported: string): { ok: true } | { ok: false; expected: string; reported: string } {
  const clean = reported.trim();
  if (clean === EXPECTED_extdecomp_VERSION || clean.endsWith(` ${EXPECTED_extdecomp_VERSION}`)) {
    return { ok: true };
  }
  return { ok: false, expected: EXPECTED_extdecomp_VERSION, reported: clean };
}

export type SpotCheck = { readonly fragment: string; readonly present: boolean };
export type ContractExpectation = {
  readonly id: string;
  readonly file: string;
  readonly selectors: readonly string[];
  readonly functions: readonly {
    readonly selector: string;
    readonly name: string;
    readonly entryPc: number;
    readonly cause: string | null;
  }[];
  readonly patterns: readonly string[];
  readonly spotChecks: readonly SpotCheck[];
  readonly k523: readonly string[];
};

export type ContractEval = {
  readonly id: string;
  readonly ownFunctions: number;
  readonly expectedFunctions: number;
  readonly entriesMatch: boolean;
  readonly patternsMatch: boolean;
  readonly spotAgreed: number;
  readonly spotTotal: number;
  readonly ownUnresolved: number;
  readonly offsetCoverage: number;
  readonly passed: boolean;
  readonly extdecomp:
    | { readonly status: "not-run" }
    | {
        readonly status: "ok";
        readonly selectorsMentioned: readonly string[];
        readonly version: string;
      }
    | {
        readonly status: "failed";
        readonly version: string;
        readonly inputDigest: string;
      };
};

export function evaluateOwn(hex: string, expectation: ContractExpectation): Omit<ContractEval, "extdecomp"> {
  const parsed = Bytecode.parse(hex);
  if (!parsed.ok) {
    return {
      id: expectation.id,
      ownFunctions: 0,
      expectedFunctions: expectation.functions.length,
      entriesMatch: false,
      patternsMatch: false,
      spotAgreed: 0,
      spotTotal: expectation.spotChecks.length,
      ownUnresolved: 0,
      offsetCoverage: 0,
      passed: false,
    };
  }
  const decompiled = decompileContract(parsed.value);
  const bySelector = new Map(decompiled.functions.map((fn) => [fn.selector.toLowerCase(), fn]));
  let entriesMatch = decompiled.functions.length === expectation.functions.length;
  for (const expected of expectation.functions) {
    const actual = bySelector.get(expected.selector.toLowerCase());
    if (
      actual === undefined ||
      actual.name !== expected.name ||
      actual.entryPc !== expected.entryPc ||
      (actual.cause ?? null) !== expected.cause
    ) {
      entriesMatch = false;
    }
  }
  const patternsMatch = expectation.patterns.every((pattern) => decompiled.text.includes(pattern));
  let spotAgreed = 0;
  for (const check of expectation.spotChecks) {
    if (decompiled.text.includes(check.fragment) === check.present) {
      spotAgreed += 1;
    }
  }
  let ranged = 0;
  let total = 0;
  for (const fn of decompiled.functions) {
    for (const statement of fn.statements) {
      total += 1;
      const range = (statement as { range?: { startPc: number; endPc: number } }).range;
      if (range !== undefined && range.endPc > range.startPc) {
        ranged += 1;
      }
    }
  }
  const offsetCoverage = total === 0 ? 100 : (ranged / total) * 100;
  const passed =
    entriesMatch && patternsMatch && spotAgreed === expectation.spotChecks.length && offsetCoverage === 100;
  return {
    id: expectation.id,
    ownFunctions: decompiled.functions.length,
    expectedFunctions: expectation.functions.length,
    entriesMatch,
    patternsMatch,
    spotAgreed,
    spotTotal: expectation.spotChecks.length,
    ownUnresolved: decompiled.unresolvedJumps.length,
    offsetCoverage,
    passed,
  };
}

export function opcodeProfile(hex: string): Record<string, number> {
  const parsed = Bytecode.parse(hex);
  if (!parsed.ok) {
    return {};
  }
  const counts: Record<string, number> = {};
  for (const block of lift(parsed.value).blocks) {
    for (const entry of block.instructions) {
      counts[entry.name] = (counts[entry.name] ?? 0) + 1;
    }
  }
  return counts;
}

// K-523 coverage: every corpus-listed published selector resolves by
// table in the namer.
export function k523Coverage(expectations: readonly ContractExpectation[]): { selector: string; contracts: string[]; tableHit: boolean }[] {
  const bySelector = new Map<string, Set<string>>();
  for (const expectation of expectations) {
    for (const selector of expectation.k523) {
      const set = bySelector.get(selector) ?? new Set<string>();
      set.add(expectation.id);
      bySelector.set(selector, set);
    }
  }
  return Array.from(bySelector.entries())
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([selector, contracts]) => ({
      selector,
      contracts: Array.from(contracts).sort(),
      tableHit: nameForSelector(selector, { isFallback: false }).source === "table",
    }));
}

export type EvalSummary = {
  readonly contracts: readonly ContractEval[];
  readonly contractCount: number;
  readonly passedCount: number;
  readonly ownPassRate: number;
  readonly spotAgreed: number;
  readonly spotTotal: number;
  readonly spotAgreement: number;
  readonly extdecompRuns: number;
  readonly k523: ReturnType<typeof k523Coverage>;
  readonly opcodeProfile: Record<string, number>;
  readonly consistent: boolean;
};

export function summarize(evals: readonly ContractEval[], expectations: readonly ContractExpectation[]): EvalSummary {
  let passedCount = 0;
  let spotAgreed = 0;
  let spotTotal = 0;
  let extdecompRuns = 0;
  for (const evaluation of evals) {
    if (evaluation.passed) {
      passedCount += 1;
    }
    spotAgreed += evaluation.spotAgreed;
    spotTotal += evaluation.spotTotal;
    if (evaluation.extdecomp.status !== "not-run") {
      extdecompRuns += 1;
    }
  }
  const contractCount = evals.length;
  const ownPassRate = contractCount === 0 ? 0 : (passedCount / contractCount) * 100;
  const spotAgreement = spotTotal === 0 ? 100 : (spotAgreed / spotTotal) * 100;
  const consistent =
    Number.isFinite(ownPassRate) &&
    Number.isFinite(spotAgreement) &&
    ownPassRate >= 0 &&
    ownPassRate <= 100 &&
    spotAgreement >= 0 &&
    spotAgreement <= 100 &&
    evals.length === expectations.length &&
    evals.every((evaluation, index) => evaluation.id === expectations[index]?.id);
  return {
    contracts: evals,
    contractCount,
    passedCount,
    ownPassRate,
    spotAgreed,
    spotTotal,
    spotAgreement,
    extdecompRuns,
    k523: k523Coverage(expectations),
    opcodeProfile: {},
    consistent,
  };
}

export type RunProcess = (
  bin: string,
  args: readonly string[],
  options: { home: string; cwd: string; timeoutMs: number },
) => { status: number | null; stdout: string; stderr: string };

function defaultRun(bin: string, args: readonly string[], options: { home: string; cwd: string; timeoutMs: number }) {
  const result = spawnSync(bin, args.slice(), {
    cwd: options.cwd,
    env: { ...process.env, HOME: options.home },
    timeout: options.timeoutMs,
    encoding: "utf8",
  });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

// Cap on collected extdecomp file bytes per contract: the corpus fixtures
// are small, so anything larger is truncated rather than read unbounded.
const MAX_extdecomp_FILE_BYTES = 1048576;

function removeTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort: a leftover temp dir never fails the eval.
  }
}

// extdecomp writes its decompiled output to files under an `output/`
// directory below its working directory rather than to stdout, so selector
// matching runs over both: the process output plus every file under
// `<workdir>/output`, concatenated in deterministic (sorted) order. An
// absent `output/`
// directory contributes nothing and stdout alone decides. Unreadable or
// empty files contribute nothing.
export function readextdecompOutputDir(workdir: string): string {
  const parts: string[] = [];
  let budget = MAX_extdecomp_FILE_BYTES;
  const stack: string[] = [join(workdir, "output")];
  while (stack.length > 0 && budget > 0) {
    const current = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    const sorted = entries.slice().sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of sorted) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || budget <= 0) {
        continue;
      }
      try {
        const size = statSync(full).size;
        if (!Number.isFinite(size) || size <= 0 || size > budget) {
          continue;
        }
        const text = readFileSync(full, "utf8");
        budget -= size;
        parts.push(text);
      } catch {
        continue;
      }
    }
  }
  return parts.join("\n");
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export type EvalRunOptions = {
  readonly corpusDir?: string | undefined;
  readonly extdecompBin?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly run?: RunProcess | undefined;
};

export type EvalRunResult = {
  readonly exitCode: number;
  readonly summary: EvalSummary;
  readonly extdecompVersion: string | null;
  readonly markdown: string;
};

export async function runEval(options: EvalRunOptions): Promise<EvalRunResult> {
  const corpusDir = options.corpusDir ?? CORPUS_DIR;
  const timeoutMs = options.timeoutMs ?? 120000;
  const run = options.run ?? defaultRun;
  const corpus = JSON.parse(readFileSync(join(corpusDir, "corpus.json"), "utf8")) as {
    contracts: ContractExpectation[];
    expected: { ownPassRate: number; spotAgreement: number };
  };
  const profile: Record<string, number> = {};
  for (const expectation of corpus.contracts) {
    const hex = readFileSync(join(corpusDir, expectation.file), "utf8").trim();
    for (const [name, count] of Object.entries(opcodeProfile(hex))) {
      profile[name] = (profile[name] ?? 0) + count;
    }
  }

  let extdecompVersion: string | null = null;
  let extdecompUsable = false;
  if (options.extdecompBin !== undefined) {
    // The version probe runs in fresh temp dirs like every decompile run,
    // so the probe never writes into the repo either; both dirs go away.
    const probeHome = mkdtempSync(join(tmpdir(), "extdecomp-home-"));
    const probeCwd = mkdtempSync(join(tmpdir(), "extdecomp-work-"));
    try {
      const probed = run(options.extdecompBin, ["--version"], { home: probeHome, cwd: probeCwd, timeoutMs });
      const reported = `${probed.stdout}${probed.stderr}`.trim();
      const checked = checkextdecompVersion(reported);
      if (!checked.ok) {
        const summary = summarize([], corpus.contracts);
        const markdown = [
          "# Decompiler eval: version gate",
          ``,
          `Expected extdecomp ${checked.expected}, reported \`${checked.reported}\`.`,
          `The eval fails here and records no metrics: nothing installs or upgrades a binary.`,
          ``,
        ].join("\n");
        return { exitCode: 1, summary, extdecompVersion: checked.reported, markdown };
      }
      extdecompVersion = reported;
      extdecompUsable = true;
    } finally {
      removeTempDir(probeHome);
      removeTempDir(probeCwd);
    }
  }

  const evals: ContractEval[] = [];
  for (const expectation of corpus.contracts) {
    const hex = readFileSync(join(corpusDir, expectation.file), "utf8").trim();
    const own = evaluateOwn(hex, expectation);
    if (!extdecompUsable || options.extdecompBin === undefined) {
      evals.push({ ...own, extdecomp: { status: "not-run" } });
      continue;
    }
    // extdecomp writes its decompiled output to files under an `output/`
    // directory below its working directory rather than to stdout, so each
    // contract runs with the working directory set to a fresh temp dir
    // (and HOME set to a second fresh temp dir): the input hex, the
    // process output and the generated files all stay out of the repo, and
    // both temp dirs are deleted before the next contract runs.
    const home = mkdtempSync(join(tmpdir(), "extdecomp-home-"));
    const work = mkdtempSync(join(tmpdir(), "extdecomp-work-"));
    try {
      const inputFile = join(work, `${expectation.id}.hex`);
      writeFileSync(inputFile, hex);
      let outcome: ContractEval["extdecomp"];
      try {
        const result = run(options.extdecompBin, buildextdecompArgs(inputFile), { home, cwd: work, timeoutMs });
        if (result.status !== 0) {
          outcome = { status: "failed", version: extdecompVersion ?? "unknown", inputDigest: sha256Hex(hex) };
        } else {
          const combined = `${result.stdout}\n${readextdecompOutputDir(work)}`;
          outcome = {
            status: "ok",
            selectorsMentioned: findMentionedSelectors(combined, expectation.selectors),
            version: extdecompVersion ?? "unknown",
          };
        }
      } catch {
        outcome = { status: "failed", version: extdecompVersion ?? "unknown", inputDigest: sha256Hex(hex) };
      }
      evals.push({ ...own, extdecomp: outcome });
    } finally {
      removeTempDir(home);
      removeTempDir(work);
    }
  }

  const partial = summarize(evals, corpus.contracts);
  const summary: EvalSummary = { ...partial, opcodeProfile: profile };
  const ownWithin = Math.abs(summary.ownPassRate - corpus.expected.ownPassRate) <= EVAL_PASS_TOLERANCE_POINTS;
  const spotWithin = Math.abs(summary.spotAgreement - corpus.expected.spotAgreement) <= EVAL_PASS_TOLERANCE_POINTS;
  const exitCode = summary.consistent && ownWithin && spotWithin ? 0 : 1;
  const lines: string[] = [];
  lines.push("# Decompiler differential eval: own pipeline versus extdecomp");
  lines.push("");
  lines.push(`Corpus contracts: ${summary.contractCount}. Own pass rate: ${summary.ownPassRate.toFixed(1)}% (expected ${corpus.expected.ownPassRate} ± ${EVAL_PASS_TOLERANCE_POINTS}).`);
  lines.push(`Spot agreement: ${summary.spotAgreed}/${summary.spotTotal} (${summary.spotAgreement.toFixed(1)}%, expected ${corpus.expected.spotAgreement} ± ${EVAL_PASS_TOLERANCE_POINTS}).`);
  lines.push(`extdecomp runs: ${summary.extdecompRuns} (binary ${extdecompVersion ?? "not configured; columns marked not-run"}).`);
  if (extdecompUsable) {
    lines.push(
      "extdecomp method: each run used a fresh temp work dir (HOME a second fresh temp dir); stdout plus files under the work dir output/ parsed; both temp dirs deleted; nothing written into the repo.",
    );
  }
  lines.push("");
  lines.push("| Contract | Own functions | Entries match | Patterns match | Spot | Unresolved | extdecomp |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const evaluation of summary.contracts) {
    const extdecomp =
      evaluation.extdecomp.status === "not-run"
        ? "not-run"
        : evaluation.extdecomp.status === "failed"
          ? `failed (${evaluation.extdecomp.version}, input ${evaluation.extdecomp.inputDigest.slice(0, 12)})`
          : `ok (${evaluation.extdecomp.selectorsMentioned.length} selectors, ${evaluation.extdecomp.version})`;
    lines.push(
      `| ${evaluation.id} | ${evaluation.ownFunctions}/${evaluation.expectedFunctions} | ${evaluation.entriesMatch} | ${evaluation.patternsMatch} | ${evaluation.spotAgreed}/${evaluation.spotTotal} | ${evaluation.ownUnresolved} | ${extdecomp} |`,
    );
  }
  lines.push("");
  lines.push("## K-523 published-selector coverage");
  lines.push("");
  lines.push("| Selector | Contracts | Table hit |");
  lines.push("|---|---|---|");
  for (const row of summary.k523) {
    lines.push(`| ${row.selector} | ${row.contracts.join(", ")} | ${row.tableHit} |`);
  }
  lines.push("");
  lines.push("## Opcode profile across the corpus");
  lines.push("");
  const top = Object.entries(profile).sort(([, left], [, right]) => right - left).slice(0, 20);
  lines.push(top.map(([name, count]) => `${name} ${count}`).join(", "));
  lines.push("");
  const markdown = `${lines.join("\n")}\n`;
  return { exitCode, summary, extdecompVersion, markdown };
}

async function main(): Promise<void> {
  const extdecompBin = process.env["extdecomp_BIN"];
  const result = await runEval({ extdecompBin });
  writeFileSync(RESULTS_DOC, result.markdown);
  process.stdout.write(result.markdown);
  if (extdecompBin === undefined) {
    process.stdout.write("extdecomp comparison skipped: extdecomp_BIN is unset.\n");
  }
  process.exit(result.exitCode);
}

const invokedAsScript = (process.argv[1] ?? "").endsWith("eval-decompiler.ts");
if (invokedAsScript) {
  await main();
}
