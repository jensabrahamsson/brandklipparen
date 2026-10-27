// Offline evaluation: calibration and discrimination metrics with the
// model card (K-205, K-206, K-208, S-021). Run from the repo root with
// `npm run evaluate-metrics`: reads the frozen artifact in model/ and the
// synthetic labelled dataset in offline/data, builds the S-018 time-based
// and cluster-based splits through the pure domain pipeline, scores every
// datapoint with the artifact and writes the evaluation report and the
// model card. An optional output directory argument redirects both files
// (used by the offline recomputation test); the default is model/.
// Re-running with the same inputs reproduces both files byte for byte.
// The evaluation carries no network reads: file input plus the pure
// domain only. Production values arrive through the versioned offline
// calibration chain per A-28 and K-210.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyArtifactFile } from "../src/domain/artifact.ts";
import type { VerifiedArtifact } from "../src/domain/artifact.ts";
import { parseDataset } from "../src/domain/dataset.ts";
import type { Dataset, DatasetDataPoint } from "../src/domain/dataset.ts";
import { splitByCluster, splitByTime } from "../src/domain/splits.ts";
import type { DatasetSplit, SplitRatios } from "../src/domain/splits.ts";
import { score } from "../src/domain/risk.ts";
import { evaluatePredictions } from "../src/domain/metrics.ts";
import type { LabelledPrediction, MetricsOptions, SplitMetrics } from "../src/domain/metrics.ts";
import { createModelCard, modelCardToCanonical, serializeModelCard } from "../src/domain/modelCard.ts";
import { canonicalSerialize } from "../src/domain/serialize.ts";

// Locked version, inputs and measurement settings for the synthetic
// placeholder evaluation. The bin count and the false-alarm level steer
// measurement arithmetic only and are recorded in both outputs; they are
// not model values. The production false-alarm level arrives through the
// versioned artifact per K-206 and K-210.
const MODEL_VERSION = "0.0.0-synthetic.1";
const ARTIFACT_FILE = join("model", `artifact-${MODEL_VERSION}.json`);
const DATASET_FILE = join("offline", "data", "dataset-synthetic-v1.json");
const EVALUATION_FILE = `evaluation-${MODEL_VERSION}.json`;
const CARD_FILE = `model-card-${MODEL_VERSION}.json`;
const CALIBRATION_METHOD = "placeholder-identity-v1";
const PREDICTION_SOURCE = "baseline-from-artifact-biases-v1";
const BIN_COUNT = 10;
const FALSE_ALARM_RATE = 0.1;
const RATIOS: SplitRatios = Object.freeze({ trainRatio: 0.25, calibrationRatio: 0.25 });
const OPTIONS: MetricsOptions = Object.freeze({ binCount: BIN_COUNT, falseAlarmRate: FALSE_ALARM_RATE });

// Documented limits of the synthetic and placeholder calibration (K-208).
// Each entry is a plain-English statement that ships verbatim on the card;
// the row count is read from the dataset so the text stays exact when the
// fixture grows.
function limitationTexts(rowCount: number): readonly string[] {
  return Object.freeze([
    "Placeholder calibration: the artifact carries an identity calibrator with the slope fixed at one and the intercept at zero, so probabilities track the training biases only.",
    `Synthetic data: the evaluation runs on ${rowCount} hand-assembled rows with no link to real contracts and no predictive meaning.`,
    "Baseline predictions: every token receives the same bias-only probabilities, so ranking measures stay at their no-information values and calibration measures describe the placeholder only.",
    "Single-class split parts report AUROC 0.5 and, with no positives, PR-AUC 0; a null threshold means the empty operating point is the only one under the false-alarm level.",
  ]);
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function fail(message: string): never {
  process.stderr.write(`evaluate-metrics: ${message}\n`);
  process.exit(1);
}

function readJson(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(join(repoRoot, path), "utf8");
  } catch {
    fail(`cannot read ${path}`);
    throw new Error("unreachable");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    fail(`file ${path} is not valid JSON`);
    throw new Error("unreachable");
  }
}

// Baseline predictions from the frozen artifact (PREDICTION_SOURCE): the
// risk model scores each datapoint label with an empty signal list, so the
// stated probabilities come solely from the artifact biases with no
// per-token signal mapping. Deterministic and offline.
function predictionsFor(points: readonly DatasetDataPoint[], verified: VerifiedArtifact): LabelledPrediction[] {
  const baseline = score([], verified.artifact).probabilities;
  return points.map((point) =>
    Object.freeze({
      probabilities: Object.freeze({
        "bot-pump": baseline["bot-pump"] as number,
        honeypot: baseline["honeypot"] as number,
        "rug-pull": baseline["rug-pull"] as number,
      }),
      labels: Object.freeze({
        "bot-pump": point.label["bot-pump"],
        honeypot: point.label["honeypot"],
        "rug-pull": point.label["rug-pull"],
      }),
    }),
  );
}

function metricsFor(
  points: readonly DatasetDataPoint[],
  verified: VerifiedArtifact,
  split: string,
  part: string,
): SplitMetrics {
  const result = evaluatePredictions(predictionsFor(points, verified), OPTIONS);
  if (!result.ok) {
    fail(`metrics for the ${split} ${part} split failed: ${result.error.message}`);
    throw new Error("unreachable");
  }
  return result.value;
}

function splitOrFail(split: DatasetSplit | null, method: string): DatasetSplit {
  if (split === null) {
    fail(`no ${method} split`);
    throw new Error("unreachable");
  }
  return split;
}

const verifiedRaw = verifyArtifactFile(readJson(ARTIFACT_FILE));
if (!verifiedRaw.ok) {
  fail(`artifact verification failed: ${verifiedRaw.error.message}`);
  throw new Error("unreachable");
}
const verified: VerifiedArtifact = verifiedRaw.value;
if ((verified.artifact.version as string) !== MODEL_VERSION) {
  fail(`artifact version ${(verified.artifact.version as string)} differs from ${MODEL_VERSION}`);
}

const datasetRaw = parseDataset(readJson(DATASET_FILE));
if (!datasetRaw.ok) {
  fail(`dataset parsing failed: ${datasetRaw.error.message}`);
  throw new Error("unreachable");
}
const dataset: Dataset = datasetRaw.value;
if (dataset.dataVersion !== verified.dataVersion) {
  fail(`dataset version ${dataset.dataVersion} differs from artifact data version ${verified.dataVersion}`);
}

const timeResult = splitByTime(dataset, RATIOS);
if (!timeResult.ok) {
  fail(`time-based split failed: ${timeResult.error.message}`);
  throw new Error("unreachable");
}
const clusterResult = splitByCluster(dataset, RATIOS);
if (!clusterResult.ok) {
  fail(`cluster-based split failed: ${clusterResult.error.message}`);
  throw new Error("unreachable");
}
const timeSplit: DatasetSplit = splitOrFail(timeResult.value, "time-based");
const clusterSplit: DatasetSplit = splitOrFail(clusterResult.value, "cluster-based");

function evaluationFor(split: DatasetSplit): Record<string, unknown> {
  return {
    calibrationCount: split.calibration.datapoints.length,
    method: split.method,
    methodVersion: split.methodVersion,
    testCount: split.test.datapoints.length,
    testMetrics: metricsFor(split.test.datapoints, verified, split.method, "test"),
    trainCount: split.train.datapoints.length,
    trainMetrics: metricsFor(split.train.datapoints, verified, split.method, "train"),
  };
}

const evaluations = [evaluationFor(timeSplit), evaluationFor(clusterSplit)];

const cardResult = createModelCard({
  artifactChecksum: verified.checksum as string,
  blockRange: { from: dataset.blockRange.from, to: dataset.blockRange.to },
  calibrationMethod: CALIBRATION_METHOD,
  dataVersion: dataset.dataVersion,
  evaluations,
  labelPolicyVersion: dataset.labelPolicyVersion,
  limitations: limitationTexts(dataset.datapoints.length).slice(),
  measurementSettings: {
    binCount: BIN_COUNT,
    falseAlarmRate: FALSE_ALARM_RATE,
    predictionSource: PREDICTION_SOURCE,
  },
  modelVersion: MODEL_VERSION,
  seed: verified.seed,
});
if (!cardResult.ok) {
  fail(`model card validation failed: ${cardResult.error.message}`);
  throw new Error("unreachable");
}

const outDir = process.argv[2] === undefined ? join(repoRoot, "model") : String(process.argv[2]);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, CARD_FILE), serializeModelCard(cardResult.value), "utf8");
writeFileSync(
  join(outDir, EVALUATION_FILE),
  canonicalSerialize({ card: modelCardToCanonical(cardResult.value), splitRatios: { ...RATIOS } }),
  "utf8",
);
process.stdout.write(`evaluated ${MODEL_VERSION}: ${EVALUATION_FILE} and ${CARD_FILE}\n`);
