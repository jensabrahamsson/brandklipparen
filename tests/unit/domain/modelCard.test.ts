// Versioned model card with date, data version and limitations (K-208,
// S-021). Written first (red) per A-21; the implementation lives in
// src/domain/modelCard.ts. The card records the artifact checksum and
// version, the split methods and versions, the metric values from
// src/domain/metrics.ts and the documented limits of the
// synthetic and placeholder calibration. Serialization is canonical
// (A-32), so equal cards give byte-identical text.
import { describe, expect, test } from "vitest";
import { createModelCard, serializeModelCard } from "../../../src/domain/modelCard.ts";
import type { ModelCard } from "../../../src/domain/modelCard.ts";
import { evaluatePredictions } from "../../../src/domain/metrics.ts";
import type { LabelledPrediction, MetricsOptions, SplitMetrics } from "../../../src/domain/metrics.ts";
import type { Result } from "../../../src/domain/result.ts";
import type { ModelCardError } from "../../../src/domain/modelCard.ts";

const OPTIONS: MetricsOptions = Object.freeze({ binCount: 2, falseAlarmRate: 0.5 });

const PREDICTIONS: readonly LabelledPrediction[] = Object.freeze([
  Object.freeze({
    probabilities: Object.freeze({ "rug-pull": 0.25, honeypot: 0.4, "bot-pump": 0.8 }),
    labels: Object.freeze({ "rug-pull": "negative", honeypot: "negative", "bot-pump": "positive" }),
  }),
  Object.freeze({
    probabilities: Object.freeze({ "rug-pull": 0.75, honeypot: 0.6, "bot-pump": 0.2 }),
    labels: Object.freeze({ "rug-pull": "positive", honeypot: "positive", "bot-pump": "negative" }),
  }),
]);

function mustMetrics(): SplitMetrics {
  const result = evaluatePredictions(PREDICTIONS, OPTIONS);
  if (!result.ok) {
    throw new Error(`expected metrics, got ${result.error.message}`);
  }
  return result.value;
}

function cardInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const metrics = mustMetrics();
  return {
    modelVersion: "0.0.0-synthetic.1",
    artifactChecksum: "ab".repeat(32),
    dataVersion: "synthetic-v1",
    labelPolicyVersion: "1.0.0",
    blockRange: { from: 23100001, to: 23100004 },
    seed: 211,
    calibrationMethod: "placeholder-identity-v1",
    measurementSettings: {
      binCount: 2,
      falseAlarmRate: 0.5,
      predictionSource: "baseline-from-artifact-biases-v1",
    },
    evaluations: [
      {
        method: "time-block-v1",
        methodVersion: "1.0.0",
        trainCount: 1,
        calibrationCount: 1,
        testCount: 2,
        trainMetrics: metrics,
        testMetrics: metrics,
      },
      {
        method: "skeleton-hash-v1",
        methodVersion: "1.0.0",
        trainCount: 1,
        calibrationCount: 1,
        testCount: 2,
        trainMetrics: metrics,
        testMetrics: metrics,
      },
    ],
    limitations: [
      "Placeholder calibration: the artifact carries an identity calibrator, so probabilities track the training biases only.",
      "Synthetic data: four hand-assembled rows with no link to real contracts and no predictive meaning.",
    ],
    ...overrides,
  };
}

function mustCard(input: unknown): ModelCard {
  const result: Result<ModelCard, ModelCardError> = createModelCard(input);
  if (!result.ok) {
    throw new Error(`expected card, got ${result.error.kind}: ${result.error.message}`);
  }
  return result.value;
}

describe("model card (K-208)", () => {
  test("k208_model_card_has_period_data_splits_metrics", () => {
    const card = mustCard(cardInput());
    expect(card.modelVersion).toBe("0.0.0-synthetic.1");
    expect(card.artifactChecksum).toBe("ab".repeat(32));
    expect(card.dataVersion).toBe("synthetic-v1");
    expect(card.blockRange).toEqual({ from: 23100001, to: 23100004 });
    expect(card.seed).toBe(211);
    expect(card.evaluations.length).toBe(2);
    const methods = card.evaluations.map((entry) => entry.method);
    expect(methods).toEqual(["time-block-v1", "skeleton-hash-v1"]);
    for (const entry of card.evaluations) {
      expect(entry.methodVersion).toBe("1.0.0");
      expect(entry.testMetrics["rug-pull"].ece).toBe(mustMetrics()["rug-pull"].ece);
      expect(entry.trainMetrics["honeypot"].brier).toBe(mustMetrics()["honeypot"].brier);
    }
  });

  test("k208_model_card_lists_known_limitations", () => {
    const card = mustCard(cardInput());
    expect(card.limitations.length).toBeGreaterThan(0);
    for (const limitation of card.limitations) {
      expect(limitation.length).toBeGreaterThan(0);
    }
    const empty = createModelCard(cardInput({ limitations: [] }));
    expect(empty.ok).toBe(false);
  });

  test("k208_model_card_serializes_deterministically", () => {
    const card = mustCard(cardInput());
    const first = serializeModelCard(card);
    const second = serializeModelCard(card);
    expect(second).toBe(first);
    // Canonical key order: artifactChecksum sorts first.
    expect(first.startsWith('{"artifactChecksum":')).toBe(true);
    const parsed: Result<ModelCard, ModelCardError> = createModelCard(JSON.parse(first) as unknown);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(serializeModelCard(parsed.value)).toBe(first);
    }
  });

  test("k208_model_card_rejects_invalid_checksum_version_and_metrics", () => {
    expect(createModelCard(cardInput({ artifactChecksum: "not-hex" })).ok).toBe(false);
    expect(createModelCard(cardInput({ modelVersion: "not-semver" })).ok).toBe(false);
    const metrics = mustMetrics();
    const bad = {
      ...metrics["rug-pull"],
      ece: 2,
    };
    const badEvaluation = {
      method: "time-block-v1",
      methodVersion: "1.0.0",
      trainCount: 1,
      calibrationCount: 1,
      testCount: 2,
      trainMetrics: metrics,
      testMetrics: { ...metrics, "rug-pull": bad },
    };
    expect(createModelCard(cardInput({ evaluations: [badEvaluation] })).ok).toBe(false);
  });

  test("k208_model_card_encodes_unbounded_threshold_as_null", () => {
    const metrics = mustMetrics();
    const unbounded = {
      ...metrics["rug-pull"],
      thresholdAtFar: Number.POSITIVE_INFINITY,
    };
    const card = mustCard(
      cardInput({
        evaluations: [
          {
            method: "time-block-v1",
            methodVersion: "1.0.0",
            trainCount: 1,
            calibrationCount: 1,
            testCount: 1,
            trainMetrics: metrics,
            testMetrics: { ...metrics, "rug-pull": unbounded },
          },
        ],
      }),
    );
    expect(serializeModelCard(card).includes('"thresholdAtFar":null')).toBe(true);
  });
});
