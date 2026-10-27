// Calibration and discrimination metrics over labelled predictions
// (K-205, K-206, S-021). Pure domain module: every prediction and every
// measurement setting arrives as a caller parameter, and the functions
// compute solely on passed-in values in a fixed order of operations. No
// I/O, no clock, no randomness, no environment access, no platform
// imports. Detection thresholds, weights and limits never live here; they
// belong to the versioned model artifact per K-210 and A-20. The bin count
// and the false-alarm level below steer measurement arithmetic only and
// are recorded with each report, so equal inputs give bit-identical
// outputs on every platform (A-32).
import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";
import type { LabelValue } from "./dataset.ts";
import type { RiskType } from "./signals.ts";

// Fixed risk order for every per-risk loop (lexicographic): equal inputs
// give bit-identical output on every platform (A-32).
const RISK_ORDER: readonly RiskType[] = Object.freeze(["bot-pump", "honeypot", "rug-pull"]);

// Fixed decimals for every reported metric value: rounding before storage
// keeps the canonical serialization in the model card bit-identical across
// platforms (A-32 point 6).
const REPORT_DECIMALS = 6;

function roundReported(value: number): number {
  const factor = 10 ** REPORT_DECIMALS;
  return Math.round(value * factor) / factor;
}

// One scored token per risk type: the stated probability beside the
// settled label from the versioned label policy (K-202).
export type LabelledPrediction = {
  readonly probabilities: Readonly<Record<RiskType, number>>;
  readonly labels: Readonly<Record<RiskType, LabelValue>>;
};

// Caller-supplied measurement settings (placeholders from the offline
// chain, not model values): the ECE bin count and the low false-alarm
// level for precision. Both travel with the report per K-209, and the
// production false-alarm level arrives through the versioned artifact per
// K-206 and K-210.
export type MetricsOptions = {
  readonly binCount: number;
  readonly falseAlarmRate: number;
};

// One ECE bin for the reliability diagram per risk type (K-205): the
// predicted mean beside the observed share of positives in the bin.
export type ReliabilityBin = {
  readonly index: number;
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
  readonly meanPredicted: number;
  readonly observedRate: number;
};

// Per-class measures (K-205, K-206): ECE and Brier for calibration,
// AUROC and PR-AUC for ranking, precision at the low false-alarm level
// with the threshold that reaches it, plus the bin detail behind ECE.
export type ClassMetrics = {
  readonly count: number;
  readonly positives: number;
  readonly negatives: number;
  readonly ece: number;
  readonly brier: number;
  readonly auroc: number;
  readonly prAuc: number;
  readonly precisionAtFar: number;
  readonly thresholdAtFar: number;
  readonly bins: readonly ReliabilityBin[];
};

export type SplitMetrics = Readonly<Record<RiskType, ClassMetrics>>;

export type MetricsError =
  | { kind: "invalid-predictions"; message: string }
  | { kind: "invalid-options"; message: string };

function invalidPredictions(message: string): Result<never, MetricsError> {
  return err({ kind: "invalid-predictions", message });
}

function invalidOptions(message: string): Result<never, MetricsError> {
  return err({ kind: "invalid-options", message });
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateOptions(options: MetricsOptions): MetricsError | null {
  if (
    typeof options.binCount !== "number" ||
    !Number.isInteger(options.binCount) ||
    options.binCount <= 0
  ) {
    return { kind: "invalid-options", message: "metrics binCount must be a positive integer" };
  }
  if (
    typeof options.falseAlarmRate !== "number" ||
    !Number.isFinite(options.falseAlarmRate) ||
    options.falseAlarmRate <= 0 ||
    options.falseAlarmRate >= 1
  ) {
    return { kind: "invalid-options", message: "metrics falseAlarmRate must lie strictly between 0 and 1" };
  }
  return null;
}

function validatePredictions(predictions: readonly LabelledPrediction[]): MetricsError | null {
  if (predictions.length === 0) {
    return { kind: "invalid-predictions", message: "metrics need at least one labelled prediction" };
  }
  for (const prediction of predictions) {
    for (const risk of RISK_ORDER) {
      if (!isProbability(prediction.probabilities[risk])) {
        return {
          kind: "invalid-predictions",
          message: `prediction for ${risk} must carry a probability in [0, 1]`,
        };
      }
      const label = prediction.labels[risk];
      if (label !== "positive" && label !== "negative") {
        return {
          kind: "invalid-predictions",
          message: `prediction for ${risk} must carry a closed label, positive or negative`,
        };
      }
    }
  }
  return null;
}

type ScoredOutcome = {
  readonly score: number;
  readonly outcome: 0 | 1;
};

function outcomesFor(predictions: readonly LabelledPrediction[], risk: RiskType): ScoredOutcome[] {
  const out: ScoredOutcome[] = [];
  for (const prediction of predictions) {
    out.push({
      score: prediction.probabilities[risk] ?? 0,
      outcome: prediction.labels[risk] === "positive" ? 1 : 0,
    });
  }
  // Fixed order: score ascending, outcome ascending on ties. Tied scores
  // are handled as one group by every measure below, so the secondary key
  // only keeps the order total and deterministic.
  out.sort((left, right) => {
    if (left.score !== right.score) {
      return left.score < right.score ? -1 : 1;
    }
    return left.outcome - right.outcome;
  });
  return out;
}

function binIndex(score: number, binCount: number): number {
  const raw = Math.floor(score * binCount);
  return Math.min(raw, binCount - 1);
}

// Expected calibration error with uniform bins over [0, 1]: the
// count-weighted mean of |observed - predicted| per bin, plus the bin
// detail for the reliability diagram (K-205).
function eceAndBins(
  outcomes: readonly ScoredOutcome[],
  binCount: number,
): { readonly ece: number; readonly bins: readonly ReliabilityBin[] } {
  const sums: number[] = new Array<number>(binCount).fill(0);
  const hits: number[] = new Array<number>(binCount).fill(0);
  const counts: number[] = new Array<number>(binCount).fill(0);
  for (const entry of outcomes) {
    const index = binIndex(entry.score, binCount);
    sums[index] = (sums[index] ?? 0) + entry.score;
    hits[index] = (hits[index] ?? 0) + entry.outcome;
    counts[index] = (counts[index] ?? 0) + 1;
  }
  const total = outcomes.length;
  let ece = 0;
  const bins: ReliabilityBin[] = [];
  for (let index = 0; index < binCount; index += 1) {
    const count = counts[index] ?? 0;
    const meanPredicted = count === 0 ? 0 : (sums[index] ?? 0) / count;
    const observedRate = count === 0 ? 0 : (hits[index] ?? 0) / count;
    if (count > 0) {
      ece += (Math.abs(observedRate - meanPredicted) * count) / total;
    }
    bins.push(
      Object.freeze({
        index,
        lower: roundReported(index / binCount),
        upper: roundReported((index + 1) / binCount),
        count,
        meanPredicted: roundReported(meanPredicted),
        observedRate: roundReported(observedRate),
      }),
    );
  }
  return { ece: roundReported(ece), bins: Object.freeze(bins) };
}

function brierScore(outcomes: readonly ScoredOutcome[]): number {
  let total = 0;
  for (const entry of outcomes) {
    const error = entry.score - entry.outcome;
    total += error * error;
  }
  return roundReported(total / outcomes.length);
}

// AUROC through average ranks with tie correction (Mann-Whitney form):
// equal scores share their rank span, so ties stay deterministic. A
// single-class set carries no ranking signal and reports the
// no-information value 0.5 (documented in the model card limits).
function aurocScore(outcomes: readonly ScoredOutcome[]): number {
  let positives = 0;
  for (const entry of outcomes) {
    positives += entry.outcome;
  }
  const negatives = outcomes.length - positives;
  if (positives === 0 || negatives === 0) {
    return 0.5;
  }
  let rankSum = 0;
  let cursor = 0;
  while (cursor < outcomes.length) {
    const score = outcomes[cursor]?.score ?? 0;
    let end = cursor + 1;
    while (end < outcomes.length && (outcomes[end]?.score ?? 0) === score) {
      end += 1;
    }
    // Ranks are one-based: positions cursor + 1 through end share the
    // mean rank (cursor + 1 + end) / 2.
    const meanRank = (cursor + 1 + end) / 2;
    for (let index = cursor; index < end; index += 1) {
      if ((outcomes[index]?.outcome ?? 0) === 1) {
        rankSum += meanRank;
      }
    }
    cursor = end;
  }
  return roundReported((rankSum - (positives * (positives + 1)) / 2) / (positives * negatives));
}

// PR-AUC as average precision over tied-score groups in descending order:
// each group contributes its post-group precision times its share of the
// positives. No positives means nothing to retrieve, so the value is 0;
// an all-positive set retrieves everything at precision 1.
function prAucScore(outcomes: readonly ScoredOutcome[]): number {
  let positives = 0;
  for (const entry of outcomes) {
    positives += entry.outcome;
  }
  if (positives === 0) {
    return 0;
  }
  let area = 0;
  let truePositives = 0;
  let falsePositives = 0;
  let cursor = outcomes.length - 1;
  while (cursor >= 0) {
    const score = outcomes[cursor]?.score ?? 0;
    let groupPositives = 0;
    let groupSize = 0;
    while (cursor >= 0 && (outcomes[cursor]?.score ?? 0) === score) {
      groupPositives += outcomes[cursor]?.outcome ?? 0;
      groupSize += 1;
      cursor -= 1;
    }
    truePositives += groupPositives;
    falsePositives += groupSize - groupPositives;
    area += (truePositives / (truePositives + falsePositives)) * (groupPositives / positives);
  }
  return roundReported(area);
}

// Precision at the low false-alarm level (K-206): each distinct score is a
// threshold (predict positive at or above it), plus the empty operating
// point that predicts nothing. The winner maximizes recall under the
// level, then precision; full ties keep the higher threshold because
// thresholds are considered from high to low, so the choice stays
// deterministic. Precision with no predicted positives is 0; recall with
// no positives is 0.
function precisionAtFar(
  outcomes: readonly ScoredOutcome[],
  falseAlarmRate: number,
): { readonly precision: number; readonly threshold: number } {
  let positives = 0;
  for (const entry of outcomes) {
    positives += entry.outcome;
  }
  const negatives = outcomes.length - positives;
  let bestPrecision = 0;
  let bestRecall = -1;
  let bestThreshold = Number.POSITIVE_INFINITY;
  const consider = (truePositives: number, falsePositives: number, threshold: number): void => {
    const predicted = truePositives + falsePositives;
    const precision = predicted === 0 ? 0 : truePositives / predicted;
    const recall = positives === 0 ? 0 : truePositives / positives;
    const far = negatives === 0 ? 0 : falsePositives / negatives;
    if (far > falseAlarmRate) {
      return;
    }
    if (recall > bestRecall || (recall === bestRecall && precision > bestPrecision)) {
      bestRecall = recall;
      bestPrecision = precision;
      bestThreshold = threshold;
    }
  };
  // The empty operating point always qualifies (zero false alarms), so a
  // winner always exists.
  consider(0, 0, Number.POSITIVE_INFINITY);
  let truePositives = 0;
  let falsePositives = 0;
  let cursor = outcomes.length - 1;
  while (cursor >= 0) {
    const score = outcomes[cursor]?.score ?? 0;
    while (cursor >= 0 && (outcomes[cursor]?.score ?? 0) === score) {
      if ((outcomes[cursor]?.outcome ?? 0) === 1) {
        truePositives += 1;
      } else {
        falsePositives += 1;
      }
      cursor -= 1;
    }
    consider(truePositives, falsePositives, score);
  }
  return { precision: roundReported(bestPrecision), threshold: roundReported(bestThreshold) };
}

function metricsFor(outcomes: readonly ScoredOutcome[], options: MetricsOptions): ClassMetrics {
  let positives = 0;
  for (const entry of outcomes) {
    positives += entry.outcome;
  }
  const { ece, bins } = eceAndBins(outcomes, options.binCount);
  const operating = precisionAtFar(outcomes, options.falseAlarmRate);
  return Object.freeze({
    count: outcomes.length,
    positives,
    negatives: outcomes.length - positives,
    ece,
    brier: brierScore(outcomes),
    auroc: aurocScore(outcomes),
    prAuc: prAucScore(outcomes),
    precisionAtFar: operating.precision,
    thresholdAtFar: operating.threshold,
    bins,
  });
}

// Per-class calibration and discrimination measures over one labelled
// prediction set (K-205, K-206). Unknown input gives a typed error; valid
// input gives the frozen per-class table. Prediction order leaves the
// result unchanged: every measure sorts its own copy first.
export function evaluatePredictions(
  predictions: readonly LabelledPrediction[],
  options: MetricsOptions,
): Result<SplitMetrics, MetricsError> {
  const optionsError = validateOptions(options);
  if (optionsError !== null) {
    return invalidOptions(optionsError.message);
  }
  const predictionsError = validatePredictions(predictions);
  if (predictionsError !== null) {
    return invalidPredictions(predictionsError.message);
  }
  return ok(
    Object.freeze({
      "bot-pump": metricsFor(outcomesFor(predictions, "bot-pump"), options),
      honeypot: metricsFor(outcomesFor(predictions, "honeypot"), options),
      "rug-pull": metricsFor(outcomesFor(predictions, "rug-pull"), options),
    }),
  );
}
