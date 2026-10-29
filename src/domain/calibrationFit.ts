// Detector-weight fitting for real calibration (L2 logistic, deterministic).
// Pure domain module: weighted logistic regression over binary detector
// features with an L2 penalty suited to a few hundred rows. Gradient
// descent from zero with fixed iterations and a fixed step keeps equal
// inputs bit-identical on every platform (A-32). No I/O, no clock.
export type LogisticFit = {
  readonly weights: readonly number[];
  readonly bias: number;
};

function sigmoid(value: number): number {
  if (value >= 0) {
    const exp = Math.exp(-value);
    return 1 / (1 + exp);
  }
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

export type LogisticFitOptions = {
  // Per-column non-negative constraint (S-115 calibration): when true for
  // a column, the weight projects to at least 0 after every gradient
  // step, so a detector whose documented semantics are risk-increasing
  // can never learn a protective weight. Absent means unconstrained.
  readonly nonNegative?: readonly boolean[] | undefined;
  // Per-column non-positive constraint (on-chain calibration): when true
  // for a column, the weight projects to at most 0 after every gradient
  // step, so a feature whose documented semantics are risk-decreasing
  // (burned share, locker share, liquidity depth) can never learn a
  // risk-increasing weight. Absent means unconstrained.
  readonly nonPositive?: readonly boolean[] | undefined;
};

export function fitWeightedLogistic(
  features: readonly (readonly number[])[],
  labels: readonly (0 | 1)[],
  sampleWeights: readonly number[],
  lambda: number,
  iterations = 500,
  step = 0.5,
  options: LogisticFitOptions = {},
): LogisticFit {
  const count = features.length;
  if (count === 0) {
    throw new Error("logistic fitting needs at least one row");
  }
  const width = features[0]?.length ?? 0;
  const weights = new Array<number>(width).fill(0);
  let bias = 0;
  let totalWeight = 0;
  for (const weight of sampleWeights) {
    totalWeight += weight;
  }
  const scale = totalWeight === 0 ? 1 : count / totalWeight;
  for (let round = 0; round < iterations; round += 1) {
    const gradW = new Array<number>(width).fill(0);
    let gradB = 0;
    for (let row = 0; row < count; row += 1) {
      const rowFeatures = features[row] ?? [];
      const label = labels[row] ?? 0;
      const sample = (sampleWeights[row] ?? 0) * scale;
      let logit = bias;
      for (let col = 0; col < width; col += 1) {
        logit += (weights[col] ?? 0) * (rowFeatures[col] ?? 0);
      }
      const predicted = sigmoid(logit);
      const error = (predicted - label) * sample;
      gradB += error;
      for (let col = 0; col < width; col += 1) {
        gradW[col] = (gradW[col] ?? 0) + error * (rowFeatures[col] ?? 0);
      }
    }
    const perRow = count === 0 ? 1 : 1 / count;
    gradB *= perRow;
    for (let col = 0; col < width; col += 1) {
      gradW[col] = (gradW[col] ?? 0) * perRow + lambda * (weights[col] ?? 0);
    }
    bias -= step * gradB;
    for (let col = 0; col < width; col += 1) {
      weights[col] = (weights[col] ?? 0) - step * (gradW[col] ?? 0);
      if (options.nonNegative?.[col] === true && (weights[col] ?? 0) < 0) {
        weights[col] = 0;
      }
      if (options.nonPositive?.[col] === true && (weights[col] ?? 0) > 0) {
        weights[col] = 0;
      }
    }
  }
  return Object.freeze({ weights: Object.freeze([...weights]), bias });
}

export function predictLogit(features: readonly number[], fit: LogisticFit): number {
  let logit = fit.bias;
  for (let index = 0; index < fit.weights.length; index += 1) {
    logit += (fit.weights[index] ?? 0) * (features[index] ?? 0);
  }
  return logit;
}

export function predictProbability(features: readonly number[], fit: LogisticFit): number {
  return sigmoid(predictLogit(features, fit));
}

// Platt scaling on TRAIN raw logits: fits slope and intercept mapping the
// one-dimensional logit to a calibrated probability. Deterministic. The
// slope floors at 0, so the map is always monotone non-decreasing: an
// inverted head (higher raw score for the negative class) yields a flat
// zero-slope map instead of a decreasing one, and the caller falls back
// to the prior mapping for such a head.
export function fitPlattScaling(
  rawLogits: readonly number[],
  labels: readonly (0 | 1)[],
  sampleWeights: readonly number[],
  lambda = 0,
  iterations = 500,
  step = 0.5,
): { readonly slope: number; readonly intercept: number } {
  const features = rawLogits.map((logit) => Object.freeze([logit]));
  const fit = fitWeightedLogistic(features, labels, sampleWeights, lambda, iterations, step);
  const slope = Math.max(0, fit.weights[0] ?? 0);
  return Object.freeze({ slope, intercept: fit.bias });
}

// Applies a Platt map to one raw logit. Pure and total: a finite input
// always gives a unit-interval probability.
export function applyPlattScaling(
  rawLogit: number,
  params: { readonly slope: number; readonly intercept: number },
): number {
  return predictProbability([rawLogit], { weights: Object.freeze([params.slope]), bias: params.intercept });
}

export type CalibratedHeadFit = {
  readonly weights: readonly number[];
  readonly bias: number;
  readonly slope: number;
  readonly intercept: number;
  // True when the head carries no monotone signal on TRAIN (no positives,
  // or the floored Platt slope is 0): weights, bias, slope and intercept
  // are the prior mapping and the caller marks the head uncalibrated.
  readonly uncalibrated: boolean;
};

// One risk head end to end (S-115 calibration): constrained L2 logistic
// fit over the detector features, then a floored Platt map on the TRAIN
// raw logits. A head with no positives, or whose Platt slope floors to 0
// (no monotone signal), keeps the prior mapping and reports uncalibrated
// instead of an inverted or flat fitted map. Deterministic.
export function fitCalibratedHead(
  features: readonly (readonly number[])[],
  labels: readonly (0 | 1)[],
  sampleWeights: readonly number[],
  lambda: number,
  prior: { readonly bias: number; readonly slope: number; readonly intercept: number },
  nonNegative: readonly boolean[],
  iterations = 500,
  step = 0.5,
  nonPositive: readonly boolean[] = [],
): CalibratedHeadFit {
  let positives = 0;
  for (const label of labels) {
    positives += label;
  }
  if (positives === 0) {
    return Object.freeze({
      weights: Object.freeze(nonNegative.map(() => 0)),
      bias: prior.bias,
      slope: prior.slope,
      intercept: prior.intercept,
      uncalibrated: true,
    });
  }
  const fit = fitWeightedLogistic(features, labels, sampleWeights, lambda, iterations, step, { nonNegative, nonPositive });
  const rawLogits = features.map((row) => predictLogit(row, fit));
  const scaled = fitPlattScaling(rawLogits, labels, sampleWeights, 0, iterations, step);
  if (scaled.slope <= 0) {
    return Object.freeze({
      weights: Object.freeze(nonNegative.map(() => 0)),
      bias: prior.bias,
      slope: prior.slope,
      intercept: prior.intercept,
      uncalibrated: true,
    });
  }
  return Object.freeze({ weights: fit.weights, bias: fit.bias, slope: scaled.slope, intercept: scaled.intercept, uncalibrated: false });
}
