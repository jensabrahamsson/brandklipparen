// Offline metrics and model card from the frozen artifact and the split
// fixtures (K-205, K-206, K-208, S-021). Written first (red) per A-21;
// the implementation lives in scripts/evaluate-metrics.ts. The test runs
// the script in a child process into a temporary directory and requires
// byte-identical output with the committed report and card, so the whole
// evaluation reproduces offline with no network: file reads plus the pure
// domain pipeline only.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createModelCard } from "../../src/domain/modelCard.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const scriptPath = join(repoRoot, "scripts", "evaluate-metrics.ts");
const MODEL_VERSION = "0.0.0-synthetic.1";
const committedEvaluation = join(repoRoot, "model", `evaluation-${MODEL_VERSION}.json`);
const committedCard = join(repoRoot, "model", `model-card-${MODEL_VERSION}.json`);
const committedArtifact = join(repoRoot, "model", `artifact-${MODEL_VERSION}.json`);

// Process-spawning tests carry an explicit timeout well above the default
// 5000 ms: CI runners are slower and each child process pays the
// type-stripping startup cost. 30 s matches the k211 artifact test and the
// gate tests in tests/unit/ci-gate.test.ts.
const CHILD_PROCESS_TIMEOUT_MS = 30_000;

function runEvaluate(outDir: string): void {
  execFileSync(process.execPath, ["--experimental-strip-types", scriptPath, outDir], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
    timeout: CHILD_PROCESS_TIMEOUT_MS,
  });
}

describe("offline metrics and model card (K-205, K-206, K-208)", () => {
  test("k205_metrics_recomputed_offline_match_committed_report", () => {
    const firstDir = mkdtempSync(join(tmpdir(), "evaluate-first-"));
    const secondDir = mkdtempSync(join(tmpdir(), "evaluate-second-"));
    runEvaluate(firstDir);
    runEvaluate(secondDir);
    const first = readFileSync(join(firstDir, `evaluation-${MODEL_VERSION}.json`), "utf8");
    const second = readFileSync(join(secondDir, `evaluation-${MODEL_VERSION}.json`), "utf8");
    // Two offline runs give byte-identical reports: the evaluation is
    // deterministic and carries no network reads.
    expect(second).toBe(first);
    expect(first).toBe(readFileSync(committedEvaluation, "utf8"));
    const report = JSON.parse(first) as { card?: unknown };
    expect(report.card).toBeDefined();
  });

  test("k208_committed_model_card_matches_offline_recomputation", () => {
    const outDir = mkdtempSync(join(tmpdir(), "evaluate-card-"));
    runEvaluate(outDir);
    const recomputed = readFileSync(join(outDir, `model-card-${MODEL_VERSION}.json`), "utf8");
    expect(recomputed).toBe(readFileSync(committedCard, "utf8"));

    const card = createModelCard(JSON.parse(recomputed) as unknown);
    expect(card.ok).toBe(true);
    if (card.ok) {
      expect(card.value.limitations.length).toBeGreaterThan(0);
      const methods = card.value.evaluations.map((entry) => entry.method).sort();
      expect(methods).toEqual(["skeleton-hash-v1", "time-block-v1"]);
      const artifact = JSON.parse(readFileSync(committedArtifact, "utf8")) as { checksum?: unknown };
      expect(card.value.artifactChecksum).toBe(artifact.checksum);
      expect(card.value.modelVersion).toBe(MODEL_VERSION);
    }
  });
});
