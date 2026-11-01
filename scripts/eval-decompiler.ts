// Internal-only eval harness: the own pipeline on the frozen ERC-20
// corpus (S-082, K-038, K-521). Dev/eval only: no runtime code imports
// this module. The harness evaluates the deterministic in-process
// pipeline over local corpus files and prints the Markdown report to
// stdout. No external tool runs anywhere on this path. Usage:
//   node --experimental-strip-types scripts/eval-decompiler.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Bytecode } from "../src/domain/types.ts";
import { decompileContract } from "../src/domain/evmSsa.ts";
import { lift } from "../src/domain/evmLift.ts";
import { nameForSelector } from "../src/domain/evmNames.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const CORPUS_DIR = join(repoRoot, "tests", "fixtures", "evm", "corpus");

export const EVAL_PASS_TOLERANCE_POINTS = 3;

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
};

export function evaluateOwn(hex: string, expectation: ContractExpectation): ContractEval {
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
  readonly k523: ReturnType<typeof k523Coverage>;
  readonly opcodeProfile: Record<string, number>;
  readonly consistent: boolean;
};

export function summarize(evals: readonly ContractEval[], expectations: readonly ContractExpectation[]): EvalSummary {
  let passedCount = 0;
  let spotAgreed = 0;
  let spotTotal = 0;
  for (const evaluation of evals) {
    if (evaluation.passed) {
      passedCount += 1;
    }
    spotAgreed += evaluation.spotAgreed;
    spotTotal += evaluation.spotTotal;
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
    k523: k523Coverage(expectations),
    opcodeProfile: {},
    consistent,
  };
}

export type EvalRunOptions = {
  readonly corpusDir?: string | undefined;
};

export type EvalRunResult = {
  readonly exitCode: number;
  readonly summary: EvalSummary;
  readonly markdown: string;
};

export async function runEval(options: EvalRunOptions): Promise<EvalRunResult> {
  const corpusDir = options.corpusDir ?? CORPUS_DIR;
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

  const evals: ContractEval[] = [];
  for (const expectation of corpus.contracts) {
    const hex = readFileSync(join(corpusDir, expectation.file), "utf8").trim();
    evals.push(evaluateOwn(hex, expectation));
  }

  const partial = summarize(evals, corpus.contracts);
  const summary: EvalSummary = { ...partial, opcodeProfile: profile };
  const ownWithin = Math.abs(summary.ownPassRate - corpus.expected.ownPassRate) <= EVAL_PASS_TOLERANCE_POINTS;
  const spotWithin = Math.abs(summary.spotAgreement - corpus.expected.spotAgreement) <= EVAL_PASS_TOLERANCE_POINTS;
  const exitCode = summary.consistent && ownWithin && spotWithin ? 0 : 1;
  const lines: string[] = [];
  lines.push("# Decompiler eval: internal pipeline on the frozen corpus");
  lines.push("");
  lines.push(`Corpus contracts: ${summary.contractCount}. Own pass rate: ${summary.ownPassRate.toFixed(1)}% (expected ${corpus.expected.ownPassRate} ± ${EVAL_PASS_TOLERANCE_POINTS}).`);
  lines.push(`Spot agreement: ${summary.spotAgreed}/${summary.spotTotal} (${summary.spotAgreement.toFixed(1)}%, expected ${corpus.expected.spotAgreement} ± ${EVAL_PASS_TOLERANCE_POINTS}).`);
  lines.push("");
  lines.push("| Contract | Own functions | Entries match | Patterns match | Spot | Unresolved |");
  lines.push("|---|---|---|---|---|---|");
  for (const evaluation of summary.contracts) {
    lines.push(
      `| ${evaluation.id} | ${evaluation.ownFunctions}/${evaluation.expectedFunctions} | ${evaluation.entriesMatch} | ${evaluation.patternsMatch} | ${evaluation.spotAgreed}/${evaluation.spotTotal} | ${evaluation.ownUnresolved} |`,
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
  return { exitCode, summary, markdown };
}

async function main(): Promise<void> {
  const result = await runEval({});
  // The report goes to stdout only: docs/eval-decompiler-results.md
  // stays a frozen historical record of the retired comparison runs.
  process.stdout.write(result.markdown);
  process.exit(result.exitCode);
}

const invokedAsScript = (process.argv[1] ?? "").endsWith("eval-decompiler.ts");
if (invokedAsScript) {
  await main();
}
