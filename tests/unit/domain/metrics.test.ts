// Calibration and discrimination metrics over labelled predictions
// (K-205, K-206, S-021). Written first (red) per A-21; the implementation
// lives in src/domain/metrics.ts. Fixtures below are hand-worked
// probability and label pairs with expected values derived by hand, so the
// tests pin the arithmetic instead of reimplementing it. Two fixtures stand
// for the two S-018 evaluations: the time-based test split and the
// cluster-based test split, reported separately per K-205 and K-206.
import { describe, expect, test } from "vitest";
import { evaluatePredictions } from "../../../src/domain/metrics.ts";
import type {
  LabelledPrediction,
  MetricsOptions,
  SplitMetrics,
} from "../../../src/domain/metrics.ts";
import type { Result } from "../../../src/domain/result.ts";
import type { MetricsError } from "../../../src/domain/metrics.ts";

const OPTIONS: MetricsOptions = Object.freeze({ binCount: 2, falseAlarmRate: 0.5 });

// Time-split fixture: four labelled predictions with hand-computed
// per-class values (bins [0, 0.5) and [0.5, 1], FAR level 0.5).
// rug-pull: ECE 0.25, Brier 0.1875, AUROC 0.833333, PR-AUC 0.916667,
// precision at FAR 1 at threshold 0.75.
// honeypot: ECE 0.25, Brier 0.085, AUROC 1, PR-AUC 1,
// precision at FAR 1 at threshold 0.6.
// bot-pump: ECE 0.2, Brier 0.045, AUROC 1, PR-AUC 1,
// precision at FAR 1 at threshold 0.8.
const TIME_SPLIT: readonly LabelledPrediction[] = Object.freeze([
  Object.freeze({
    probabilities: Object.freeze({ "rug-pull": 0.25, honeypot: 0.1, "bot-pump": 0.9 }),
    labels: Object.freeze({ "rug-pull": "negative", honeypot: "negative", "bot-pump": "positive" }),
  }),
  Object.freeze({
    probabilities: Object.freeze({ "rug-pull": 0.25, honeypot: 0.4, "bot-pump": 0.8 }),
    labels: Object.freeze({ "rug-pull": "positive", honeypot: "negative", "bot-pump": "positive" }),
  }),
  Object.freeze({
    probabilities: Object.freeze({ "rug-pull": 0.75, honeypot: 0.6, "bot-pump": 0.2 }),
    labels: Object.freeze({ "rug-pull": "positive", honeypot: "positive", "bot-pump": "negative" }),
  }),
  Object.freeze({
    probabilities: Object.freeze({ "rug-pull": 0.75, honeypot: 0.9, "bot-pump": 0.3 }),
    labels: Object.freeze({ "rug-pull": "positive", honeypot: "positive", "bot-pump": "negative" }),
  }),
]);

// Cluster-split fixture: two labelled predictions with hand-computed
// per-class values.
// rug-pull and bot-pump: ECE 0, Brier 0, AUROC 1, PR-AUC 1,
// precision at FAR 1 at threshold 1.
// honeypot: ECE 0.2, Brier 0.04, AUROC 1, PR-AUC 1,
// precision at FAR 1 at threshold 0.8.
const CLUSTER_SPLIT: readonly LabelledPrediction[] = Object.freeze([
  Object.freeze({
    probabilities: Object.freeze({ "rug-pull": 0, honeypot: 0.2, "bot-pump": 1 }),
    labels: Object.freeze({ "rug-pull": "negative", honeypot: "negative", "bot-pump": "positive" }),
  }),
  Object.freeze({
    probabilities: Object.freeze({ "rug-pull": 1, honeypot: 0.8, "bot-pump": 0 }),
    labels: Object.freeze({ "rug-pull": "positive", honeypot: "positive", "bot-pump": "negative" }),
  }),
]);

function mustEvaluate(
  predictions: readonly LabelledPrediction[],
  options: MetricsOptions,
): SplitMetrics {
  const result: Result<SplitMetrics, MetricsError> = evaluatePredictions(predictions, options);
  if (!result.ok) {
    throw new Error(`expected metrics, got ${result.error.kind}: ${result.error.message}`);
  }
  return result.value;
}

describe("calibration measures per class (K-205)", () => {
  test("k205_ece_per_class_on_both_splits", () => {
    const time = mustEvaluate(TIME_SPLIT, OPTIONS);
    expect(time["rug-pull"].ece).toBe(0.25);
    expect(time["honeypot"].ece).toBe(0.25);
    expect(time["bot-pump"].ece).toBe(0.2);

    const cluster = mustEvaluate(CLUSTER_SPLIT, OPTIONS);
    expect(cluster["rug-pull"].ece).toBe(0);
    expect(cluster["honeypot"].ece).toBe(0.2);
    expect(cluster["bot-pump"].ece).toBe(0);
  });

  test("k205_brier_reported_alongside_ece", () => {
    const time = mustEvaluate(TIME_SPLIT, OPTIONS);
    expect(time["rug-pull"].brier).toBe(0.1875);
    expect(time["honeypot"].brier).toBe(0.085);
    expect(time["bot-pump"].brier).toBe(0.045);

    const cluster = mustEvaluate(CLUSTER_SPLIT, OPTIONS);
    expect(cluster["rug-pull"].brier).toBe(0);
    expect(cluster["honeypot"].brier).toBe(0.04);
    expect(cluster["bot-pump"].brier).toBe(0);
  });

  test("k205_empty_predictions_fail_with_typed_error", () => {
    const result = evaluatePredictions([], OPTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid-predictions");
    }
  });

  test("k205_probability_outside_unit_interval_fails_with_typed_error", () => {
    const bad: readonly LabelledPrediction[] = Object.freeze([
      Object.freeze({
        probabilities: Object.freeze({ "rug-pull": 1.5, honeypot: 0.1, "bot-pump": 0.2 }),
        labels: Object.freeze({ "rug-pull": "positive", honeypot: "negative", "bot-pump": "negative" }),
      }),
    ]);
    const result = evaluatePredictions(bad, OPTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid-predictions");
    }
  });

  test("k205_invalid_options_fail_with_typed_error", () => {
    const zeroBins = evaluatePredictions(TIME_SPLIT, { binCount: 0, falseAlarmRate: 0.5 });
    expect(zeroBins.ok).toBe(false);
    const unitFar = evaluatePredictions(TIME_SPLIT, { binCount: 2, falseAlarmRate: 1 });
    expect(unitFar.ok).toBe(false);
  });
});

describe("discrimination measures per class (K-206)", () => {
  test("k206_auroc_prauc_per_class_on_both_splits", () => {
    const time = mustEvaluate(TIME_SPLIT, OPTIONS);
    expect(time["rug-pull"].auroc).toBe(0.833333);
    expect(time["rug-pull"].prAuc).toBe(0.916667);
    expect(time["honeypot"].auroc).toBe(1);
    expect(time["honeypot"].prAuc).toBe(1);
    expect(time["bot-pump"].auroc).toBe(1);
    expect(time["bot-pump"].prAuc).toBe(1);

    const cluster = mustEvaluate(CLUSTER_SPLIT, OPTIONS);
    expect(cluster["rug-pull"].auroc).toBe(1);
    expect(cluster["rug-pull"].prAuc).toBe(1);
    expect(cluster["honeypot"].auroc).toBe(1);
    expect(cluster["honeypot"].prAuc).toBe(1);
    expect(cluster["bot-pump"].auroc).toBe(1);
    expect(cluster["bot-pump"].prAuc).toBe(1);
  });

  test("k206_precision_at_versioned_low_false_alarm_level", () => {
    const time = mustEvaluate(TIME_SPLIT, OPTIONS);
    expect(time["rug-pull"].precisionAtFar).toBe(1);
    expect(time["rug-pull"].thresholdAtFar).toBe(0.75);
    expect(time["honeypot"].precisionAtFar).toBe(1);
    expect(time["honeypot"].thresholdAtFar).toBe(0.6);
    expect(time["bot-pump"].precisionAtFar).toBe(1);
    expect(time["bot-pump"].thresholdAtFar).toBe(0.8);
  });

  test("k206_single_class_predictions_use_documented_degenerate_conventions", () => {
    const allNegative: readonly LabelledPrediction[] = Object.freeze([
      Object.freeze({
        probabilities: Object.freeze({ "rug-pull": 0.2, honeypot: 0.2, "bot-pump": 0.2 }),
        labels: Object.freeze({ "rug-pull": "negative", honeypot: "negative", "bot-pump": "negative" }),
      }),
      Object.freeze({
        probabilities: Object.freeze({ "rug-pull": 0.8, honeypot: 0.8, "bot-pump": 0.8 }),
        labels: Object.freeze({ "rug-pull": "negative", honeypot: "negative", "bot-pump": "negative" }),
      }),
    ]);
    const metrics = mustEvaluate(allNegative, OPTIONS);
    // No ranking signal exists, so AUROC stays at the no-information value
    // and PR-AUC stays at zero with no positives to retrieve.
    expect(metrics["rug-pull"].auroc).toBe(0.5);
    expect(metrics["rug-pull"].prAuc).toBe(0);
  });

  test("k206_metrics_ignore_prediction_order", () => {
    const forward = mustEvaluate(TIME_SPLIT, OPTIONS);
    const reversed = mustEvaluate(TIME_SPLIT.slice().reverse(), OPTIONS);
    expect(reversed).toEqual(forward);
  });
});
