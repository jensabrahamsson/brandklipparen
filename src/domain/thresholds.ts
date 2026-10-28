// Score band thresholds chosen on TRAIN (real calibration).
// Pure domain module: picks Low/Elevated/High cutoffs from TRAIN scores
// with a documented precision/recall rule, then applies them. The rule
// targets high precision for High (likely bad) and high recall for
// Elevated-or-above (catch most bad). No I/O, no clock, no randomness.
export type BandThresholds = {
  readonly elevated: number;
  readonly high: number;
};

export const DEFAULT_BAND_THRESHOLDS: BandThresholds = Object.freeze({ elevated: 30, high: 60 });

function precisionAt(scores: readonly { score: number; bad: boolean }[], threshold: number): number {
  let predicted = 0;
  let hits = 0;
  for (const entry of scores) {
    if (entry.score >= threshold) {
      predicted += 1;
      if (entry.bad) {
        hits += 1;
      }
    }
  }
  return predicted === 0 ? 1 : hits / predicted;
}

function recallAt(scores: readonly { score: number; bad: boolean }[], threshold: number): number {
  let totalBad = 0;
  let caught = 0;
  for (const entry of scores) {
    if (entry.bad) {
      totalBad += 1;
      if (entry.score >= threshold) {
        caught += 1;
      }
    }
  }
  return totalBad === 0 ? 1 : caught / totalBad;
}

export function chooseBandThresholds(
  scores: readonly { score: number; bad: boolean }[],
  targetPrecision = 0.8,
  targetRecall = 0.8,
): BandThresholds {
  if (scores.length === 0) {
    return DEFAULT_BAND_THRESHOLDS;
  }
  const candidates = [...new Set(scores.map((entry) => entry.score))].sort((left, right) => left - right);
  let high = DEFAULT_BAND_THRESHOLDS.high;
  for (const candidate of [...candidates].sort((left, right) => right - left)) {
    if (precisionAt(scores, candidate) >= targetPrecision) {
      high = candidate;
      break;
    }
  }
  let elevated = DEFAULT_BAND_THRESHOLDS.elevated;
  for (const candidate of candidates) {
    if (recallAt(scores, candidate) >= targetRecall) {
      elevated = candidate;
      break;
    }
  }
  if (elevated > high) {
    elevated = high;
  }
  return Object.freeze({ elevated, high });
}

export type ScoreBand = "Low" | "Elevated" | "High";

export function bandOfScore(score: number, thresholds: BandThresholds = DEFAULT_BAND_THRESHOLDS): ScoreBand {
  if (score >= thresholds.high) {
    return "High";
  }
  if (score >= thresholds.elevated) {
    return "Elevated";
  }
  return "Low";
}
