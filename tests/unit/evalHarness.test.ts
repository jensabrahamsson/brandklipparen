// Eval harness unit tests (S-082, K-038, K-521, D-09, D-10, M-47).
// Written first per A-21 (red): scripts/eval-decompiler.ts does not
// exist yet. No test invokes a binary: the harness runs against the
// frozen corpus with an injected process stub, and the skip path runs
// with `extdecomp_BIN` unset.
import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVAL_PASS_TOLERANCE_POINTS,
  EXPECTED_extdecomp_VERSION,
  buildextdecompArgs,
  checkextdecompVersion,
  evaluateOwn,
  findMentionedSelectors,
  readextdecompOutputDir,
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
  test("d09_eval_runs_only_on_local_bytecode_without_network_or_llm_flags", () => {
    for (const input of ["0x6001600055", "/tmp/token-simple.hex"]) {
      const args = buildextdecompArgs(input);
      expect(args).toEqual(["decompile", input, "--include-sol"]);
      for (const arg of args) {
        expect(arg).not.toContain("http");
        expect(arg).not.toContain("-r");
        expect(arg).not.toContain("api-key");
        expect(arg).not.toContain("llm");
      }
    }
  });

  test("d09_extdecomp_selector_match_handles_bare_case_and_unresolved_names", () => {
    // Recorded synthetic sample shaped like real extdecomp 0.9.1 output:
    // abi.json carries names only, decompiled.sol carries
    // `@custom:selector` lines with 0x form, and one fallback function
    // uses an Unresolved_ name with the bare form in mixed case.
    const combined = [
      `[{"type": "function", "name": "transfer"}]`,
      "/// @custom:selector    0xA9059CBB",
      "function transfer(address arg0, uint256 arg1) public returns (bool) {",
      "function Unresolved_70A08231() {",
      "}",
    ].join("\n");
    expect(findMentionedSelectors(combined, ["0xa9059cbb", "0x70a08231"])).toEqual([
      "0xa9059cbb",
      "0x70a08231",
    ]);
    expect(findMentionedSelectors("switch selector() default {}", ["0xa9059cbb"])).toEqual([]);
  });

  test("d10_version_gate_accepts_pinned_and_names_mismatch", () => {
    expect(checkextdecompVersion("0.9.1")).toEqual({ ok: true });
    expect(checkextdecompVersion("extdecomp 0.9.1")).toEqual({ ok: true });
    const mismatch = checkextdecompVersion("0.8.0");
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) {
      return;
    }
    expect(mismatch.expected).toBe(EXPECTED_extdecomp_VERSION);
    expect(mismatch.reported).toBe("0.8.0");
  });

  test("d09_eval_skips_cleanly_without_extdecomp_bin", async () => {
    const result = await runEval({ corpusDir: CORPUS_DIR, extdecompBin: undefined });
    expect(result.exitCode).toBe(0);
    expect(result.extdecompVersion).toBe(null);
    for (const evaluation of result.summary.contracts) {
      expect(evaluation.extdecomp).toEqual({ status: "not-run" });
    }
    expect(result.summary.consistent).toBe(true);
  });

  test("d09_eval_fails_on_version_mismatch_naming_both_strings", async () => {
    const result = await runEval({
      corpusDir: CORPUS_DIR,
      extdecompBin: "/bin/echo-stub",
      run: () => ({ status: 0, stdout: "0.8.0", stderr: "" }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.extdecompVersion).toBe("0.8.0");
    expect(result.markdown).toContain(EXPECTED_extdecomp_VERSION);
    expect(result.markdown).toContain("0.8.0");
  });

  test("d09_eval_records_per_failure_version_and_digest", async () => {
    const result = await runEval({
      corpusDir: CORPUS_DIR,
      extdecompBin: "/bin/echo-stub",
      run: (bin, args) => {
        if (args[0] === "--version") {
          return { status: 0, stdout: "0.9.1", stderr: "" };
        }
        expect(bin).toBe("/bin/echo-stub");
        expect(args[0]).toBe("decompile");
        return { status: 1, stdout: "", stderr: "boom" };
      },
    });
    expect(result.exitCode).toBe(0);
    for (const evaluation of result.summary.contracts) {
      expect(evaluation.extdecomp.status).toBe("failed");
      if (evaluation.extdecomp.status !== "failed") {
        continue;
      }
      expect(evaluation.extdecomp.version).toBe("0.9.1");
      expect(evaluation.extdecomp.inputDigest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("d09_summary_totals_stay_internally_consistent", async () => {
    const result = await runEval({ corpusDir: CORPUS_DIR, extdecompBin: undefined });
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
      return { ...evaluateOwn(hex, expectation), extdecomp: { status: "not-run" } };
    });
    const summary = summarize(evals, corpus.contracts);
    expect(summary.consistent).toBe(true);
    expect(summary.ownPassRate).toBe(corpus.expected.ownPassRate);
    expect(summary.spotAgreement).toBe(corpus.expected.spotAgreement);
    for (const row of summary.k523) {
      expect(row.tableHit).toBe(true);
    }
  });

  test("d09_extdecomp_file_output_is_read_from_temp_workdir_and_cleaned_up", async () => {
    // extdecomp writes its decompiled output to files under an `output/`
    // directory rather than stdout. The fake runner below records a small
    // synthetic output sample (shaped like a decompiled source file naming
    // two selectors) into the work dir it is handed with empty stdout, so
    // the harness must still report both selectors as mentioned.
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const seenDirs: string[] = [];
    const result = await runEval({
      corpusDir: CORPUS_DIR,
      extdecompBin: "/bin/fake-extdecomp",
      run: (bin, args, options) => {
        if (args[0] === "--version") {
          return { status: 0, stdout: "0.9.1", stderr: "" };
        }
        expect(bin).toBe("/bin/fake-extdecomp");
        expect(args[0]).toBe("decompile");
        // The input hex and the working directory both stay out of the
        // repo: the input path sits inside the handed work dir, and both
        // temp dirs sit below the OS temp root.
        expect(args[1]?.startsWith(options.cwd)).toBe(true);
        expect(options.cwd.startsWith(tmpdir())).toBe(true);
        expect(options.home.startsWith(tmpdir())).toBe(true);
        expect(options.cwd.startsWith(`${repoRoot}${sep}tests`)).toBe(false);
        seenDirs.push(options.cwd, options.home);
        mkdirSync(join(options.cwd, "output", "local"), { recursive: true });
        writeFileSync(
          join(options.cwd, "output", "local", "decompiled.sol"),
          "function transfer(address arg0, uint256 arg1) /* selector 0xa9059cbb */ {}\n" +
            "function balanceOf(address arg0) /* selector 0x70a08231 */ {}\n",
        );
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(result.exitCode).toBe(0);
    const simple = result.summary.contracts.find((row) => row.id === "token-simple");
    expect(simple?.extdecomp).toEqual({
      status: "ok",
      selectorsMentioned: ["0x70a08231", "0xa9059cbb"],
      version: "0.9.1",
    });
    const fallback = result.summary.contracts.find((row) => row.id === "edge-fallback");
    expect(fallback?.extdecomp).toEqual({ status: "ok", selectorsMentioned: [], version: "0.9.1" });
    // Both temp dirs per contract are deleted before the eval returns.
    expect(seenDirs.length).toBeGreaterThan(0);
    for (const dir of seenDirs) {
      expect(existsSync(dir)).toBe(false);
    }
  });

  test("d09_extdecomp_output_reader_ignores_absent_dir", () => {
    expect(readextdecompOutputDir(join(tmpdir(), "extdecomp-no-such-dir"))).toBe("");
  });

  test("d09_extdecomp_fake_runner_reads_recorded_sample_layout", async () => {
    // Recorded layout from extdecomp 0.9.1 with `--include-sol`: abi.json
    // holds names only while decompiled.sol holds the 0x selector lines
    // plus one bare Unresolved_ name. The harness must report both.
    const result = await runEval({
      corpusDir: CORPUS_DIR,
      extdecompBin: "/bin/fake-extdecomp",
      run: (bin, args, options) => {
        if (args[0] === "--version") {
          return { status: 0, stdout: "0.9.1", stderr: "" };
        }
        expect(args).toEqual(["decompile", args[1] as string, "--include-sol"]);
        expect(bin).toBe("/bin/fake-extdecomp");
        mkdirSync(join(options.cwd, "output", "local"), { recursive: true });
        writeFileSync(
          join(options.cwd, "output", "local", "abi.json"),
          `[{"type": "function", "name": "transfer"}]`,
        );
        writeFileSync(
          join(options.cwd, "output", "local", "decompiled.sol"),
          "/// @custom:selector    0xA9059CBB\n" +
            "function transfer(address arg0, uint256 arg1) public returns (bool) {}\n" +
            "function Unresolved_70A08231() {}\n",
        );
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(result.exitCode).toBe(0);
    const simple = result.summary.contracts.find((row) => row.id === "token-simple");
    expect(simple?.extdecomp).toEqual({
      status: "ok",
      selectorsMentioned: ["0x70a08231", "0xa9059cbb"],
      version: "0.9.1",
    });
  });

  test("d09_metrics_table_reports_all_four_metrics_per_contract", async () => {
    const result = await runEval({ corpusDir: CORPUS_DIR, extdecompBin: undefined });
    expect(result.exitCode).toBe(0);
    expect(result.extdecompVersion).toBe(null);
    const corpus = corpusOf();
    expect(result.summary.contracts.length).toBe(corpus.contracts.length);
    for (const [index, row] of result.summary.contracts.entries()) {
      // Metric 1 (CFG/function boundaries), metric 2 (unresolved jumps),
      // metric 3 (token-pattern readability) and metric 4 (offset mapping)
      // are all present per corpus contract, for the own pipeline now and
      // for extdecomp when a binary is named.
      expect(row.id).toBe(corpus.contracts[index]?.id);
      expect(typeof row.entriesMatch).toBe("boolean");
      expect(typeof row.ownUnresolved).toBe("number");
      expect(typeof row.patternsMatch).toBe("boolean");
      expect(typeof row.spotAgreed).toBe("number");
      expect(typeof row.spotTotal).toBe("number");
      expect(typeof row.offsetCoverage).toBe("number");
      expect(typeof row.passed).toBe("boolean");
      expect(row.extdecomp.status).toBe("not-run");
    }
    expect(result.summary.extdecompRuns).toBe(0);
  });
});
