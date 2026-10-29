// Frozen holdout-v2 evaluation helpers (pure, no I/O).
// Application service shared by the freeze step in scripts/calibrate-real.ts
// and the scoring path in scripts/evaluate-holdout-v2.ts. It carries the
// frozen config schema, its canonical hash, the holdout dataset parse, the
// frozen-head scoring and the aggregate metrics. Nothing here reads files,
// the chain or the clock, and it never fits or tunes anything.
import { applyPlattScaling } from "../domain/calibrationFit.ts";
import { canonicalSerialize, sha256Hex, canonicalBytes } from "../domain/serialize.ts";
import type { CanonicalValue } from "../domain/serialize.ts";
import { err, ok } from "../domain/result.ts";
import type { Result } from "../domain/result.ts";

export const HOLDOUT_FROZEN_VERSION = "holdout-v2-freeze-v1";

export const HOLDOUT_POSITIVE_CLASS =
  "bad=1 when label is rug, scam or honeypot; bad=0 when legit; unknown excluded from train/test and reported separately";

export const HOLDOUT_UNKNOWN_HANDLING =
  "unknown rows are excluded from AUC, Brier and confusion denominators; they are reported separately with band distribution and coverage only";

export const HOLDOUT_DECISION_RULE =
  "bad probability mapped as prob*100 through the frozen fitted bands; predicted bad is Elevated or High (prob*100 at or above the frozen elevated cutoff)";

export type FrozenHead = {
  readonly weights: readonly number[];
  readonly bias: number;
  readonly slope: number;
  readonly intercept: number;
  readonly uncalibrated: boolean;
};

export type FrozenArm = {
  readonly ablation: string;
  readonly featureNames: readonly string[];
  readonly lambda: number;
  readonly rug: FrozenHead;
  readonly honey: FrozenHead;
};

export type FrozenScaler = {
  readonly features: readonly string[];
  readonly means: readonly number[];
  readonly sds: readonly number[];
  readonly scaled: readonly boolean[];
};

export type FrozenConfig = {
  readonly frozenVersion: string;
  readonly modelVersion: string;
  readonly dataVersion: string;
  readonly seed: number;
  readonly gitCommit: string;
  readonly featureVersion: string;
  readonly positiveClass: string;
  readonly unknownHandling: string;
  readonly decisionRule: string;
  readonly bytecodeFeatureNames: readonly string[];
  readonly onchainServableFeatures: readonly string[];
  readonly bothFeatureNames: readonly string[];
  readonly arms: {
    readonly bytecode: FrozenArm;
    readonly onchain: FrozenArm;
    readonly both: FrozenArm;
  };
  readonly scaler: FrozenScaler;
  readonly signRules: Readonly<Record<string, string>>;
  readonly lockerList: {
    readonly snapshotNames: readonly string[];
    readonly addresses: readonly string[];
  };
  readonly regularization: {
    readonly bytecodeLambda: number;
    readonly onchainLambda: number;
    readonly bothLambda: number;
    readonly grid: readonly number[];
    readonly selection: string;
  };
  readonly bandThresholds: { readonly elevated: number; readonly high: number };
  readonly appliedBands: { readonly elevated: number; readonly high: number };
  readonly calibrationDatasetSha256: string;
  readonly calibrationSnapshotSha256: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isHexString(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value) && value.length >= 2;
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function parseHead(raw: unknown): FrozenHead | null {
  if (!isRecord(raw)) {
    return null;
  }
  const weights = raw["weights"];
  if (!Array.isArray(weights) || !weights.every(isFiniteNumber)) {
    return null;
  }
  const bias = raw["bias"];
  const slope = raw["slope"];
  const intercept = raw["intercept"];
  const uncalibrated = raw["uncalibrated"];
  if (!isFiniteNumber(bias) || !isFiniteNumber(slope) || !isFiniteNumber(intercept) || typeof uncalibrated !== "boolean") {
    return null;
  }
  return Object.freeze({
    weights: Object.freeze([...(weights as number[])]),
    bias,
    slope,
    intercept,
    uncalibrated,
  });
}

function parseArm(raw: unknown, name: string): FrozenArm | null {
  if (!isRecord(raw)) {
    return null;
  }
  const ablation = raw["ablation"];
  const featureNames = raw["featureNames"];
  const lambda = raw["lambda"];
  if (typeof ablation !== "string" || ablation !== name) {
    return null;
  }
  if (!Array.isArray(featureNames) || !featureNames.every((entry) => typeof entry === "string")) {
    return null;
  }
  if (!isFiniteNumber(lambda)) {
    return null;
  }
  const rug = parseHead(raw["rug"]);
  const honey = parseHead(raw["honey"]);
  if (rug === null || honey === null) {
    return null;
  }
  if (rug.weights.length !== featureNames.length || honey.weights.length !== featureNames.length) {
    return null;
  }
  return Object.freeze({
    ablation,
    featureNames: Object.freeze([...(featureNames as string[])]),
    lambda,
    rug,
    honey,
  });
}

export type FrozenParseError = { kind: "invalid-frozen"; message: string };

function invalid(message: string): Result<never, FrozenParseError> {
  return err({ kind: "invalid-frozen", message });
}

// Strict validation of a frozen config file: exact top-level shape, three
// arms present, head widths matching their feature lists, finite numbers.
// Extra dataset columns in the holdout files are ignored by the dataset
// parser below and never reach this schema.
export function parseFrozenConfig(raw: unknown): Result<FrozenConfig, FrozenParseError> {
  if (!isRecord(raw)) {
    return invalid("frozen config must be a JSON object");
  }
  const text = (name: string): string | null => (typeof raw[name] === "string" ? (raw[name] as string) : null);
  const frozenVersion = text("frozenVersion");
  const modelVersion = text("modelVersion");
  const dataVersion = text("dataVersion");
  const gitCommit = text("gitCommit");
  const featureVersion = text("featureVersion");
  const positiveClass = text("positiveClass");
  const unknownHandling = text("unknownHandling");
  const decisionRule = text("decisionRule");
  const calibrationDatasetSha256 = text("calibrationDatasetSha256");
  const calibrationSnapshotSha256 = text("calibrationSnapshotSha256");
  if (
    frozenVersion !== HOLDOUT_FROZEN_VERSION ||
    modelVersion === null ||
    modelVersion.length === 0 ||
    dataVersion === null ||
    dataVersion.length === 0 ||
    gitCommit === null ||
    featureVersion === null ||
    positiveClass === null ||
    unknownHandling === null ||
    decisionRule === null ||
    calibrationDatasetSha256 === null ||
    calibrationSnapshotSha256 === null
  ) {
    return invalid("frozen config carries invalid or missing identity fields");
  }
  const seed = raw["seed"];
  if (typeof seed !== "number" || !Number.isInteger(seed) || seed < 0) {
    return invalid("frozen config seed must be an integer at least 0");
  }
  const listOfStrings = (value: unknown): readonly string[] | null =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string") ? Object.freeze([...value] as string[]) : null;
  const bytecodeFeatureNames = listOfStrings(raw["bytecodeFeatureNames"]);
  const onchainServableFeatures = listOfStrings(raw["onchainServableFeatures"]);
  const bothFeatureNames = listOfStrings(raw["bothFeatureNames"]);
  if (bytecodeFeatureNames === null || onchainServableFeatures === null || bothFeatureNames === null) {
    return invalid("frozen config feature lists must be string arrays");
  }
  const armsRaw = raw["arms"];
  if (!isRecord(armsRaw)) {
    return invalid("frozen config arms must be an object");
  }
  const bytecode = parseArm(armsRaw["bytecode"], "bytecode");
  const onchain = parseArm(armsRaw["onchain"], "onchain");
  const both = parseArm(armsRaw["both"], "both");
  if (bytecode === null || onchain === null || both === null) {
    return invalid("frozen config must carry bytecode, onchain and both arms");
  }
  const scalerRaw = raw["scaler"];
  if (!isRecord(scalerRaw)) {
    return invalid("frozen config scaler must be an object");
  }
  const features = listOfStrings(scalerRaw["features"]);
  const means = Array.isArray(scalerRaw["means"]) && (scalerRaw["means"] as unknown[]).every(isFiniteNumber)
    ? Object.freeze([...(scalerRaw["means"] as number[])])
    : null;
  const sds = Array.isArray(scalerRaw["sds"]) && (scalerRaw["sds"] as unknown[]).every(isFiniteNumber)
    ? Object.freeze([...(scalerRaw["sds"] as number[])])
    : null;
  const scaled = Array.isArray(scalerRaw["scaled"]) && (scalerRaw["scaled"] as unknown[]).every((entry) => typeof entry === "boolean")
    ? Object.freeze([...(scalerRaw["scaled"] as boolean[])])
    : null;
  if (features === null || means === null || sds === null || scaled === null) {
    return invalid("frozen config scaler fields must be arrays");
  }
  if (features.length !== means.length || features.length !== sds.length || features.length !== scaled.length) {
    return invalid("frozen config scaler arrays must share one length");
  }
  const signRules = raw["signRules"];
  if (!isRecord(signRules) || !Object.values(signRules).every((entry) => typeof entry === "string")) {
    return invalid("frozen config signRules must map feature names to strings");
  }
  const lockerRaw = raw["lockerList"];
  if (!isRecord(lockerRaw)) {
    return invalid("frozen config lockerList must be an object");
  }
  const snapshotNames = listOfStrings(lockerRaw["snapshotNames"]);
  const addresses = listOfStrings(lockerRaw["addresses"]);
  if (snapshotNames === null || addresses === null) {
    return invalid("frozen config lockerList must carry string arrays");
  }
  const regRaw = raw["regularization"];
  if (!isRecord(regRaw)) {
    return invalid("frozen config regularization must be an object");
  }
  const bytecodeLambda = regRaw["bytecodeLambda"];
  const onchainLambda = regRaw["onchainLambda"];
  const bothLambda = regRaw["bothLambda"];
  const grid = regRaw["grid"];
  const selection = regRaw["selection"];
  if (
    !isFiniteNumber(bytecodeLambda) ||
    !isFiniteNumber(onchainLambda) ||
    !isFiniteNumber(bothLambda) ||
    !Array.isArray(grid) ||
    !(grid as unknown[]).every(isFiniteNumber) ||
    typeof selection !== "string"
  ) {
    return invalid("frozen config regularization fields are invalid");
  }
  const bandsRaw = raw["bandThresholds"];
  const appliedRaw = raw["appliedBands"];
  if (!isRecord(bandsRaw) || !isRecord(appliedRaw)) {
    return invalid("frozen config bands must be objects");
  }
  const elevated = bandsRaw["elevated"];
  const high = bandsRaw["high"];
  const appliedElevated = appliedRaw["elevated"];
  const appliedHigh = appliedRaw["high"];
  if (
    typeof elevated !== "number" ||
    typeof high !== "number" ||
    typeof appliedElevated !== "number" ||
    typeof appliedHigh !== "number" ||
    !(elevated < high)
  ) {
    return invalid("frozen config bandThresholds must carry elevated below high");
  }
  return ok(
    Object.freeze({
      frozenVersion,
      modelVersion,
      dataVersion,
      seed,
      gitCommit,
      featureVersion,
      positiveClass,
      unknownHandling,
      decisionRule,
      bytecodeFeatureNames,
      onchainServableFeatures,
      bothFeatureNames,
      arms: Object.freeze({ bytecode, onchain, both }),
      scaler: Object.freeze({ features, means, sds, scaled }),
      signRules: Object.freeze({ ...(signRules as Record<string, string>) }),
      lockerList: Object.freeze({ snapshotNames, addresses }),
      regularization: Object.freeze({
        bytecodeLambda,
        onchainLambda,
        bothLambda,
        grid: Object.freeze([...(grid as number[])]),
        selection,
      }),
      bandThresholds: Object.freeze({ elevated, high }),
      appliedBands: Object.freeze({ elevated: appliedElevated, high: appliedHigh }),
      calibrationDatasetSha256,
      calibrationSnapshotSha256,
    }),
  );
}

// Canonical text of a frozen config: key order normalized, so the sha256
// below is stable across machines and runs for equal inputs.
export function canonicalFrozenText(config: FrozenConfig): string {
  return canonicalSerialize(config as unknown as CanonicalValue);
}

export function frozenSha256(config: FrozenConfig): string {
  return sha256Hex(canonicalBytes(config as unknown as CanonicalValue));
}

export function frozenSha256OfText(text: string): string {
  return sha256Hex(canonicalBytes(JSON.parse(text) as CanonicalValue));
}

export type HoldoutRow = {
  readonly address: string;
  readonly label: string;
  readonly bytecode: string;
  readonly implementationBytecode: string | null;
};

export type HoldoutDatasetError = { kind: "invalid-dataset"; message: string };

function datasetInvalid(message: string): Result<never, HoldoutDatasetError> {
  return err({ kind: "invalid-dataset", message });
}

// Holdout dataset parse: an array of rows with address, label and bytecode.
// Only these scoring inputs are read; every extra dataset column is ignored
// and never enters features, filters or decisions. An optional datasetSplit
// marker must name holdout-v2 when present.
export function parseHoldoutDataset(raw: unknown): Result<readonly HoldoutRow[], HoldoutDatasetError> {
  if (!Array.isArray(raw)) {
    return datasetInvalid("holdout dataset must be a JSON array");
  }
  const rows: HoldoutRow[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    if (!isRecord(entry)) {
      return datasetInvalid(`holdout row at index ${index} must be an object`);
    }
    const address = entry["address"];
    if (!isAddress(address)) {
      return datasetInvalid(`holdout row at index ${index} carries an invalid address`);
    }
    const label = entry["label"];
    if (label !== "legit" && label !== "rug" && label !== "honeypot" && label !== "scam" && label !== "unknown") {
      return datasetInvalid(`holdout row at index ${index} carries an unknown label`);
    }
    const split = entry["datasetSplit"];
    if (split !== undefined && split !== "holdout-v2") {
      return datasetInvalid(`holdout row at index ${index} carries an unexpected datasetSplit`);
    }
    const bytecode = entry["bytecode"];
    if (typeof bytecode !== "string" || !isHexString(bytecode)) {
      return datasetInvalid(`holdout row at index ${index} carries an invalid bytecode`);
    }
    let implementationBytecode: string | null = null;
    const implementation = entry["implementation"];
    if (isRecord(implementation)) {
      const inner = implementation["bytecode"];
      if (typeof inner === "string") {
        if (!isHexString(inner)) {
          return datasetInvalid(`holdout row at index ${index} carries an invalid implementation bytecode`);
        }
        implementationBytecode = inner;
      }
    }
    rows.push(Object.freeze({ address: (address as string).toLowerCase(), label: label as string, bytecode, implementationBytecode }));
  }
  return ok(Object.freeze(rows));
}

export function effectiveBytecodeOf(row: HoldoutRow): string {
  return row.implementationBytecode ?? row.bytecode;
}

// Frozen-head scoring for one feature vector: the max of the two Platt
// mapped head probabilities, the same bad-probability rule the TEST metrics
// use. No fitting happens here; weights arrive frozen.
export function scoreFrozenArm(features: readonly number[], arm: FrozenArm): number {
  const rugLogit = arm.rug.weights.reduce((total, weight, index) => total + weight * (features[index] ?? 0), arm.rug.bias);
  const honeyLogit = arm.honey.weights.reduce((total, weight, index) => total + weight * (features[index] ?? 0), arm.honey.bias);
  const rug = applyPlattScaling(rugLogit, { slope: arm.rug.slope, intercept: arm.rug.intercept });
  const honey = applyPlattScaling(honeyLogit, { slope: arm.honey.slope, intercept: arm.honey.intercept });
  return Math.max(rug, honey);
}

// Apply frozen TRAIN scaler params to one servable vector with its
// availability mask: binaries pass through, unavailable continuous values
// map to zero contribution, available ones standardize. No refit.
export function applyFrozenScaler(
  vector: readonly number[],
  available: readonly boolean[],
  scaler: FrozenScaler,
): readonly number[] {
  return Object.freeze(
    scaler.features.map((_, col) => {
      const isScaled = scaler.scaled[col] ?? false;
      if (!isScaled) {
        return vector[col] ?? 0;
      }
      if (!(available[col] ?? false)) {
        return 0;
      }
      const value = vector[col] ?? 0;
      if (!Number.isFinite(value)) {
        return 0;
      }
      const mean = scaler.means[col] ?? 0;
      const sd = scaler.sds[col] ?? 1;
      return (value - mean) / sd;
    }),
  );
}

export function round6(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}

export function badLabelOf(label: string): 0 | 1 {
  return label === "rug" || label === "scam" || label === "honeypot" ? 1 : 0;
}

export function isUnknownLabel(label: string): boolean {
  return label === "unknown";
}

export function aucRank(scores: readonly number[], labels: readonly (0 | 1)[]): number {
  const paired = scores.map((score, index) => ({ score, label: labels[index] ?? 0 }));
  paired.sort((left, right) => left.score - right.score);
  let positives = 0;
  for (const entry of paired) {
    positives += entry.label;
  }
  const negatives = paired.length - positives;
  if (positives === 0 || negatives === 0) {
    return 0.5;
  }
  let rankSum = 0;
  let cursor = 0;
  while (cursor < paired.length) {
    const value = paired[cursor]?.score ?? 0;
    let end = cursor + 1;
    while (end < paired.length && (paired[end]?.score ?? 0) === value) {
      end += 1;
    }
    const meanRank = (cursor + 1 + end) / 2;
    for (let index = cursor; index < end; index += 1) {
      if ((paired[index]?.label ?? 0) === 1) {
        rankSum += meanRank;
      }
    }
    cursor = end;
  }
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

function makeLcg(start: number): () => number {
  let state = start >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// Deterministic bootstrap 95 percent interval for an AUC: resamples the
// scored rows with replacement through a seeded LCG (no unseeded randomness), so
// equal inputs give bit-identical bounds on every run. Same construction
// as the TEST metrics in the calibration report.
export function bootstrapAucCI(
  probs: readonly number[],
  labels: readonly (0 | 1)[],
  resamples: number,
  start: number,
): { readonly lower: number; readonly upper: number; readonly resamples: number } {
  const draw = makeLcg(start);
  const count = probs.length;
  const estimates: number[] = [];
  for (let round = 0; round < resamples; round += 1) {
    const sampledProbs: number[] = [];
    const sampledLabels: (0 | 1)[] = [];
    for (let index = 0; index < count; index += 1) {
      const pick = Math.floor(draw() * count);
      sampledProbs.push(probs[pick] ?? 0);
      sampledLabels.push(labels[pick] ?? 0);
    }
    estimates.push(aucRank(sampledProbs, sampledLabels));
  }
  estimates.sort((left, right) => left - right);
  const lower = estimates[Math.floor(0.025 * resamples)] ?? 0.5;
  const upper = estimates[Math.min(resamples - 1, Math.floor(0.975 * resamples))] ?? 0.5;
  return Object.freeze({ lower: round6(lower), upper: round6(upper), resamples });
}

export function brier(probs: readonly number[], labels: readonly (0 | 1)[]): number {
  if (probs.length === 0) {
    return 0;
  }
  let total = 0;
  for (let index = 0; index < probs.length; index += 1) {
    const error = (probs[index] ?? 0) - (labels[index] ?? 0);
    total += error * error;
  }
  return total / probs.length;
}

export type BandCounts = { readonly low: number; readonly elevated: number; readonly high: number };

export function bandCountsOf(probs: readonly number[], elevated: number, high: number): BandCounts {
  let low = 0;
  let mid = 0;
  let top = 0;
  for (const prob of probs) {
    const score = (prob ?? 0) * 100;
    if (score >= high) {
      top += 1;
    } else if (score >= elevated) {
      mid += 1;
    } else {
      low += 1;
    }
  }
  return Object.freeze({ low, elevated: mid, high: top });
}

export type Confusion = {
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly trueNegatives: number;
  readonly falseNegatives: number;
};

// Confusion at the frozen decision rule: predicted bad is Elevated or High
// (prob*100 at or above the frozen elevated cutoff), predicted good is Low.
export function confusionOf(probs: readonly number[], labels: readonly (0 | 1)[], elevated: number): Confusion {
  let truePositives = 0;
  let falsePositives = 0;
  let trueNegatives = 0;
  let falseNegatives = 0;
  for (let index = 0; index < probs.length; index += 1) {
    const predicted = (probs[index] ?? 0) * 100 >= elevated;
    const actual = (labels[index] ?? 0) === 1;
    if (predicted && actual) {
      truePositives += 1;
    } else if (predicted && !actual) {
      falsePositives += 1;
    } else if (!predicted && !actual) {
      trueNegatives += 1;
    } else {
      falseNegatives += 1;
    }
  }
  return Object.freeze({ truePositives, falsePositives, trueNegatives, falseNegatives });
}
