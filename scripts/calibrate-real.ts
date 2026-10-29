// Real calibration runner (offline, no network).
// Reads labeled calibration rows plus the 39-row holdout via env/flags
// only (never a repo path), dedupes by codehash (implementation-aware),
// splits stratified grouped 75/25, fits L2 logistic detector weights per
// head with sample weights by label strength, Platt-scales reliability,
// chooses band cutoffs on TRAIN and freezes model/artifact-<version>.json
// through the shared freeze path. Symbols only in stdout; no addresses,
// codehashes or bytecode leave this script.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Bytecode, CodeHash } from "../src/domain/types.ts";
import { dedupeCalibration } from "../src/domain/dedupe.ts";
import { splitStratifiedGrouped } from "../src/domain/stratifiedSplit.ts";
import { parseSampleWeights, sampleWeightOf } from "../src/domain/labelWeights.ts";
import { applyPlattScaling, fitCalibratedHead, fitWeightedLogistic } from "../src/domain/calibrationFit.ts";
import { DEFAULT_BAND_THRESHOLDS, bandOfScore, chooseBandThresholds } from "../src/domain/thresholds.ts";
import { freezeArtifactFile } from "../src/domain/artifact.ts";
import { loadOnchainSnapshotFile } from "../src/adapters/onchain/snapshotFile.ts";
import { holdoutRowsForScoring, joinOnchainSnapshot, rankAUC } from "../src/application/onchainCalibration.ts";
import { ONCHAIN_FEATURE_NAMES, ONCHAIN_FEATURE_VERSION, SERVABLE_FEATURE_NAMES, featureAvailable, indexSnapshotById, snapshotFeaturesOf } from "../src/domain/onchain/snapshot.ts";
import { applyOnchainScaler, fitOnchainScaler, scalerToJSON } from "../src/domain/onchain/scaler.ts";
import { ONCHAIN_RISK_DIRECTIONS, signConstraintOf } from "../src/domain/onchain/signs.ts";
import type { SnapshotFile, SnapshotRow } from "../src/domain/onchain/snapshot.ts";
import { parseModelArtifact } from "../src/domain/risk.ts";
import type { ModelArtifact } from "../src/domain/risk.ts";
import { score } from "../src/domain/risk.ts";
import { Signal } from "../src/domain/signals.ts";
import { ModelVersion } from "../src/domain/types.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function flagValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === `--${name}`) {
      return argv[index + 1];
    }
    if (arg !== undefined && arg.startsWith(`--${name}=`)) {
      return arg.slice(name.length + 3);
    }
  }
  return undefined;
}

function fail(message: string): never {
  process.stderr.write(`calibrate-real: ${message}\n`);
  process.exit(1);
}

type CalibrationRow = {
  address: string;
  symbol: string;
  label: string;
  labelBasis?: string | undefined;
  labelSource?: string | undefined;
  labelNote?: string | undefined;
  block: number;
  bytecode: string;
  implementation?: { address: string; bytecode: string } | undefined;
};

function readRows(path: string): CalibrationRow[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    fail(`cannot read ${path}`);
    throw new Error("unreachable");
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      fail(`file ${path} must hold a JSON array`);
    }
    return parsed as CalibrationRow[];
  } catch {
    fail(`file ${path} is not valid JSON`);
    throw new Error("unreachable");
  }
}

function effectiveBytecode(row: CalibrationRow): string {
  return row.implementation?.bytecode ?? row.bytecode;
}

function effectiveCodehash(row: CalibrationRow): string | null {
  const parsed = Bytecode.parse(effectiveBytecode(row));
  if (!parsed.ok) {
    return null;
  }
  const hash = CodeHash.of(parsed.value);
  return hash.ok ? (hash.value as string) : null;
}

const VERSION_TEXT = flagValue("version") ?? "1.0.0";
const version = ModelVersion.parse(VERSION_TEXT);
if (!version.ok) {
  fail(`invalid model version: ${VERSION_TEXT}`);
  throw new Error("unreachable");
}
const datasetPath = flagValue("dataset") ?? process.env["BK_CALIBRATION_DATASET"];
if (datasetPath === undefined) {
  fail("missing calibration dataset path: pass --dataset or BK_CALIBRATION_DATASET");
  throw new Error("unreachable");
}
const holdoutPath = flagValue("holdout") ?? process.env["BK_HOLDOUT_DATASET"];
if (holdoutPath === undefined) {
  fail("missing holdout path: pass --holdout or BK_HOLDOUT_DATASET");
  throw new Error("unreachable");
}
const outDir = flagValue("out-dir") ?? join(repoRoot, "model");
const seedText = flagValue("seed") ?? process.env["BK_CALIBRATION_SEED"] ?? "42";
const seed = Number.parseInt(seedText, 10);
if (!Number.isInteger(seed) || seed < 0) {
  fail(`invalid seed: ${seedText}`);
  throw new Error("unreachable");
}
const sampleWeightsRaw = flagValue("sample-weights") ?? process.env["BK_SAMPLE_WEIGHTS"];
let sampleWeightsInput: unknown;
if (sampleWeightsRaw !== undefined) {
  try {
    sampleWeightsInput = JSON.parse(sampleWeightsRaw) as unknown;
  } catch {
    fail("--sample-weights is not valid JSON");
    throw new Error("unreachable");
  }
}
const sampleWeightsParsed = parseSampleWeights(sampleWeightsInput);
if (!sampleWeightsParsed.ok) {
  fail(`invalid sample weights: ${sampleWeightsParsed.error.message}`);
  throw new Error("unreachable");
}
const sampleConfig = sampleWeightsParsed.value;
const dataVersion = flagValue("data-version") ?? "calibration-v1";

// Optional on-chain snapshot source (session B): a point-in-time snapshot
// file supplied by another team, never scraped here. Absent means the run
// stays bytecode-only with bit-identical behavior; present means the
// snapshot loads, validates and joins for diagnostics and ablation fits.
// The frozen artifact always carries the bytecode fit (score neutrality:
// no serving-time conversion consumes on-chain weights yet).
const onchainSnapshotPath = flagValue("onchain-snapshot") ?? process.env["BK_ONCHAIN_SNAPSHOT"];
const onchainModeRaw = flagValue("onchain-mode") ?? process.env["BK_ONCHAIN_MODE"] ?? (onchainSnapshotPath === undefined ? "bytecode" : "both");
if (onchainModeRaw !== "bytecode" && onchainModeRaw !== "onchain" && onchainModeRaw !== "both") {
  fail(`invalid onchain mode: ${onchainModeRaw} (expected bytecode, onchain or both)`);
  throw new Error("unreachable");
}
const onchainMode = onchainModeRaw;
if (onchainMode !== "bytecode" && onchainSnapshotPath === undefined) {
  fail("onchain mode needs a snapshot file: pass --onchain-snapshot or BK_ONCHAIN_SNAPSHOT");
  throw new Error("unreachable");
}
if (onchainMode === "bytecode" && onchainSnapshotPath !== undefined) {
  fail("a snapshot file is given but onchain mode is bytecode, which ignores it: drop the file or pick --onchain-mode onchain or both");
  throw new Error("unreachable");
}
const skipHoldout = process.argv.includes("--skip-holdout") || process.env["BK_SKIP_HOLDOUT"] === "1";
const extraSnapshotsRaw = flagValue("onchain-extra-snapshot") ?? process.env["BK_ONCHAIN_EXTRA_SNAPSHOTS"] ?? "";
const extraSnapshotPaths = extraSnapshotsRaw
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

const calibrationRows = readRows(datasetPath);
const holdoutRows = readRows(holdoutPath);
// Skip mode keeps the holdout file read for the overlap exclusion below
// only (so the seed-42 train/test split stays identical): every scoring,
// metric and band path gates on holdoutRowsForScoring, which yields no row
// when skipping, so no holdout score, AUC, Brier or band count is ever
// computed, printed or written in this run.

const holdoutHashes = new Set<string>();
for (const row of holdoutRows) {
  const hash = effectiveCodehash(row);
  if (hash !== null) {
    holdoutHashes.add(hash.toLowerCase());
  }
}

type DedupeInput = {
  codehash: string;
  label: string;
  labelBasis?: string | undefined;
  labelNote?: string | undefined;
  labelSource?: string | undefined;
  row: CalibrationRow;
};

const dedupeInputs: DedupeInput[] = [];
for (const row of calibrationRows) {
  const hash = effectiveCodehash(row);
  if (hash === null) {
    continue;
  }
  dedupeInputs.push({
    codehash: hash,
    label: row.label,
    labelBasis: row.labelBasis,
    labelNote: row.labelNote,
    labelSource: row.labelSource,
    row,
  });
}

const deduped = dedupeCalibration(
  dedupeInputs.map((entry) => ({
    codehash: entry.codehash,
    label: entry.label,
    labelBasis: entry.labelBasis,
    labelNote: entry.labelNote,
    labelSource: entry.labelSource,
  })),
  holdoutHashes,
);

// Map kept codehashes back to full rows (winner per hash by strength).
const keptHashes = new Set(deduped.kept.map((entry) => entry.codehash.toLowerCase()));
// Re-resolve winners deterministically: group kept candidates by hash and
// pick the strongest with the same rule as dedupeCalibration.
const byHash = new Map<string, CalibrationRow[]>();
for (const entry of dedupeInputs) {
  const hash = entry.codehash;
  if (!keptHashes.has(hash.toLowerCase())) {
    continue;
  }
  const group = byHash.get(hash.toLowerCase()) ?? [];
  group.push(entry.row);
  byHash.set(hash.toLowerCase(), group);
}
function rowStrength(row: CalibrationRow): number {
  if (row.label === "unknown") {
    return 0;
  }
  if ((row.labelSource ?? "").includes("Do not rug on me labeled_list.csv")) {
    return 1;
  }
  if (row.labelBasis === "token-list") {
    return 2;
  }
  let base = 3;
  if (row.labelBasis === "incident-report") {
    base = 4;
  }
  if ((row.labelNote ?? "").includes("Corroborated by")) {
    base = 5;
  }
  return base;
}
const finalRows: CalibrationRow[] = [];
for (const group of byHash.values()) {
  const ordered = [...group].sort((left, right) => rowStrength(right) - rowStrength(left));
  const winner = ordered[0];
  if (winner !== undefined) {
    finalRows.push(winner);
  }
}
finalRows.sort((left, right) => {
  const leftHash = effectiveCodehash(left) ?? "";
  const rightHash = effectiveCodehash(right) ?? "";
  return leftHash < rightHash ? -1 : leftHash > rightHash ? 1 : 0;
});

const fittedRows = finalRows.filter((row) => row.label !== "unknown");
const unknownRows = finalRows.filter((row) => row.label === "unknown");

const splitInput = fittedRows.map((row) => ({
  codehash: effectiveCodehash(row) ?? "",
  label: row.label,
  row,
}));
const split = splitStratifiedGrouped(splitInput, 0.75, seed);
const trainRows = split.train.map((entry) => entry.row);
const testRows = split.test.map((entry) => entry.row);

const { mintDetectorPlugin } = await import("../src/plugins/detectors/mint/index.ts");
const { blacklistDetectorPlugin } = await import("../src/plugins/detectors/blacklist/index.ts");
const { transferFeeDetectorPlugin } = await import("../src/plugins/detectors/transfer-fee/index.ts");
const { pauseDetectorPlugin } = await import("../src/plugins/detectors/pause/index.ts");
const { transferLimitsDetectorPlugin } = await import("../src/plugins/detectors/transfer-limits/index.ts");
const { ownershipDetectorPlugin } = await import("../src/plugins/detectors/ownership/index.ts");
const { transferHooksDetectorPlugin } = await import("../src/plugins/detectors/transfer-hooks/index.ts");
const { sellBlockDetectorPlugin } = await import("../src/plugins/detectors/sell-block/index.ts");
const { proxyUpgradeDetectorPlugin } = await import("../src/plugins/detectors/proxy-upgrade/index.ts");

const FEATURE_PLUGINS = [
  { name: "mint", plugin: mintDetectorPlugin },
  { name: "blacklist", plugin: blacklistDetectorPlugin },
  { name: "transfer-fee", plugin: transferFeeDetectorPlugin },
  { name: "pause", plugin: pauseDetectorPlugin },
  { name: "transfer-limits", plugin: transferLimitsDetectorPlugin },
  { name: "ownership", plugin: ownershipDetectorPlugin },
  { name: "transfer-hooks", plugin: transferHooksDetectorPlugin },
  { name: "sell-block", plugin: sellBlockDetectorPlugin },
  { name: "proxy-upgrade", plugin: proxyUpgradeDetectorPlugin },
] as const;

function round6(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}

function detectorFeatures(row: CalibrationRow): number[] {
  const parsed = Bytecode.parse(effectiveBytecode(row));
  if (!parsed.ok) {
    return FEATURE_PLUGINS.map(() => 0);
  }
  const bytecode = parsed.value;
  const hash = CodeHash.of(bytecode);
  if (!hash.ok) {
    return FEATURE_PLUGINS.map(() => 0);
  }
  const input = Object.freeze({ bytecode, codeHash: hash.value });
  return FEATURE_PLUGINS.map(({ plugin }) => {
    try {
      return plugin.detect(input).length > 0 ? 1 : 0;
    } catch {
      return 0;
    }
  });
}

function rugPullLabel(row: CalibrationRow): 0 | 1 {
  return row.label === "rug" || row.label === "scam" ? 1 : 0;
}

function honeypotLabel(row: CalibrationRow): 0 | 1 {
  return row.label === "honeypot" ? 1 : 0;
}

function badLabel(row: CalibrationRow): 0 | 1 {
  return row.label === "rug" || row.label === "scam" || row.label === "honeypot" ? 1 : 0;
}

const trainFeatures = trainRows.map(detectorFeatures);
const trainWeights = trainRows.map((row) =>
  sampleWeightOf(
    { label: row.label, labelBasis: row.labelBasis, labelSource: row.labelSource, labelNote: row.labelNote },
    sampleConfig,
  ),
);
const trainRugLabels = trainRows.map(rugPullLabel);
const trainHoneyLabels = trainRows.map(honeypotLabel);
const trainBadLabels = trainRows.map(badLabel);

const LAMBDA = 0.1;
const ITERATIONS = 500;
const STEP = 0.5;
// Every owner-control detector documents risk-increasing semantics, so
// every per-head weight constrains to at least 0 on both heads.
const NON_NEGATIVE = FEATURE_PLUGINS.map(() => true);

const priorArtifactRaw = JSON.parse(readFileSync(join(repoRoot, "model", "artifact-0.1.0-prior.1.json"), "utf8")) as {
  artifact: Record<string, unknown>;
};
const priorArtifactParsed = parseModelArtifact(priorArtifactRaw.artifact);
if (!priorArtifactParsed.ok) {
  fail(`prior artifact failed validation: ${priorArtifactParsed.error.message}`);
  throw new Error("unreachable");
}
const priorArtifact = priorArtifactParsed.value;

// Per-head fits over the nine binary detector features: constrained L2
// logistic regression on TRAIN with sample weights, then a monotone
// (slope at least 0) Platt map per head. A head with no positives, or
// with no monotone signal, keeps the prior mapping and is marked
// uncalibrated instead of shipping an inverted map.
const rugHead = fitCalibratedHead(
  trainFeatures,
  trainRugLabels,
  trainWeights,
  LAMBDA,
  {
    bias: priorArtifact.biases["rug-pull"] ?? 0,
    slope: priorArtifact.calibration["rug-pull"]?.slope ?? 1,
    intercept: priorArtifact.calibration["rug-pull"]?.intercept ?? 0,
  },
  NON_NEGATIVE,
  ITERATIONS,
  STEP,
);
const honeyHead = fitCalibratedHead(
  trainFeatures,
  trainHoneyLabels,
  trainWeights,
  LAMBDA,
  {
    bias: priorArtifact.biases["honeypot"] ?? 0,
    slope: priorArtifact.calibration["honeypot"]?.slope ?? 1,
    intercept: priorArtifact.calibration["honeypot"]?.intercept ?? 0,
  },
  NON_NEGATIVE,
  ITERATIONS,
  STEP,
);

// Unconstrained diagnostics for the projection report: columns the
// non-negative constraint pins at 0 while the free fit wants them
// negative are documented as projected, since no negative weight is
// principled for these risk-increasing detectors.
const rugFree = fitWeightedLogistic(trainFeatures, trainRugLabels, trainWeights, LAMBDA, ITERATIONS, STEP);
const honeyFree = fitWeightedLogistic(trainFeatures, trainHoneyLabels, trainWeights, LAMBDA, ITERATIONS, STEP);
const projectedToZero = FEATURE_PLUGINS.filter((_, index) => {
  const rugPinned = (rugHead.weights[index] ?? 0) === 0 && (rugFree.weights[index] ?? 0) < -1e-9;
  const honeyPinned = (honeyHead.weights[index] ?? 0) === 0 && (honeyFree.weights[index] ?? 0) < -1e-9;
  return rugPinned || honeyPinned;
}).map(({ name }) => name);

function headProbability(features: readonly number[], head: { readonly weights: readonly number[]; readonly bias: number; readonly slope: number; readonly intercept: number }): number {
  let raw = head.bias;
  for (let index = 0; index < head.weights.length; index += 1) {
    raw += (head.weights[index] ?? 0) * (features[index] ?? 0);
  }
  return applyPlattScaling(raw, head);
}

function badProbability(features: readonly number[]): number {
  return Math.max(headProbability(features, rugHead), headProbability(features, honeyHead));
}

const trainRugProbs = trainFeatures.map((features) => headProbability(features, rugHead));
const trainHoneyProbs = trainFeatures.map((features) => headProbability(features, honeyHead));
const trainBadProbs = trainFeatures.map(badProbability);

// TRAIN ablation importance: drop one detector column, refit both heads
// with the same constrained setup, and report the TRAIN bad-AUC delta.
function trainBadAucFor(matrix: readonly (readonly number[])[]): number {
  const rug = fitCalibratedHead(matrix, trainRugLabels, trainWeights, LAMBDA, {
    bias: priorArtifact.biases["rug-pull"] ?? 0,
    slope: priorArtifact.calibration["rug-pull"]?.slope ?? 1,
    intercept: priorArtifact.calibration["rug-pull"]?.intercept ?? 0,
  }, NON_NEGATIVE, ITERATIONS, STEP);
  const honey = fitCalibratedHead(matrix, trainHoneyLabels, trainWeights, LAMBDA, {
    bias: priorArtifact.biases["honeypot"] ?? 0,
    slope: priorArtifact.calibration["honeypot"]?.slope ?? 1,
    intercept: priorArtifact.calibration["honeypot"]?.intercept ?? 0,
  }, NON_NEGATIVE, ITERATIONS, STEP);
  const probs = matrix.map((features) => {
    let rugRaw = rug.bias;
    let honeyRaw = honey.bias;
    for (let index = 0; index < features.length; index += 1) {
      rugRaw += (rug.weights[index] ?? 0) * (features[index] ?? 0);
      honeyRaw += (honey.weights[index] ?? 0) * (features[index] ?? 0);
    }
    return Math.max(applyPlattScaling(rugRaw, rug), applyPlattScaling(honeyRaw, honey));
  });
  return aucRank(probs, trainBadLabels);
}

// Co-firing (Jaccard) over TRAIN rows: 1 means identical row sets, 0
// means disjoint. Both-empty pairs define 1.
function jaccardMatrix(matrix: readonly (readonly number[])[]): number[][] {
  const width = matrix[0]?.length ?? 0;
  const out: number[][] = [];
  for (let left = 0; left < width; left += 1) {
    const row: number[] = [];
    for (let right = 0; right < width; right += 1) {
      let both = 0;
      let either = 0;
      for (const features of matrix) {
        const leftOn = (features[left] ?? 0) === 1;
        const rightOn = (features[right] ?? 0) === 1;
        if (leftOn && rightOn) {
          both += 1;
        }
        if (leftOn || rightOn) {
          either += 1;
        }
      }
      row.push(either === 0 ? 1 : both / either);
    }
    out.push(row);
  }
  return out;
}

const detectorHeadWeights: Record<string, { "rug-pull": number; honeypot: number }> = {};
FEATURE_PLUGINS.forEach(({ name }, index) => {
  detectorHeadWeights[`dev.brandklipparen.${name}`] = {
    "rug-pull": round6(rugHead.weights[index] ?? 0),
    honeypot: round6(honeyHead.weights[index] ?? 0),
  };
});

// Scoring gate: every fitted detector stays allowed. Magnitudes live in
// detectorHeadWeights; these entries only open the gate.
const pluginWeights: Record<string, number> = {};
for (const { name } of FEATURE_PLUGINS) {
  pluginWeights[`dev.brandklipparen.${name}`] = 1;
}

const uncalibratedHeads: ("rug-pull" | "honeypot" | "bot-pump")[] = ["bot-pump"];
if (rugHead.uncalibrated) {
  uncalibratedHeads.push("rug-pull");
}
if (honeyHead.uncalibrated) {
  uncalibratedHeads.push("honeypot");
}

const artifactJson: Record<string, unknown> = {
  biases: {
    "rug-pull": round6(rugHead.bias),
    honeypot: round6(honeyHead.bias),
    "bot-pump": priorArtifact.biases["bot-pump"],
  },
  calibration: {
    "rug-pull": { slope: rugHead.slope, intercept: rugHead.intercept },
    honeypot: { slope: honeyHead.slope, intercept: honeyHead.intercept },
    "bot-pump": priorArtifact.calibration["bot-pump"],
  },
  causeWeights: priorArtifact.causeWeights,
  scoreWeights: priorArtifact.scoreWeights,
  severityWeights: priorArtifact.severityWeights,
  version: VERSION_TEXT,
  pluginWeights,
  pluginFeatureCatalogue: priorArtifact.pluginFeatureCatalogue,
  detectorHeadWeights,
  uncalibratedHeads,
};

const parsed = parseModelArtifact(artifactJson);
if (!parsed.ok) {
  fail(`fitted artifact failed validation: ${parsed.error.message}`);
  throw new Error("unreachable");
}

const frozen = freezeArtifactFile({
  artifact: parsed.value,
  dataVersion,
  seed,
});
if (!frozen.ok) {
  fail(`freeze failed: ${frozen.error.message}`);
  throw new Error("unreachable");
}
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `artifact-${VERSION_TEXT}.json`), frozen.value, "utf8");

// Score one row with the fitted artifact through the real scoring path.
import { Address as AddressValue } from "../src/domain/types.ts";
const CHANGER = (() => {
  const parsed = AddressValue.parse("0x0102030405060708090a0b0c0d0e0f1011121314");
  if (!parsed.ok) {
    throw new Error("synthetic changer must parse");
  }
  return parsed.value;
})();

function resultForRow(row: CalibrationRow, artifact: ModelArtifact): ReturnType<typeof score> {
  const parsedCode = Bytecode.parse(effectiveBytecode(row));
  if (!parsedCode.ok) {
    return score([], artifact);
  }
  const code = parsedCode.value;
  const hash = CodeHash.of(code);
  if (!hash.ok) {
    return score([], artifact);
  }
  const input = Object.freeze({ bytecode: code, codeHash: hash.value });
  const signals: Parameters<typeof score>[0] = [];
  for (const { name, plugin } of FEATURE_PLUGINS) {
    let findings: readonly { evidence: readonly never[] }[] = [];
    try {
      findings = plugin.detect(input) as unknown as typeof findings;
    } catch {
      continue;
    }
    if (findings.length === 0) {
      continue;
    }
    const mapping = (artifact.pluginFeatureCatalogue as Record<string, { risk: "rug-pull" | "honeypot" | "bot-pump"; direction: "raises" | "lowers"; severity: "low" | "medium" | "high" }>)[
      `dev.brandklipparen.${name}`
    ];
    if (mapping === undefined) {
      continue;
    }
    for (const finding of findings) {
      const evidence = (finding as unknown as { evidence: Parameters<typeof Signal.createCapability>[0]["evidence"] }).evidence;
      const created = Signal.createCapability({
        codeHash: hash.value,
        risk: mapping.risk,
        direction: mapping.direction,
        severity: mapping.severity,
        temporality: { kind: "can-change", changer: CHANGER },
        evidence,
        sourcePlugin: `dev.brandklipparen.${name}`,
      });
      if (created.ok) {
        (signals as unknown[]).push(created.value);
      }
    }
  }
  return score(signals, artifact);
}

const trainScored = trainRows.map((row) => ({ row, result: resultForRow(row, parsed.value) }));
const trainBandInput = trainScored.map(({ row, result }) => ({ score: result.score as number, bad: badLabel(row) === 1 }));
const chosenBands = chooseBandThresholds(trainBandInput, 0.8, 0.8);

const withBandsJson: Record<string, unknown> = { ...(artifactJson as Record<string, unknown>), scoreBands: chosenBands };
const withBandsParsed = parseModelArtifact(withBandsJson);
if (!withBandsParsed.ok) {
  fail(`artifact with bands failed validation: ${withBandsParsed.error.message}`);
  throw new Error("unreachable");
}
const fittedArtifact: ModelArtifact = withBandsParsed.value;
const withBandsFrozen = freezeArtifactFile({ artifact: fittedArtifact, dataVersion, seed });
if (!withBandsFrozen.ok) {
  fail(`freeze with bands failed: ${withBandsFrozen.error.message}`);
  throw new Error("unreachable");
}
writeFileSync(join(outDir, `artifact-${VERSION_TEXT}.json`), withBandsFrozen.value, "utf8");

function summarize(rows: CalibrationRow[]): {
  count: number;
  bands: Record<string, number>;
  fittedBands: Record<string, number>;
  scores: number[];
  badProbs: number[];
  rugProbs: number[];
  honeyProbs: number[];
} {
  const bands: Record<string, number> = { Low: 0, Elevated: 0, High: 0 };
  const fittedBands: Record<string, number> = { Low: 0, Elevated: 0, High: 0 };
  const scores: number[] = [];
  const badProbs: number[] = [];
  const rugProbs: number[] = [];
  const honeyProbs: number[] = [];
  for (const row of rows) {
    const result = resultForRow(row, fittedArtifact);
    const scoreValue = result.score as number;
    scores.push(scoreValue);
    const band = bandOfScore(scoreValue, DEFAULT_BAND_THRESHOLDS);
    bands[band] = (bands[band] ?? 0) + 1;
    const fitted = bandOfScore(scoreValue, chosenBands);
    fittedBands[fitted] = (fittedBands[fitted] ?? 0) + 1;
    const rug = result.probabilities["rug-pull"] as number;
    const honey = result.probabilities["honeypot"] as number;
    rugProbs.push(rug);
    honeyProbs.push(honey);
    badProbs.push(Math.max(rug, honey));
  }
  return { count: rows.length, bands, fittedBands, scores, badProbs, rugProbs, honeyProbs };
}

// Deterministic bootstrap 95 percent interval for an AUC: resamples the
// scored rows with replacement through a seeded LCG (no Math.random), so
// equal inputs give bit-identical bounds on every run.
function makeLcg(start: number): () => number {
  let state = start >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function bootstrapAucCI(
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

function aucRank(scores: number[], labels: (0 | 1)[]): number {
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

function brier(probs: number[], labels: (0 | 1)[]): number {
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

const testSummary = summarize(testRows);
const testBadLabels = testRows.map(badLabel);
const testRugLabels = testRows.map(rugPullLabel);
const testHoneyLabels = testRows.map(honeypotLabel);
// Gated: in skip mode no holdout row reaches scoring or metrics.
const holdoutForScoring = holdoutRowsForScoring(skipHoldout, holdoutRows);
const holdoutSummary = skipHoldout ? null : summarize(holdoutForScoring);
const holdoutBadLabels = holdoutForScoring.map(badLabel);
const unknownSummary = summarize(unknownRows);

const testFeatures = testRows.map(detectorFeatures);
const holdoutFeatures = holdoutForScoring.map(detectorFeatures);
const featureNames = FEATURE_PLUGINS.map(({ name }) => name);

// TRAIN ablation importance on the fitted path: the TRAIN bad-AUC delta
// when one detector column drops out and both heads refit.
const fullTrainBadAuc = aucRank(trainBadProbs, trainBadLabels);
const ablation: Record<string, number> = {};
featureNames.forEach((name, index) => {
  const dropped = trainFeatures.map((features) =>
    features.map((value, col) => (col === index ? 0 : value)),
  );
  ablation[name] = round6(fullTrainBadAuc - trainBadAucFor(dropped));
});

const trainAuc = {
  bad: round6(fullTrainBadAuc),
  rug: round6(aucRank(trainRugProbs, trainRugLabels)),
  honey: round6(aucRank(trainHoneyProbs, trainHoneyLabels)),
};

const testBadAuc = aucRank(testSummary.badProbs, testBadLabels);
const testBadAucCI = bootstrapAucCI(testSummary.badProbs, testBadLabels, 1000, seed + 1);
const cofire = jaccardMatrix(trainFeatures);

const appliedHigh = DEFAULT_BAND_THRESHOLDS.high;
const appliedElevated = DEFAULT_BAND_THRESHOLDS.elevated;
// On-chain snapshot ablation (onchain-v3 mapping): when a snapshot file is
// given, join it to train, test and holdout rows by token id and fit the
// onchain and combined arms beside the bytecode production fit. The
// production fit above (rugHead/honeyHead, detectorHeadWeights, the frozen
// artifact) never sees snapshot columns: these fits are diagnostics,
// reported here with coverage, univariate AUCs, era checks and leakage
// probes, so the scores cannot change until a serving-time conversion
// exists. Only SERVABLE_FEATURE_NAMES columns (live computation matches
// the snapshot definition) enter the arms; the rest are diagnostic-only.
// Continuous on-chain columns are standardized with TRAIN-only params
// (binaries pass through; missing maps to zero contribution). Risk
// directions come from the documented domain table in
// src/domain/onchain/signs.ts, never from test. Regularization per arm
// comes from grouped cross-validation inside TRAIN only (grouped by
// codehash); test is never tuned on. With --skip-holdout the holdout rows
// feed the overlap exclusion only and are never scored; otherwise the
// holdout is evaluated exactly once, after the fits are frozen.
let onchainReport: Record<string, unknown> | null = null;
if (onchainSnapshotPath !== undefined) {
  const loaded = loadOnchainSnapshotFile(onchainSnapshotPath);
  if (!loaded.ok) {
    fail(`cannot load onchain snapshot: ${loaded.error.message}`);
    throw new Error("unreachable");
  }
  const snapshot: SnapshotFile = loaded.value;
  const trainJoin = joinOnchainSnapshot(trainRows, snapshot);
  const testJoin = joinOnchainSnapshot(testRows, snapshot);
  const holdoutJoin = skipHoldout ? null : joinOnchainSnapshot(holdoutForScoring, snapshot);
  const unknownJoin = joinOnchainSnapshot(unknownRows, snapshot);
  const { byId: snapshotById } = indexSnapshotById(snapshot);
  const servableIndex = SERVABLE_FEATURE_NAMES.map((name) => ONCHAIN_FEATURE_NAMES.indexOf(name));
  const pickServable = (matrix: readonly (readonly number[])[]): number[][] =>
    matrix.map((row) => servableIndex.map((col) => row[col] ?? 0));
  const trainOnchainRaw = pickServable(trainJoin.matrix);
  const testOnchainRaw = pickServable(testJoin.matrix);
  const holdoutOnchainRaw = holdoutJoin === null ? [] : pickServable(holdoutJoin.matrix);
  // Standardization (issue 1): LP shares are continuous and standardized
  // with TRAIN-only mean/sd over the available subset; owner flags and the
  // drained flag are binary and pass through untouched.
  const CONTINUOUS_SERVABLE = ["lp_burned_share", "lp_locker_share", "lp_deployer_or_owner_share"];
  const BINARY_SERVABLE = ["owner_renounced", "owner_eoa", "owner_contract", "owner_safe", "liquidity_removed_24h"];
  for (const name of SERVABLE_FEATURE_NAMES) {
    const binary = BINARY_SERVABLE.includes(name);
    const continuous = CONTINUOUS_SERVABLE.includes(name);
    if (binary === continuous) {
      fail(`servable feature ${name} must be exactly binary or continuous for scaling`);
      throw new Error("unreachable");
    }
  }
  const availabilityOf = (rows: CalibrationRow[]): boolean[][] =>
    rows.map((row) =>
      SERVABLE_FEATURE_NAMES.map((feature) => featureAvailable(snapshotById.get(row.address.toLowerCase()) ?? null, feature)),
    );
  const trainAvail = availabilityOf(trainRows);
  const testAvail = availabilityOf(testRows);
  const holdoutAvail = holdoutJoin === null ? [] : availabilityOf(holdoutForScoring);
  const onchainScaler = fitOnchainScaler(
    [...SERVABLE_FEATURE_NAMES],
    (name) => CONTINUOUS_SERVABLE.includes(name),
    trainOnchainRaw,
    trainAvail,
  );
  const trainOnchain = trainOnchainRaw.map((row, index) => [...applyOnchainScaler(row, trainAvail[index] ?? [], onchainScaler)]);
  const testOnchain = testOnchainRaw.map((row, index) => [...applyOnchainScaler(row, testAvail[index] ?? [], onchainScaler)]);
  const holdoutOnchain =
    holdoutJoin === null
      ? []
      : holdoutOnchainRaw.map((row, index) => [...applyOnchainScaler(row, holdoutAvail[index] ?? [], onchainScaler)]);
  const withOnchain = (
    base: readonly (readonly number[])[],
    extra: readonly (readonly number[])[],
  ): number[][] => base.map((row, index) => [...row, ...(extra[index] ?? [])]);
  const trainBoth = withOnchain(trainFeatures, trainOnchain);
  const testBoth = withOnchain(testFeatures, testOnchain);
  const holdoutBoth = holdoutJoin === null ? [] : withOnchain(holdoutFeatures, holdoutOnchain);
  // Risk directions from the documented domain table (issue 2): every
  // servable feature must map to a fittable pos/neg constraint, never a
  // test-picked sign; excluded features never reach a fit.
  const servableConstraints = SERVABLE_FEATURE_NAMES.map((name) => ({ name, constraint: signConstraintOf(name) }));
  for (const entry of servableConstraints) {
    if (entry.constraint !== "pos" && entry.constraint !== "neg") {
      fail(`servable feature ${entry.name} has no fittable risk direction (${entry.constraint})`);
      throw new Error("unreachable");
    }
  }
  const servableNonNegative = servableConstraints.map((entry) => entry.constraint === "pos");
  const servableNonPositive = servableConstraints.map((entry) => entry.constraint === "neg");
  const bothNonNegative = [...NON_NEGATIVE, ...servableNonNegative];
  const bothNonPositive = [...NON_NEGATIVE.map(() => false), ...servableNonPositive];
  const headPrior = (head: "rug-pull" | "honeypot") => ({
    bias: priorArtifact.biases[head] ?? 0,
    slope: priorArtifact.calibration[head]?.slope ?? 1,
    intercept: priorArtifact.calibration[head]?.intercept ?? 0,
  });
  // Grouped cross-validation inside TRAIN only (codehash groups, 3 folds):
  // mean bad-AUC over folds picks the lambda per arm; ties keep the larger
  // (simpler) lambda. Test and holdout never steer the choice.
  const trainCodehashes = trainRows.map((row) => effectiveCodehash(row) ?? "");
  const LAMBDA_GRID = [0.01, 0.1, 1];
  const chooseLambda = (
    matrix: readonly (readonly number[])[],
    nonNegative: readonly boolean[],
    nonPositive: readonly boolean[],
  ): number => {
    const folds: number[][] = [[], [], []];
    const order = matrix.map((_, index) => index).sort((left, right) => {
      const a = trainCodehashes[left] ?? "";
      const b = trainCodehashes[right] ?? "";
      return a < b ? -1 : a > b ? 1 : left - right;
    });
    order.forEach((rowIndex, position) => {
      folds[position % 3]?.push(rowIndex);
    });
    let best = LAMBDA_GRID[LAMBDA_GRID.length - 1] ?? 0.1;
    let bestScore = -1;
    for (const lambda of LAMBDA_GRID) {
      const foldScores: number[] = [];
      for (let held = 0; held < 3; held += 1) {
        const fitIdx: number[] = [];
        for (let fold = 0; fold < 3; fold += 1) {
          if (fold !== held) {
            fitIdx.push(...(folds[fold] ?? []));
          }
        }
        const heldIdx = folds[held] ?? [];
        const fitMatrix = fitIdx.map((index) => matrix[index] ?? []);
        const fitRugLabels = fitIdx.map((index) => trainRugLabels[index] ?? 0);
        const fitHoneyLabels = fitIdx.map((index) => trainHoneyLabels[index] ?? 0);
        const fitWeights = fitIdx.map((index) => trainWeights[index] ?? 0);
        const rug = fitCalibratedHead(fitMatrix, fitRugLabels, fitWeights, lambda, headPrior("rug-pull"), nonNegative, ITERATIONS, STEP, nonPositive);
        const honey = fitCalibratedHead(fitMatrix, fitHoneyLabels, fitWeights, lambda, headPrior("honeypot"), nonNegative, ITERATIONS, STEP, nonPositive);
        const heldMatrix = heldIdx.map((index) => matrix[index] ?? []);
        const heldBad = heldIdx.map((index) => trainBadLabels[index] ?? 0);
        const probs = heldMatrix.map((features) => Math.max(headProbability(features, rug), headProbability(features, honey)));
        foldScores.push(aucRank(probs, heldBad));
      }
      const mean = foldScores.reduce((total, value) => total + value, 0) / Math.max(1, foldScores.length);
      if (mean > bestScore + 1e-9 || (Math.abs(mean - bestScore) <= 1e-9 && lambda > best)) {
        bestScore = mean;
        best = lambda;
      }
    }
    return best;
  };
  const fitArm = (
    matrix: readonly (readonly number[])[],
    nonNegative: readonly boolean[],
    nonPositive: readonly boolean[],
    lambda: number,
  ) => ({
    rug: fitCalibratedHead(matrix, trainRugLabels, trainWeights, lambda, headPrior("rug-pull"), nonNegative, ITERATIONS, STEP, nonPositive),
    honey: fitCalibratedHead(matrix, trainHoneyLabels, trainWeights, lambda, headPrior("honeypot"), nonNegative, ITERATIONS, STEP, nonPositive),
    lambda,
  });
  const badProbsOf = (
    matrix: readonly (readonly number[])[],
    arm: { readonly rug: { readonly weights: readonly number[]; readonly bias: number; readonly slope: number; readonly intercept: number }; readonly honey: { readonly weights: readonly number[]; readonly bias: number; readonly slope: number; readonly intercept: number } },
  ): number[] => matrix.map((features) => Math.max(headProbability(features, arm.rug), headProbability(features, arm.honey)));
  const bytecodeLambda = LAMBDA;
  const onchainLambda = chooseLambda(trainOnchain, servableNonNegative, servableNonPositive);
  const bothLambda = chooseLambda(trainBoth, bothNonNegative, bothNonPositive);
  const bytecodeArm = {
    rug: rugHead,
    honey: honeyHead,
    lambda: bytecodeLambda,
  };
  const onchainArm = fitArm(trainOnchain, servableNonNegative, servableNonPositive, onchainLambda);
  const bothArm = fitArm(trainBoth, bothNonNegative, bothNonPositive, bothLambda);
  // Diagnostic band mapping for research arms (prob*100 through the
  // applied bands): the arms output probabilities, not fitted scores, so
  // this distribution is labelled diagnostic, never a product band.
  const bandDistOf = (probs: readonly number[]) => {
    const dist: Record<string, number> = { Low: 0, Elevated: 0, High: 0 };
    for (const prob of probs) {
      const band = bandOfScore((prob ?? 0) * 100, DEFAULT_BAND_THRESHOLDS);
      dist[band] = (dist[band] ?? 0) + 1;
    }
    return { ...dist, note: "diagnostic prob*100 mapping, not a fitted score" };
  };
  const armMetrics = (
    arm: { readonly rug: { readonly uncalibrated: boolean }; readonly honey: { readonly uncalibrated: boolean }; readonly lambda: number } & Parameters<typeof badProbsOf>[1],
    trainMatrix: readonly (readonly number[])[],
    testMatrix: readonly (readonly number[])[],
    holdoutMatrix: readonly (readonly number[])[] | null,
    testLabels: (0 | 1)[],
    holdoutLabels: (0 | 1)[],
  ) => {
    const trainProbs = badProbsOf(trainMatrix, arm);
    const testProbs = badProbsOf(testMatrix, arm);
    // In skip mode the holdout keys are omitted entirely: no holdout AUC,
    // Brier or band value is computed, printed or written anywhere.
    const holdoutPart =
      holdoutMatrix === null
        ? {}
        : {
            holdoutBadAuc: round6(aucRank(badProbsOf(holdoutMatrix, arm), holdoutLabels)),
            holdoutBadBrier: round6(brier(badProbsOf(holdoutMatrix, arm), holdoutLabels)),
          };
    return {
      lambda: arm.lambda,
      trainBadAuc: round6(aucRank(trainProbs, trainBadLabels)),
      testBadAuc: round6(aucRank(testProbs, testLabels)),
      testBadAucCI: bootstrapAucCI(testProbs, testLabels, 1000, seed + 1),
      testBadBrier: round6(brier(testProbs, testLabels)),
      testBandDist: bandDistOf(testProbs),
      ...holdoutPart,
      scoreSpread: spreadOf(testProbs),
      rugUncalibrated: arm.rug.uncalibrated,
      honeyUncalibrated: arm.honey.uncalibrated,
    };
  };
  const eraOf = (blocks: readonly (number | null)[], labels: (0 | 1)[]) => {
    const scores: number[] = [];
    const kept: (0 | 1)[] = [];
    let excluded = 0;
    blocks.forEach((block, index) => {
      if (block === null) {
        excluded += 1;
      } else {
        scores.push(block);
        kept.push(labels[index] ?? 0);
      }
    });
    return { auc: round6(rankAUC(scores, kept)), rows: scores.length, excluded };
  };
  // Per-class score distribution (aggregate only, never per-token):
  // min/nearest-rank quartiles/max plus the saturation shares above 0.99
  // and below 0.01 (issue 5).
  const spreadOf = (probs: readonly number[]): {
    count: number;
    mean: number;
    min: number;
    p25: number;
    p50: number;
    p75: number;
    max: number;
    shareAbove099: number;
    shareBelow001: number;
  } => {
    if (probs.length === 0) {
      return { count: 0, mean: 0, min: 0, p25: 0, p50: 0, p75: 0, max: 0, shareAbove099: 0, shareBelow001: 0 };
    }
    const ordered = [...probs].sort((left, right) => left - right);
    const quantile = (rank: number): number => ordered[Math.min(ordered.length - 1, Math.floor(rank * ordered.length))] ?? 0;
    let total = 0;
    let above = 0;
    let below = 0;
    for (const prob of probs) {
      total += prob;
      if (prob > 0.99) {
        above += 1;
      }
      if (prob < 0.01) {
        below += 1;
      }
    }
    return {
      count: probs.length,
      mean: round6(total / probs.length),
      min: round6(ordered[0] ?? 0),
      p25: round6(quantile(0.25)),
      p50: round6(quantile(0.5)),
      p75: round6(quantile(0.75)),
      max: round6(ordered[ordered.length - 1] ?? 0),
      shareAbove099: round6(above / probs.length),
      shareBelow001: round6(below / probs.length),
    };
  };
  const classSpread = (
    rows: CalibrationRow[],
    probs: readonly number[],
  ): Record<string, ReturnType<typeof spreadOf>> => {
    const out: Record<string, ReturnType<typeof spreadOf>> = {};
    for (const label of ["honeypot", "legit", "rug", "scam", "unknown"] as const) {
      const group = rows.map((row, index) => ({ row, prob: probs[index] ?? 0 })).filter(({ row }) => row.label === label);
      out[label] = spreadOf(group.map(({ prob }) => prob));
    }
    const bad = rows.map((row, index) => ({ row, prob: probs[index] ?? 0 })).filter(({ row }) => badLabel(row) === 1);
    const good = rows.map((row, index) => ({ row, prob: probs[index] ?? 0 })).filter(({ row }) => badLabel(row) === 0 && row.label !== "unknown");
    out["bad=1"] = spreadOf(bad.map(({ prob }) => prob));
    out["bad=0"] = spreadOf(good.map(({ prob }) => prob));
    return out;
  };
  // Coverage per feature per class: available/total on the subset where
  // the snapshot row exists, using the same availability the mapping
  // uses. Binary target bad=1/bad=0 ride along.
  const coverageOf = (rows: CalibrationRow[]): Record<string, Record<string, string>> => {
    const out: Record<string, Record<string, string>> = {};
    for (const feature of ONCHAIN_FEATURE_NAMES) {
      const byLabel: Record<string, string> = {};
      for (const label of ["honeypot", "legit", "rug", "scam", "unknown"] as const) {
        const group = rows.filter((row) => row.label === label);
        const hit = group.filter((row) => {
          const snapshot: SnapshotRow | null = snapshotById.get(row.address.toLowerCase()) ?? null;
          return featureAvailable(snapshot, feature);
        }).length;
        byLabel[label] = `${hit}/${group.length}`;
      }
      const badGroup = rows.filter((row) => badLabel(row) === 1);
      const goodGroup = rows.filter((row) => row.label === "legit");
      const badHit = badGroup.filter((row) => featureAvailable(snapshotById.get(row.address.toLowerCase()) ?? null, feature)).length;
      const goodHit = goodGroup.filter((row) => featureAvailable(snapshotById.get(row.address.toLowerCase()) ?? null, feature)).length;
      byLabel["bad=1"] = `${badHit}/${badGroup.length}`;
      byLabel["bad=0"] = `${goodHit}/${goodGroup.length}`;
      out[feature] = byLabel;
    }
    return out;
  };
  // Univariate AUC per on-chain feature evaluated only on the subset
  // where it is available (train and test; holdout only without
  // --skip-holdout). A feature with no positives or no negatives on its
  // subset scores 0.5.
  const univariateOf = (
    rows: CalibrationRow[],
    labels: (0 | 1)[],
  ): Record<string, { auc: number; rows: number }> => {
    const out: Record<string, { auc: number; rows: number }> = {};
    for (const [col, feature] of ONCHAIN_FEATURE_NAMES.entries()) {
      const scores: number[] = [];
      const kept: (0 | 1)[] = [];
      rows.forEach((row, index) => {
        const snapshot: SnapshotRow | null = snapshotById.get(row.address.toLowerCase()) ?? null;
        if (!featureAvailable(snapshot, feature)) {
          return;
        }
        const vector = snapshot === null ? null : snapshotFeaturesOf(snapshot);
        scores.push(vector?.[col] ?? 0);
        kept.push(labels[index] ?? 0);
      });
      out[feature] = { auc: round6(rankAUC(scores, kept)), rows: scores.length };
    }
    return out;
  };
  // TRAIN-only sign check (issue 2): grouped 3-fold CV rank AUC per
  // servable feature on raw values over the available subset of each held
  // fold (groups by codehash, same folds as the lambda choice). A
  // risk-increasing prior expects CV AUC above 0.5, a risk-decreasing one
  // below; mismatches keep their domain constraint regardless (the fit
  // pins them at 0 rather than fitting noise). Test never enters.
  const signCheckOf = (): Record<string, { cvAuc: number; rows: number; expected: string; matches: boolean }> => {
    const out: Record<string, { cvAuc: number; rows: number; expected: string; matches: boolean }> = {};
    const order = trainRows.map((_, index) => index).sort((left, right) => {
      const a = trainCodehashes[left] ?? "";
      const b = trainCodehashes[right] ?? "";
      return a < b ? -1 : a > b ? 1 : left - right;
    });
    const folds: number[][] = [[], [], []];
    order.forEach((rowIndex, position) => {
      folds[position % 3]?.push(rowIndex);
    });
    for (const feature of SERVABLE_FEATURE_NAMES) {
      const rawCol = ONCHAIN_FEATURE_NAMES.indexOf(feature);
      const foldAucs: number[] = [];
      let rows = 0;
      for (let held = 0; held < 3; held += 1) {
        const heldIdx = folds[held] ?? [];
        const scores: number[] = [];
        const kept: (0 | 1)[] = [];
        for (const rowIndex of heldIdx) {
          const row = trainRows[rowIndex];
          if (row === undefined) {
            continue;
          }
          const snapshot: SnapshotRow | null = snapshotById.get(row.address.toLowerCase()) ?? null;
          if (!featureAvailable(snapshot, feature)) {
            continue;
          }
          const vector = snapshot === null ? null : snapshotFeaturesOf(snapshot);
          scores.push(vector?.[rawCol] ?? 0);
          kept.push(trainBadLabels[rowIndex] ?? 0);
        }
        if (held === 0) {
          rows = trainRows.filter((row) => featureAvailable(snapshotById.get(row.address.toLowerCase()) ?? null, feature)).length;
        }
        foldAucs.push(rankAUC(scores, kept));
      }
      const cvAuc = foldAucs.reduce((total, value) => total + value, 0) / Math.max(1, foldAucs.length);
      const constraint = signConstraintOf(feature);
      const expected = constraint === "pos" ? "above-0.5" : "below-0.5";
      out[feature] = {
        cvAuc: round6(cvAuc),
        rows,
        expected,
        matches: constraint === "pos" ? cvAuc > 0.5 : cvAuc < 0.5,
      };
    }
    return out;
  };
  // Pearson correlation over paired finite values; 0 when degenerate.
  const pearsonOf = (xs: readonly number[], ys: readonly number[]): number => {
    if (xs.length !== ys.length || xs.length < 2) {
      return 0;
    }
    let meanX = 0;
    let meanY = 0;
    for (let index = 0; index < xs.length; index += 1) {
      meanX += xs[index] ?? 0;
      meanY += ys[index] ?? 0;
    }
    meanX /= xs.length;
    meanY /= ys.length;
    let cross = 0;
    let varX = 0;
    let varY = 0;
    for (let index = 0; index < xs.length; index += 1) {
      const dx = (xs[index] ?? 0) - meanX;
      const dy = (ys[index] ?? 0) - meanY;
      cross += dx * dy;
      varX += dx * dx;
      varY += dy * dy;
    }
    if (varX <= 0 || varY <= 0) {
      return 0;
    }
    return cross / Math.sqrt(varX * varY);
  };
  // Era-proxy evidence for the dropped deploy-to-first feature (issue 3,
  // TRAIN only): its grouped-CV AUC and its Pearson correlation with
  // deployBlock over the available TRAIN subset.
  const eraProxyOf = (): {
    feature: string;
    trainCvAuc: number;
    pearsonWithDeployBlock: number;
    trainRows: number;
  } => {
    const blocks: number[] = [];
    const deploys: number[] = [];
    const labels: (0 | 1)[] = [];
    trainRows.forEach((row, index) => {
      const snapshot: SnapshotRow | null = snapshotById.get(row.address.toLowerCase()) ?? null;
      if (!featureAvailable(snapshot, "blocks_deploy_to_first_capped") || snapshot?.deployBlock === null) {
        return;
      }
      const vector = snapshot === null ? null : snapshotFeaturesOf(snapshot);
      const col = ONCHAIN_FEATURE_NAMES.indexOf("blocks_deploy_to_first_capped");
      blocks.push(vector?.[col] ?? 0);
      deploys.push(snapshot?.deployBlock ?? 0);
      labels.push(trainBadLabels[index] ?? 0);
    });
    return {
      feature: "blocks_deploy_to_first_capped",
      trainCvAuc: round6(rankAUC(blocks, labels)),
      pearsonWithDeployBlock: round6(pearsonOf(blocks, deploys)),
      trainRows: blocks.length,
    };
  };
  // TRAIN-only error analysis (aggregate feature patterns, never
  // per-token): false positives are legit rows at or above the applied
  // high band, false negatives are bad rows below the applied elevated
  // band. Mean feature values per group show what the arm leans on.
  const trainErrorOf = (
    probs: readonly number[],
    matrix: readonly (readonly number[])[],
    names: readonly string[],
  ): {
    falsePositives: { count: number; topFeatures: { feature: string; mean: number }[] };
    falseNegatives: { count: number; topFeatures: { feature: string; mean: number }[] };
  } => {
    const falsePos: number[][] = [];
    const falseNeg: number[][] = [];
    trainRows.forEach((row, index) => {
      const prob = probs[index] ?? 0;
      if (row.label === "legit" && prob * 100 >= appliedHigh) {
        falsePos.push([...(matrix[index] ?? [])]);
      } else if (badLabel(row) === 1 && prob * 100 < appliedElevated) {
        falseNeg.push([...(matrix[index] ?? [])]);
      }
    });
    const topOf = (group: number[][]) => {
      const means = names.map((feature, col) => ({
        feature,
        mean: round6(group.reduce((total, row) => total + (row[col] ?? 0), 0) / Math.max(1, group.length)),
      }));
      means.sort((left, right) => right.mean - left.mean);
      return means.slice(0, 5);
    };
    return {
      falsePositives: { count: falsePos.length, topFeatures: topOf(falsePos) },
      falseNegatives: { count: falseNeg.length, topFeatures: topOf(falseNeg) },
    };
  };
  // Leakage-check hook: extra snapshot files at other offsets load through
  // the same validation and join, then report coverage, offset violations
  // and the combined-arm AUC beside the era baseline. A W=0 file beating
  // the primary offset would flag leakage, not a better feature.
  const leakageChecks: Record<string, unknown>[] = [];
  for (const extraPath of extraSnapshotPaths) {
    const extra = loadOnchainSnapshotFile(extraPath);
    if (!extra.ok) {
      fail(`cannot load extra onchain snapshot: ${extra.error.message}`);
      throw new Error("unreachable");
    }
    const extraTrain = joinOnchainSnapshot(trainRows, extra.value);
    const extraTest = joinOnchainSnapshot(testRows, extra.value);
    const extraBoth = fitArm(withOnchain(trainFeatures, pickServable(extraTrain.matrix)), bothNonNegative, bothNonPositive, bothLambda);
    leakageChecks.push({
      offsetBlocks: extra.value.offsetBlocks,
      trainMatched: extraTrain.matched,
      trainMissing: extraTrain.missing,
      testMatched: extraTest.matched,
      testMissing: extraTest.missing,
      offsetViolations: extraTrain.violations.length,
      eraTrainAuc: eraOf(extraTrain.deployBlocks, trainBadLabels).auc,
      bothTrainBadAuc: round6(aucRank(badProbsOf(withOnchain(trainFeatures, pickServable(extraTrain.matrix)), extraBoth), trainBadLabels)),
      bothTestBadAuc: round6(aucRank(badProbsOf(withOnchain(testFeatures, pickServable(extraTest.matrix)), extraBoth), testBadLabels)),
    });
  }
  // Snapshot-file coverage membership only (a count of unmatched file rows,
  // never a score): holdout ids stay in this set so the count keeps its
  // meaning, but no holdout probability, metric or band is computed above.
  const allIds = new Set<string>();
  for (const row of [...trainRows, ...testRows, ...holdoutRows, ...unknownRows]) {
    allIds.add(row.address.toLowerCase());
  }
  let unmatchedSnapshots = 0;
  for (const id of snapshotById.keys()) {
    if (!allIds.has(id)) {
      unmatchedSnapshots += 1;
    }
  }
  const invalidReasons: Record<string, number> = {};
  for (const invalid of snapshot.invalidRows) {
    const key = invalid.reason.replace(/0x[0-9a-fA-F]{40}/g, "0x..").slice(0, 100);
    invalidReasons[key] = (invalidReasons[key] ?? 0) + 1;
  }
  const violations = trainJoin.violations;
  const bothNames = [...featureNames, ...SERVABLE_FEATURE_NAMES];
  const selectedArm = onchainMode === "onchain" ? onchainArm : bothArm;
  const selectedNames = onchainMode === "onchain" ? [...SERVABLE_FEATURE_NAMES] : bothNames;
  const coefficientsOf = (names: readonly string[], weights: readonly number[]) =>
    names.map((name, index) => ({ feature: name, weight: round6(weights[index] ?? 0) }));
  const bytecodeMetrics = armMetrics(bytecodeArm, trainFeatures, testFeatures, skipHoldout ? null : holdoutFeatures, testBadLabels, holdoutBadLabels);
  const onchainMetrics = armMetrics(onchainArm, trainOnchain, testOnchain, skipHoldout ? null : holdoutOnchain, testBadLabels, holdoutBadLabels);
  const bothMetrics = armMetrics(bothArm, trainBoth, testBoth, skipHoldout ? null : holdoutBoth, testBadLabels, holdoutBadLabels);
  const testBadProbs = {
    bytecode: badProbsOf(testFeatures, bytecodeArm),
    onchain: badProbsOf(testOnchain, onchainArm),
    both: badProbsOf(testBoth, bothArm),
  };
  // Frozen 1.0.1 artifact as-is on this split vs the retrained bytecode
  // arm: the Part A detector fix does not change the nine binary
  // calibration features (presence only), so this comparison measures
  // re-fit stability, and the report states that plainly.
  let frozen101: Record<string, unknown> | null = null;
  try {
    const frozenRaw = JSON.parse(readFileSync(join(repoRoot, "model", "artifact-1.0.1.json"), "utf8")) as {
      artifact: Record<string, unknown>;
    };
    const frozenParsed = parseModelArtifact(frozenRaw.artifact);
    if (frozenParsed.ok) {
      const frozenProbs = testRows.map((row) => {
        const result = resultForRow(row, frozenParsed.value);
        return Math.max(
          result.probabilities["rug-pull"] as number,
          result.probabilities.honeypot as number,
        );
      });
      frozen101 = {
        testBadAuc: round6(aucRank(frozenProbs, testBadLabels)),
        testBadAucCI: bootstrapAucCI(frozenProbs, testBadLabels, 1000, seed + 1),
        testBadBrier: round6(brier(frozenProbs, testBadLabels)),
        testClassSpread: classSpread(testRows, frozenProbs),
      };
    }
  } catch {
    frozen101 = { error: "could not load artifact-1.0.1.json" };
  }
  // Live-parity gaps that keep features diagnostic-only after this run:
  // holder shares and liquidity depth have no serving-side equivalent yet.
  const DIAGNOSTIC_REASONS: Record<string, string> = {
    conc_deployer_share:
      "live excludes lockers and rebuilds balances from logs while the snapshot counts lockers and reads balances directly",
    conc_top1_share:
      "live excludes lockers and rebuilds balances from logs while the snapshot counts lockers and reads balances directly",
    conc_top10_share:
      "live excludes lockers and rebuilds balances from logs while the snapshot counts lockers and reads balances directly",
    liq_log10_1p_weth: "serving-side unit normalisation pending",
    blocks_deploy_to_first_capped: "dropped from the model: capped delay still proxies launch era (see eraProxy)",
  };
  onchainReport = {
    mode: onchainMode,
    binaryTarget: "bad=1 when label is rug, scam or honeypot; bad=0 when legit; unknown excluded from train/test and reported separately",
    featureVersion: ONCHAIN_FEATURE_VERSION,
    servableFeatures: [...SERVABLE_FEATURE_NAMES],
    diagnosticOnlyFeatures: ONCHAIN_FEATURE_NAMES.filter((name) => !SERVABLE_FEATURE_NAMES.includes(name)),
    diagnosticOnly: ONCHAIN_FEATURE_NAMES.filter((name) => !SERVABLE_FEATURE_NAMES.includes(name)).map((name) => ({
      feature: name,
      reason: DIAGNOSTIC_REASONS[name] ?? "no serving-side equivalent yet",
    })),
    riskDirections: SERVABLE_FEATURE_NAMES.map((name) => ({
      feature: name,
      direction: ONCHAIN_RISK_DIRECTIONS[name]?.direction ?? "unknown",
      rationale: ONCHAIN_RISK_DIRECTIONS[name]?.rationale ?? "",
    })),
    scaler: {
      ...scalerToJSON(onchainScaler),
      note: "continuous on-chain columns standardized with these TRAIN-only params; binaries pass through; missing maps to 0",
    },
    signCheck: signCheckOf(),
    eraProxy: eraProxyOf(),
    offsetBlocks: snapshot.offsetBlocks,
    skipHoldout,
    coverage: {
      train: { matched: trainJoin.matched, missing: trainJoin.missing },
      test: { matched: testJoin.matched, missing: testJoin.missing },
      holdout: holdoutJoin === null ? "skipped" : { matched: holdoutJoin.matched, missing: holdoutJoin.missing },
      unknown: { matched: unknownJoin.matched, missing: unknownJoin.missing, count: unknownRows.length },
      duplicateSnapshotRows: trainJoin.duplicateSnapshots,
      unmatchedSnapshotRows: unmatchedSnapshots,
      invalidSnapshotRows: snapshot.invalidRows.length,
      invalidReasons,
      perFeature: {
        train: coverageOf(trainRows),
        test: coverageOf(testRows),
        holdout: skipHoldout ? "skipped" : coverageOf(holdoutForScoring),
        unknown: coverageOf(unknownRows),
      },
    },
    univariate: {
      train: univariateOf(trainRows, trainBadLabels),
      test: univariateOf(testRows, testBadLabels),
      note: "each AUC uses only the subset where the feature is available",
    },
    drainedLp: {
      note: "pairs with minimum-liquidity-only supply: burnedShare 1.0 means drained, mapped to burned 0 plus the affirmed flag",
    },
    offsetViolations: {
      count: violations.length,
      sample: violations.slice(0, 5),
    },
    era: {
      deployBlock: {
        train: eraOf(trainJoin.deployBlocks, trainBadLabels),
        test: eraOf(testJoin.deployBlocks, testBadLabels),
      },
      snapshotBlock: {
        train: eraOf(trainJoin.snapshotBlocks, trainBadLabels),
        test: eraOf(testJoin.snapshotBlocks, testBadLabels),
      },
      note: "block numbers alone, reported but never used as features",
    },
    arms: {
      bytecode: {
        ...bytecodeMetrics,
        testClassSpread: classSpread(testRows, testBadProbs.bytecode),
        trainError: trainErrorOf(badProbsOf(trainFeatures, bytecodeArm), trainFeatures, featureNames),
      },
      onchain: {
        ...onchainMetrics,
        testClassSpread: classSpread(testRows, testBadProbs.onchain),
        trainError: trainErrorOf(badProbsOf(trainOnchain, onchainArm), trainOnchain, SERVABLE_FEATURE_NAMES),
      },
      both: {
        ...bothMetrics,
        testClassSpread: classSpread(testRows, testBadProbs.both),
        trainError: trainErrorOf(badProbsOf(trainBoth, bothArm), trainBoth, bothNames),
      },
    },
    researchFit: {
      arm: onchainMode,
      space: "onchain columns standardized with the TRAIN scaler above; bytecode columns raw 0/1",
      rugHead: { uncalibrated: selectedArm.rug.uncalibrated, coefficients: coefficientsOf(selectedNames, selectedArm.rug.weights) },
      honeyHead: { uncalibrated: selectedArm.honey.uncalibrated, coefficients: coefficientsOf(selectedNames, selectedArm.honey.weights) },
    },
    frozen101AsIs: frozen101,
    leakageChecks,
    note: "research fits are diagnostics only; the frozen artifact carries the bytecode fit",
  };
  // Scaler sidecar beside the candidate artifact (the frozen artifact
  // schema carries no on-chain fields): serving applies this same TRAIN
  // transform before any future on-chain head.
  writeFileSync(
    join(outDir, `onchain-scaler-${VERSION_TEXT}.json`),
    JSON.stringify(
      {
        version: VERSION_TEXT,
        featureVersion: ONCHAIN_FEATURE_VERSION,
        seed,
        scaler: scalerToJSON(onchainScaler),
        note: "standardize continuous on-chain columns with these TRAIN params; binaries pass through; missing maps to 0",
      },
      null,
      2,
    ),
    "utf8",
  );
}

// Reliability deciles on TEST bad probability: mean predicted vs
// observed bad rate per tenth of the sorted predictions.
function deciles(probs: readonly number[], labels: readonly (0 | 1)[]): { count: number; meanPredicted: number; observed: number }[] {
  const order = probs.map((prob, index) => ({ prob, label: labels[index] ?? 0 }));
  order.sort((left, right) => left.prob - right.prob);
  const out: { count: number; meanPredicted: number; observed: number }[] = [];
  const bins = 10;
  for (let bin = 0; bin < bins; bin += 1) {
    const start = Math.floor((bin * order.length) / bins);
    const end = Math.floor(((bin + 1) * order.length) / bins);
    const slice = order.slice(start, Math.max(end, start + (bin === bins - 1 ? 1 : 0)));
    if (slice.length === 0) {
      out.push({ count: 0, meanPredicted: 0, observed: 0 });
      continue;
    }
    const predicted = slice.reduce((total, entry) => total + entry.prob, 0) / slice.length;
    const observed = slice.reduce((total, entry) => total + entry.label, 0) / slice.length;
    out.push({ count: slice.length, meanPredicted: round6(predicted), observed: round6(observed) });
  }
  return out;
}

function bandRows(
  rows: CalibrationRow[],
  summary: { scores: number[] },
  features: number[][],
  keep: (row: CalibrationRow, score: number) => boolean,
  order: (left: { score: number }, right: { score: number }) => number,
): { symbol: string; score: number; firing: string[] }[] {
  return rows
    .map((row, index) => ({ row, score: summary.scores[index] ?? 0, features: features[index] ?? [] }))
    .filter(({ row, score }) => keep(row, score))
    .sort(order)
    .slice(0, 5)
    .map(({ row, score, features }) => ({
      symbol: row.symbol,
      score,
      firing: featureNames.filter((_, index) => (features[index] ?? 0) === 1),
    }));
}

const worstLegitHigh = bandRows(
  testRows,
  testSummary,
  testFeatures,
  (row, score) => row.label === "legit" && score >= appliedHigh,
  (left, right) => right.score - left.score,
);
const worstBadLow = bandRows(
  testRows,
  testSummary,
  testFeatures,
  (row, score) => row.label !== "legit" && score < appliedElevated,
  (left, right) => left.score - right.score,
);
const holdoutWorstLegitHigh =
  holdoutSummary === null
    ? []
    : bandRows(
        holdoutForScoring,
        holdoutSummary,
        holdoutFeatures,
        (row, score) => row.label === "legit" && score >= appliedHigh,
        (left, right) => right.score - left.score,
      );
const holdoutWorstBadLow =
  holdoutSummary === null
    ? []
    : bandRows(
        holdoutForScoring,
        holdoutSummary,
        holdoutFeatures,
        (row, score) => row.label !== "legit" && score < appliedElevated,
        (left, right) => left.score - right.score,
      );

const output = {
  version: VERSION_TEXT,
  dataVersion,
  seed,
  dedupe: {
    calibrationTotal: calibrationRows.length,
    droppedHoldoutOverlap: deduped.droppedHoldoutOverlap,
    droppedDuplicates: deduped.droppedDuplicates,
    kept: finalRows.length,
    fitted: fittedRows.length,
    unknown: unknownRows.length,
    holdoutTotal: holdoutRows.length,
  },
  split: {
    train: trainRows.length,
    test: testRows.length,
    trainByLabel: ["legit", "rug", "honeypot", "scam"].map((label) => ({
      label,
      train: trainRows.filter((row) => row.label === label).length,
      test: testRows.filter((row) => row.label === label).length,
    })),
  },
  weights: {
    defaults: sampleConfig,
    lambda: LAMBDA,
    iterations: ITERATIONS,
    step: STEP,
    rugHead: {
      bias: round6(rugHead.bias),
      slope: rugHead.slope,
      intercept: rugHead.intercept,
      uncalibrated: rugHead.uncalibrated,
      coefficients: FEATURE_PLUGINS.map(({ name }, index) => ({ detector: name, weight: round6(rugHead.weights[index] ?? 0) })),
      unconstrained: FEATURE_PLUGINS.map(({ name }, index) => ({ detector: name, weight: round6(rugFree.weights[index] ?? 0) })),
    },
    honeyHead: {
      bias: round6(honeyHead.bias),
      slope: honeyHead.slope,
      intercept: honeyHead.intercept,
      uncalibrated: honeyHead.uncalibrated,
      coefficients: FEATURE_PLUGINS.map(({ name }, index) => ({ detector: name, weight: round6(honeyHead.weights[index] ?? 0) })),
      unconstrained: FEATURE_PLUGINS.map(({ name }, index) => ({ detector: name, weight: round6(honeyFree.weights[index] ?? 0) })),
    },
    projectedToZero,
    pluginWeights,
    detectorHeadWeights,
    uncalibratedHeads,
  },
  train: {
    count: trainRows.length,
    badAuc: trainAuc.bad,
    rugAuc: trainAuc.rug,
    honeyAuc: trainAuc.honey,
    ablation,
  },
  bands: {
    applied: { ...DEFAULT_BAND_THRESHOLDS },
    fitted: chosenBands,
  },
  test: {
    count: testSummary.count,
    bands: testSummary.bands,
    fittedBands: testSummary.fittedBands,
    badAuc: round6(testBadAuc),
    badAucCI: testBadAucCI,
    rugAuc: round6(aucRank(testSummary.rugProbs, testRugLabels)),
    honeyAuc: round6(aucRank(testSummary.honeyProbs, testHoneyLabels)),
    badBrier: round6(brier(testSummary.badProbs, testBadLabels)),
    rugBrier: round6(brier(testSummary.rugProbs, testRugLabels)),
    honeyBrier: round6(brier(testSummary.honeyProbs, testHoneyLabels)),
    deciles: deciles(testSummary.badProbs, testBadLabels),
    worstLegitHigh,
    worstBadLow,
  },
  holdout:
    holdoutSummary === null
      ? "skipped"
      : {
          count: holdoutSummary.count,
          bands: holdoutSummary.bands,
          fittedBands: holdoutSummary.fittedBands,
          badAuc: round6(aucRank(holdoutSummary.badProbs, holdoutBadLabels)),
          badBrier: round6(brier(holdoutSummary.badProbs, holdoutBadLabels)),
          worstLegitHigh: holdoutWorstLegitHigh,
          worstBadLow: holdoutWorstBadLow,
        },
  unknown: {
    count: unknownSummary.count,
    bands: unknownSummary.bands,
    fittedBands: unknownSummary.fittedBands,
  },
  cofire: {
    detectors: featureNames,
    matrix: cofire.map((row) => row.map((value) => round6(value))),
  },
  onchain: onchainReport,
  perDetectorTrainFire: FEATURE_PLUGINS.map(({ name }, index) => {
    const byLabel: Record<string, string> = {};
    for (const label of ["legit", "rug", "honeypot", "scam"]) {
      const group = trainRows.map((row, rowIndex) => ({ row, features: trainFeatures[rowIndex] ?? [] })).filter(({ row }) => row.label === label);
      const fired = group.filter(({ features }) => (features[index] ?? 0) === 1).length;
      byLabel[label] = `${fired}/${group.length}`;
    }
    return { detector: name, ...byLabel };
  }),
};
process.stdout.write(`${JSON.stringify(output)}\n`);
