// Pure unit tests for the deterministic artifact freeze (K-211, S-019).
// Written first (red) per A-21; the implementation lives in
// src/domain/artifact.ts. Every value below is a synthetic placeholder with
// no predictive meaning; production values arrive through the versioned
// offline calibration chain per A-28 and K-210.
import { describe, expect, test } from "vitest";
import {
  artifactToCanonical,
  checksumForArtifact,
  freezeArtifactFile,
  trainArtifact,
  verifyArtifactFile,
} from "../../../src/domain/artifact.ts";
import { parseModelArtifact } from "../../../src/domain/risk.ts";
import type { Result } from "../../../src/domain/result.ts";
import { ArtifactChecksum, ModelVersion } from "../../../src/domain/types.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function syntheticDataset(): unknown {
  return {
    dataVersion: "synthetic-v1",
    seed: 211,
    severityCounts: { low: 1, medium: 2, high: 4 },
    causeCounts: { timeout: 2, "resource-limit": 2, "decompiler-error": 4, "obfuscated-structure": 2 },
    riskOutcomes: {
      "rug-pull": { positives: 4, negatives: 2 },
      honeypot: { positives: 2, negatives: 2 },
      "bot-pump": { positives: 4, negatives: 6 },
    },
    riskShares: { "rug-pull": 5, honeypot: 3, "bot-pump": 2 },
  };
}

describe("artifact freeze (K-211)", () => {
  test("k211_train_derives_weights_from_dataset_counts", () => {
    const trained = mustOk(trainArtifact(syntheticDataset(), mustOk(ModelVersion.parse("0.0.0-synthetic.1"))));
    // Severity weights divide by the largest count: 1/4, 2/4, 4/4.
    expect(trained.artifact.severityWeights["low"]).toBe(0.25);
    expect(trained.artifact.severityWeights["medium"]).toBe(0.5);
    expect(trained.artifact.severityWeights["high"]).toBe(1);
    // Cause weights divide by the total: 2/10, 2/10, 4/10, 2/10.
    expect(trained.artifact.causeWeights["timeout"]).toBe(0.2);
    expect(trained.artifact.causeWeights["decompiler-error"]).toBe(0.4);
    // Biases negate the negative share: -(2/4), -(2/2), -(6/4).
    expect(trained.artifact.biases["rug-pull"]).toBe(-0.5);
    expect(trained.artifact.biases["honeypot"]).toBe(-1);
    expect(trained.artifact.biases["bot-pump"]).toBe(-1.5);
    // Score weights divide by the total share: 5/10, 3/10, 2/10.
    expect(trained.artifact.scoreWeights["rug-pull"]).toBe(0.5);
    // The logged seed and data version travel with the trained values.
    expect(trained.dataVersion).toBe("synthetic-v1");
    expect(trained.seed).toBe(211);
  });

  test("k211_freeze_uses_canonical_serialization_and_sha256", () => {
    const trained = mustOk(trainArtifact(syntheticDataset(), mustOk(ModelVersion.parse("0.0.0-synthetic.1"))));
    const frozen = mustOk(freezeArtifactFile(trained));
    // The frozen bytes parse back to the same artifact with a verified
    // checksum carried beside it.
    const verified = mustOk(verifyArtifactFile(JSON.parse(frozen) as unknown));
    expect(verified.artifact).toEqual(trained.artifact);
    expect(verified.checksum as string).toHaveLength(64);
    // The checksum is SHA-256 over the canonical bytes of the artifact
    // (A-20): recomputing it from the canonical form agrees.
    const recomputed = mustOk(checksumForArtifact(trained.artifact));
    expect(recomputed as string).toBe(verified.checksum as string);
    expect(ArtifactChecksum.parse(verified.checksum as string).ok).toBe(true);
    // The canonical artifact form holds every model value the risk
    // function reads, so the checksum covers each of them. Since S-047 the
    // calibrated plugin weights travel in the same form and checksum.
    const canonical = artifactToCanonical(trained.artifact);
    expect(canonical).toEqual(
      JSON.parse(
        JSON.stringify({
          biases: trained.artifact.biases,
          calibration: trained.artifact.calibration,
          causeWeights: trained.artifact.causeWeights,
          pluginWeights: trained.artifact.pluginWeights,
          scoreWeights: trained.artifact.scoreWeights,
          severityWeights: trained.artifact.severityWeights,
          version: trained.artifact.version,
        }),
      ),
    );
    // A frozen file with an unknown top-level key is malformed, so a
    // misspelled field cannot pass silently.
    const extra = { ...(JSON.parse(frozen) as Record<string, unknown>), thresholds: { low: 1 } };
    const rejected = verifyArtifactFile(extra);
    expect(rejected.ok).toBe(false);
  });

  test("k211_train_rejects_invalid_counts", () => {
    const version = mustOk(ModelVersion.parse("0.0.0-synthetic.1"));
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["null dataset", null],
      ["missing seed", { ...(syntheticDataset() as Record<string, unknown>), seed: undefined }],
      ["negative seed", { ...(syntheticDataset() as Record<string, unknown>), seed: -1 }],
      [
        "zero severity counts",
        {
          ...(syntheticDataset() as Record<string, unknown>),
          severityCounts: { low: 0, medium: 0, high: 0 },
        },
      ],
      [
        "zero risk positives",
        {
          ...(syntheticDataset() as Record<string, unknown>),
          riskOutcomes: {
            "rug-pull": { positives: 0, negatives: 2 },
            honeypot: { positives: 2, negatives: 2 },
            "bot-pump": { positives: 4, negatives: 6 },
          },
        },
      ],
      [
        "zero risk shares",
        {
          ...(syntheticDataset() as Record<string, unknown>),
          riskShares: { "rug-pull": 0, honeypot: 0, "bot-pump": 0 },
        },
      ],
    ];
    for (const [name, input] of cases) {
      const trained = trainArtifact(input, version);
      expect(trained.ok, name).toBe(false);
      if (!trained.ok) {
        expect(trained.error.kind).toBe("invalid-model-artifact");
      }
    }
    // The trained artifact always parses through the shared artifact
    // parser, so freeze output stays loadable by the scoring path.
    const trained = mustOk(trainArtifact(syntheticDataset(), version));
    expect(parseModelArtifact(JSON.parse(JSON.stringify(trained.artifact)) as unknown).ok).toBe(true);
  });
});
