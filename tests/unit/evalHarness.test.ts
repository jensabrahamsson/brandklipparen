// Eval harness unit tests (S-082, K-038, K-521). Written first per
// A-21 (red): scripts/eval-decompiler.ts does not exist yet. No test
// invokes an external tool: the internal-only harness runs against the
// frozen corpus.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVAL_PASS_TOLERANCE_POINTS,
  evaluateOwn,
  runEval,
  summarize,
} from "../../scripts/eval-decompiler.ts";
import type { ContractEval, ContractExpectation } from "../../scripts/eval-decompiler.ts";

const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "evm", "corpus");

function corpusOf(): { contracts: ContractExpectation[]; expected: { ownPassRate: number; spotAgreement: number } } {
  return JSON.parse(readFileSync(join(CORPUS_DIR, "corpus.json"), "utf8")) as {
    contracts: ContractExpectation[];
    expected: { ownPassRate: number; spotAgreement: number };
  };
}

describe("decompiler eval harness", () => {
  test("d09_eval_runs_internal_only_over_local_corpus", async () => {
    const result = await runEval({ corpusDir: CORPUS_DIR });
    expect(result.exitCode).toBe(0);
    expect(result.summary.consistent).toBe(true);
    expect(result.markdown).toContain("internal pipeline");
    expect(result.markdown).toContain("| Contract | Own functions |");
  });

  test("d09_summary_totals_stay_internally_consistent", async () => {
    const result = await runEval({ corpusDir: CORPUS_DIR });
    const summary = result.summary;
    expect(summary.contractCount).toBe(summary.contracts.length);
    expect(summary.ownPassRate).toBe((summary.passedCount / summary.contractCount) * 100);
    expect(summary.spotAgreement).toBe((summary.spotAgreed / summary.spotTotal) * 100);
    expect(summary.ownPassRate).toBeGreaterThanOrEqual(0);
    expect(summary.ownPassRate).toBeLessThanOrEqual(100);
    const corpus = corpusOf();
    expect(Math.abs(summary.ownPassRate - corpus.expected.ownPassRate)).toBeLessThanOrEqual(
      EVAL_PASS_TOLERANCE_POINTS,
    );
    expect(Math.abs(summary.spotAgreement - corpus.expected.spotAgreement)).toBeLessThanOrEqual(
      EVAL_PASS_TOLERANCE_POINTS,
    );
  });

  test("d09_evaluate_own_scores_frozen_corpus_at_expected_rates", () => {
    const corpus = corpusOf();
    const evals: ContractEval[] = corpus.contracts.map((expectation) => {
      const hex = readFileSync(join(CORPUS_DIR, expectation.file), "utf8").trim();
      return evaluateOwn(hex, expectation);
    });
    const summary = summarize(evals, corpus.contracts);
    expect(summary.consistent).toBe(true);
    expect(summary.ownPassRate).toBe(corpus.expected.ownPassRate);
    expect(summary.spotAgreement).toBe(corpus.expected.spotAgreement);
    for (const row of summary.k523) {
      expect(row.tableHit).toBe(true);
    }
  });

  test("d09_metrics_table_reports_all_four_metrics_per_contract", async () => {
    const result = await runEval({ corpusDir: CORPUS_DIR });
    expect(result.exitCode).toBe(0);
    const corpus = corpusOf();
    expect(result.summary.contracts.length).toBe(corpus.contracts.length);
    for (const [index, row] of result.summary.contracts.entries()) {
      // Metric 1 (CFG/function boundaries), metric 2 (unresolved jumps),
      // metric 3 (token-pattern readability) and metric 4 (offset mapping)
      // are all present per corpus contract for the internal pipeline.
      expect(row.id).toBe(corpus.contracts[index]?.id);
      expect(typeof row.entriesMatch).toBe("boolean");
      expect(typeof row.ownUnresolved).toBe("number");
      expect(typeof row.patternsMatch).toBe("boolean");
      expect(typeof row.spotAgreed).toBe("number");
      expect(typeof row.spotTotal).toBe("number");
      expect(typeof row.offsetCoverage).toBe("number");
      expect(typeof row.passed).toBe("boolean");
    }
  });
});
