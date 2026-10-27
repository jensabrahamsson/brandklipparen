// Versioned model card with date, data version and limitations (K-208,
// S-021). Pure domain module: the card records the artifact checksum and
// version, the split methods and versions, the metric values from
// src/domain/metrics.ts and the documented limits of the synthetic and
// placeholder calibration. Unknown JSON becomes a typed card through
// createModelCard; serialization is canonical (A-32), so equal cards give
// byte-identical text. No I/O, no clock, no randomness, no environment
// access, no platform imports. Detection thresholds, weights and limits
// never live here; they belong to the versioned model artifact per K-210
// and A-20.
import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";
import { ArtifactChecksum, ModelVersion } from "./types.ts";
import type { CanonicalValue } from "./serialize.ts";
import { canonicalSerialize } from "./serialize.ts";
import type { ClassMetrics, SplitMetrics } from "./metrics.ts";
import type { RiskType } from "./signals.ts";

// Fixed risk order for every per-risk loop (lexicographic): equal inputs
// give bit-identical output on every platform (A-32).
const RISK_ORDER: readonly RiskType[] = Object.freeze(["bot-pump", "honeypot", "rug-pull"]);

// Longest single limitation entry: a format bound that keeps the card
// reviewable, not a model value.
const MAX_LIMITATION_CHARS = 2000;

// One S-018 evaluation on the card: the split method and version beside
// the frozen per-class metrics on the train and test parts (K-203, K-204,
// K-205, K-206). Counts are whole-split sizes; the calibration part is
// counted but carries no metrics, since calibration fits no scorer here.
export type ModelCardEvaluation = {
  readonly method: string;
  readonly methodVersion: string;
  readonly trainCount: number;
  readonly calibrationCount: number;
  readonly testCount: number;
  readonly trainMetrics: SplitMetrics;
  readonly testMetrics: SplitMetrics;
};

// Recorded measurement settings (placeholders from the offline chain, not
// model values): the ECE bin count, the low false-alarm level and the
// named prediction source the metrics were computed from.
export type ModelCardMeasurementSettings = {
  readonly binCount: number;
  readonly falseAlarmRate: number;
  readonly predictionSource: string;
};

export type ModelCard = {
  readonly modelVersion: string;
  readonly artifactChecksum: string;
  readonly dataVersion: string;
  readonly labelPolicyVersion: string;
  readonly blockRange: { readonly from: number; readonly to: number };
  readonly seed: number;
  readonly calibrationMethod: string;
  readonly measurementSettings: ModelCardMeasurementSettings;
  readonly evaluations: readonly ModelCardEvaluation[];
  readonly limitations: readonly string[];
};

export type ModelCardError = { kind: "invalid-model-card"; message: string };

function invalid(message: string): Result<never, ModelCardError> {
  return err({ kind: "invalid-model-card", message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isUnitNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isVersionString(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 64;
}

function parseClassMetrics(raw: unknown): ClassMetrics | null {
  if (!isRecord(raw)) {
    return null;
  }
  const count = raw["count"];
  const positives = raw["positives"];
  const negatives = raw["negatives"];
  if (!isCount(count) || !isCount(positives) || !isCount(negatives)) {
    return null;
  }
  if (positives + negatives !== count || count === 0) {
    return null;
  }
  for (const field of ["ece", "brier", "auroc", "prAuc", "precisionAtFar"] as const) {
    if (!isUnitNumber(raw[field])) {
      return null;
    }
  }
  const threshold = raw["thresholdAtFar"];
  const thresholdOk =
    threshold === null || (typeof threshold === "number" && (threshold >= 0 || threshold === Number.POSITIVE_INFINITY));
  if (!thresholdOk || (typeof threshold === "number" && Number.isNaN(threshold))) {
    return null;
  }
  const binsRaw = raw["bins"];
  if (!Array.isArray(binsRaw)) {
    return null;
  }
  for (const bin of binsRaw) {
    if (!isRecord(bin)) {
      return null;
    }
    if (!isCount(bin["index"]) || !isCount(bin["count"])) {
      return null;
    }
    for (const field of ["lower", "upper", "meanPredicted", "observedRate"] as const) {
      if (!isUnitNumber(bin[field])) {
        return null;
      }
    }
  }
  return {
    count,
    positives,
    negatives,
    ece: raw["ece"] as number,
    brier: raw["brier"] as number,
    auroc: raw["auroc"] as number,
    prAuc: raw["prAuc"] as number,
    precisionAtFar: raw["precisionAtFar"] as number,
    thresholdAtFar: threshold === null ? Number.POSITIVE_INFINITY : (threshold as number),
    bins: Object.freeze(
      binsRaw.map((bin) =>
        Object.freeze({
          index: (bin as Record<string, unknown>)["index"] as number,
          lower: (bin as Record<string, unknown>)["lower"] as number,
          upper: (bin as Record<string, unknown>)["upper"] as number,
          count: (bin as Record<string, unknown>)["count"] as number,
          meanPredicted: (bin as Record<string, unknown>)["meanPredicted"] as number,
          observedRate: (bin as Record<string, unknown>)["observedRate"] as number,
        }),
      ),
    ),
  };
}

function parseSplitMetrics(raw: unknown, binCount: number): SplitMetrics | null {
  if (!isRecord(raw)) {
    return null;
  }
  const keys = Object.keys(raw).sort();
  if (keys.length !== RISK_ORDER.length || keys.some((key, index) => key !== RISK_ORDER[index])) {
    return null;
  }
  const out = {} as Record<RiskType, ClassMetrics>;
  for (const risk of RISK_ORDER) {
    const parsed = parseClassMetrics(raw[risk]);
    if (parsed === null || parsed.bins.length !== binCount) {
      return null;
    }
    out[risk] = parsed;
  }
  return Object.freeze(out);
}

function parseEvaluation(raw: unknown, binCount: number): ModelCardEvaluation | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (!isVersionString(raw["method"]) || !isVersionString(raw["methodVersion"])) {
    return null;
  }
  if (ModelVersion.parse(raw["methodVersion"] as string).ok === false) {
    return null;
  }
  if (!isCount(raw["trainCount"]) || !isCount(raw["calibrationCount"]) || !isCount(raw["testCount"])) {
    return null;
  }
  const trainMetrics = parseSplitMetrics(raw["trainMetrics"], binCount);
  const testMetrics = parseSplitMetrics(raw["testMetrics"], binCount);
  if (trainMetrics === null || testMetrics === null) {
    return null;
  }
  return Object.freeze({
    method: raw["method"] as string,
    methodVersion: raw["methodVersion"] as string,
    trainCount: raw["trainCount"] as number,
    calibrationCount: raw["calibrationCount"] as number,
    testCount: raw["testCount"] as number,
    trainMetrics,
    testMetrics,
  });
}

// Boundary validation for the versioned model card (K-208, A-11, A-16):
// unknown JSON becomes a typed card or one typed error. A null
// thresholdAtFar in the file means no threshold under the false-alarm
// level (the empty operating point only) and restores as positive
// infinity, matching the metrics module convention.
export function createModelCard(input: unknown): Result<ModelCard, ModelCardError> {
  if (!isRecord(input)) {
    return invalid("model card must be a JSON object");
  }
  if (!isVersionString(input["modelVersion"]) || !ModelVersion.parse(input["modelVersion"]).ok) {
    return invalid("model card must carry a semver modelVersion");
  }
  if (typeof input["artifactChecksum"] !== "string" || !ArtifactChecksum.parse(input["artifactChecksum"]).ok) {
    return invalid("model card must carry a 64 hex character artifactChecksum");
  }
  if (!isVersionString(input["dataVersion"]) || !isVersionString(input["labelPolicyVersion"])) {
    return invalid("model card must carry a dataVersion and a labelPolicyVersion");
  }
  if (
    !isRecord(input["blockRange"]) ||
    !isCount(input["blockRange"]["from"]) ||
    !isCount(input["blockRange"]["to"]) ||
    (input["blockRange"]["from"] as number) > (input["blockRange"]["to"] as number)
  ) {
    return invalid("model card must carry a blockRange with from at or before to");
  }
  if (!isCount(input["seed"])) {
    return invalid("model card must carry an integer seed at least 0");
  }
  if (!isVersionString(input["calibrationMethod"])) {
    return invalid("model card must carry a calibrationMethod");
  }
  if (
    !isRecord(input["measurementSettings"]) ||
    !isCount(input["measurementSettings"]["binCount"]) ||
    (input["measurementSettings"]["binCount"] as number) < 1 ||
    typeof input["measurementSettings"]["falseAlarmRate"] !== "number" ||
    !Number.isFinite(input["measurementSettings"]["falseAlarmRate"] as number) ||
    (input["measurementSettings"]["falseAlarmRate"] as number) <= 0 ||
    (input["measurementSettings"]["falseAlarmRate"] as number) >= 1 ||
    !isVersionString(input["measurementSettings"]["predictionSource"])
  ) {
    return invalid("model card must carry measurementSettings with binCount, falseAlarmRate and predictionSource");
  }
  const binCount = input["measurementSettings"]["binCount"] as number;
  if (!Array.isArray(input["evaluations"]) || input["evaluations"].length === 0) {
    return invalid("model card must carry at least one evaluation");
  }
  const evaluations: ModelCardEvaluation[] = [];
  for (const entry of input["evaluations"]) {
    const parsed = parseEvaluation(entry, binCount);
    if (parsed === null) {
      return invalid("model card evaluations must carry method, methodVersion, counts and train and test metrics");
    }
    evaluations.push(parsed);
  }
  if (!Array.isArray(input["limitations"]) || input["limitations"].length === 0) {
    return invalid("model card must list at least one known limitation");
  }
  for (const limitation of input["limitations"]) {
    if (typeof limitation !== "string" || limitation.length < 1 || limitation.length > MAX_LIMITATION_CHARS) {
      return invalid("model card limitations must be non-empty strings");
    }
  }
  return ok(
    Object.freeze({
      modelVersion: input["modelVersion"] as string,
      artifactChecksum: input["artifactChecksum"] as string,
      dataVersion: input["dataVersion"] as string,
      labelPolicyVersion: input["labelPolicyVersion"] as string,
      blockRange: Object.freeze({
        from: input["blockRange"]["from"] as number,
        to: input["blockRange"]["to"] as number,
      }),
      seed: input["seed"] as number,
      calibrationMethod: input["calibrationMethod"] as string,
      measurementSettings: Object.freeze({
        binCount,
        falseAlarmRate: input["measurementSettings"]["falseAlarmRate"] as number,
        predictionSource: input["measurementSettings"]["predictionSource"] as string,
      }),
      evaluations: Object.freeze(evaluations),
      limitations: Object.freeze((input["limitations"] as string[]).slice()),
    }),
  );
}

function classMetricsToCanonical(metrics: ClassMetrics): CanonicalValue {
  return {
    auroc: metrics.auroc,
    bins: metrics.bins.map((bin) => ({
      count: bin.count,
      index: bin.index,
      lower: bin.lower,
      meanPredicted: bin.meanPredicted,
      observedRate: bin.observedRate,
      upper: bin.upper,
    })),
    brier: metrics.brier,
    count: metrics.count,
    ece: metrics.ece,
    negatives: metrics.negatives,
    positives: metrics.positives,
    prAuc: metrics.prAuc,
    precisionAtFar: metrics.precisionAtFar,
    thresholdAtFar: Number.isFinite(metrics.thresholdAtFar) ? metrics.thresholdAtFar : null,
  };
}

function splitMetricsToCanonical(metrics: SplitMetrics): CanonicalValue {
  const out: Record<string, CanonicalValue> = {};
  for (const risk of RISK_ORDER) {
    const entry = metrics[risk];
    if (entry !== undefined) {
      out[risk] = classMetricsToCanonical(entry);
    }
  }
  return out;
}

// Canonical card form for checksums and committed files (A-20, A-32 point
// 5): a fixed shape holding every card field, serialized with
// canonicalSerialize so key order stays out of the file bytes.
export function modelCardToCanonical(card: ModelCard): CanonicalValue {
  return {
    artifactChecksum: card.artifactChecksum,
    blockRange: { from: card.blockRange.from, to: card.blockRange.to },
    calibrationMethod: card.calibrationMethod,
    dataVersion: card.dataVersion,
    evaluations: card.evaluations.map((entry) => ({
      calibrationCount: entry.calibrationCount,
      method: entry.method,
      methodVersion: entry.methodVersion,
      testCount: entry.testCount,
      testMetrics: splitMetricsToCanonical(entry.testMetrics),
      trainCount: entry.trainCount,
      trainMetrics: splitMetricsToCanonical(entry.trainMetrics),
    })),
    labelPolicyVersion: card.labelPolicyVersion,
    limitations: card.limitations.slice(),
    measurementSettings: {
      binCount: card.measurementSettings.binCount,
      falseAlarmRate: card.measurementSettings.falseAlarmRate,
      predictionSource: card.measurementSettings.predictionSource,
    },
    modelVersion: card.modelVersion,
    seed: card.seed,
  };
}

// The whole file content for the committed card: canonical JSON with no
// trailing newline, so writing it verbatim reproduces these bytes.
export function serializeModelCard(card: ModelCard): string {
  return canonicalSerialize(modelCardToCanonical(card));
}
