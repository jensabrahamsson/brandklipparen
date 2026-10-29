// Holdout-v2 evaluation (offline, no network, no fitting).
// Scores the frozen model on the holdout-v2 set exactly once. It loads a
// frozen config (see scripts/calibrate-real.ts --freeze), checks its sha256
// when --expect-sha256 is given, and scores every ablation without fitting,
// tuning or re-thresholding anything. Aggregate numbers only: no addresses,
// codehashes or bytecode are printed or written anywhere.
// Run from the repo root, for example:
//   export PATH="$HOME/.local/node22/bin:$PATH"
//   node --experimental-strip-types scripts/evaluate-holdout-v2.ts \
//     --frozen <frozen-config>.json --expect-sha256 <hash> \
//     --dataset <holdout-v2-dataset>.json \
//     --onchain-snapshot <holdout-v2-snapshot>.json \
//     --out-dir <empty-results-dir>
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Bytecode, CodeHash } from "../src/domain/types.ts";
import { loadOnchainSnapshotFile } from "../src/adapters/onchain/snapshotFile.ts";
import { indexSnapshotById, featureAvailable, holdersReliable, lpIsV2 } from "../src/domain/onchain/snapshot.ts";
import { ONCHAIN_FEATURE_NAMES } from "../src/domain/onchain/snapshot.ts";
import { joinOnchainSnapshot } from "../src/application/onchainCalibration.ts";
import {
  parseFrozenConfig,
  parseHoldoutDataset,
  effectiveBytecodeOf,
  scoreFrozenArm,
  applyFrozenScaler,
  badLabelOf,
  isUnknownLabel,
  aucRank,
  bootstrapAucCI,
  brier,
  round6,
  bandCountsOf,
  confusionOf,
} from "../src/application/holdoutV2.ts";
import type { FrozenConfig } from "../src/application/holdoutV2.ts";

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

function flagValues(name: string): string[] {
  const argv = process.argv.slice(2);
  const out: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === `--${name}`) {
      const value = argv[index + 1];
      if (value !== undefined) {
        out.push(value);
      }
    } else if (arg !== undefined && arg.startsWith(`--${name}=`)) {
      out.push(arg.slice(name.length + 3));
    }
  }
  return out;
}

function fail(message: string): never {
  process.stderr.write(`evaluate-holdout-v2: ${message}\n`);
  process.exit(1);
}

const frozenInputs = [...flagValues("frozen"), ...(process.env["BK_HOLDOUT_V2_FROZEN"] ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0)];
const frozenPaths = frozenInputs.flatMap((entry) => entry.split(",").map((part) => part.trim()).filter((part) => part.length > 0));
if (frozenPaths.length === 0) {
  fail("missing frozen config: pass --frozen <path> (one file with all three ablations, or three files)");
}
const expectRaw = flagValue("expect-sha256") ?? process.env["BK_EXPECT_SHA256"] ?? undefined;
const expectedHashes = expectRaw === undefined ? [] : expectRaw.split(",").map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0);
const datasetPath = flagValue("dataset") ?? process.env["BK_HOLDOUT_V2_DATASET"];
if (datasetPath === undefined) {
  fail("missing holdout-v2 dataset path: pass --dataset or BK_HOLDOUT_V2_DATASET");
  throw new Error("unreachable");
}
const snapshotPath = flagValue("onchain-snapshot") ?? process.env["BK_HOLDOUT_V2_SNAPSHOT"];
if (snapshotPath === undefined) {
  fail("missing holdout-v2 snapshot path: pass --onchain-snapshot or BK_HOLDOUT_V2_SNAPSHOT");
  throw new Error("unreachable");
}
const outDir = flagValue("out-dir") ?? process.env["BK_HOLDOUT_V2_OUT_DIR"];
if (outDir === undefined) {
  fail("missing output dir: pass --out-dir");
  throw new Error("unreachable");
}

// Exactly-once guard: when the marker exists the holdout was already
// evaluated and this run refuses before reading any row.
const markerPath = join(outDir, "HOLDOUT-V2-EVALUATED.json");
if (existsSync(markerPath)) {
  fail(`holdout-v2 was already evaluated: ${markerPath} exists, refusing to run again`);
}

function shaOfBytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readText(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    fail(`cannot read ${what} file at ${path}`);
    throw new Error("unreachable");
  }
}

// Load and verify every frozen file. One file must hold all three
// ablations; three files merge positionally (first bytecode, second
// onchain, third both) after a metadata consistency check.
const frozenTexts = frozenPaths.map((path) => readText(path, "frozen config"));
const frozenHashes = frozenTexts.map((text) => shaOfBytes(text).toLowerCase());
if (expectedHashes.length > 0) {
  if (expectedHashes.length !== 1 && expectedHashes.length !== frozenHashes.length) {
    fail("--expect-sha256 must carry one hash or one hash per --frozen file");
  }
  frozenHashes.forEach((hash, index) => {
    const expected = expectedHashes.length === 1 ? expectedHashes[0] : expectedHashes[index];
    if (hash !== expected) {
      fail(`frozen file hash mismatch at index ${index}: expected ${expected}, got ${hash}`);
    }
  });
}
const parsedFrozen = frozenTexts.map((text, index) => {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    fail(`frozen file at index ${index} is not valid JSON`);
    throw new Error("unreachable");
  }
  const parsed = parseFrozenConfig(raw);
  if (!parsed.ok) {
    fail(`frozen file at index ${index} is invalid: ${parsed.error.message}`);
    throw new Error("unreachable");
  }
  return parsed.value;
});
let frozen: FrozenConfig;
if (parsedFrozen.length === 1) {
  const only = parsedFrozen[0];
  if (only === undefined) {
    fail("missing frozen config");
    throw new Error("unreachable");
  }
  frozen = only;
} else if (parsedFrozen.length === 3) {
  const first = parsedFrozen[0];
  const second = parsedFrozen[1];
  const third = parsedFrozen[2];
  if (first === undefined || second === undefined || third === undefined) {
    fail("missing frozen config");
    throw new Error("unreachable");
  }
  for (const [field, left, right] of [
    ["seed", first.seed, second.seed],
    ["seed", first.seed, third.seed],
    ["modelVersion", first.modelVersion, second.modelVersion],
    ["dataVersion", first.dataVersion, second.dataVersion],
    ["featureVersion", first.featureVersion, second.featureVersion],
  ] as const) {
    if (left !== right) {
      fail(`frozen files disagree on ${field}, refusing to merge`);
    }
  }
  frozen = { ...first, arms: Object.freeze({ bytecode: first.arms.bytecode, onchain: second.arms.onchain, both: third.arms.both }) };
} else {
  fail("pass one frozen file with all three ablations, or exactly three frozen files");
  throw new Error("unreachable");
}
const effectiveFrozenHash = frozenHashes.length === 1 ? (frozenHashes[0] ?? "") : shaOfBytes(JSON.stringify([...frozenHashes].sort()));

// The holdout snapshot must carry the holdout section keyed by address;
// a file without it is the wrong snapshot for this run.
const snapshotText = readText(snapshotPath, "holdout-v2 snapshot");
let snapshotRaw: unknown;
try {
  snapshotRaw = JSON.parse(snapshotText) as unknown;
} catch {
  fail("holdout-v2 snapshot file is not valid JSON");
  throw new Error("unreachable");
}
if (typeof snapshotRaw !== "object" || snapshotRaw === null || Array.isArray(snapshotRaw)) {
  fail("holdout-v2 snapshot file must be a JSON object with a holdout section");
}
if (typeof (snapshotRaw as Record<string, unknown>)["holdout"] !== "object" || (snapshotRaw as Record<string, unknown>)["holdout"] === null) {
  fail("holdout-v2 snapshot file holds no holdout section");
}

const datasetText = readText(datasetPath, "holdout-v2 dataset");
let datasetRaw: unknown;
try {
  datasetRaw = JSON.parse(datasetText) as unknown;
} catch {
  fail("holdout-v2 dataset file is not valid JSON");
  throw new Error("unreachable");
}
const datasetParsed = parseHoldoutDataset(datasetRaw);
if (!datasetParsed.ok) {
  fail(`holdout-v2 dataset is invalid: ${datasetParsed.error.message}`);
  throw new Error("unreachable");
}
const holdoutRows = datasetParsed.value;

const loaded = loadOnchainSnapshotFile(snapshotPath);
if (!loaded.ok) {
  fail(`cannot load holdout-v2 snapshot: ${loaded.error.message}`);
  throw new Error("unreachable");
}
const snapshot = loaded.value;

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
  mintDetectorPlugin,
  blacklistDetectorPlugin,
  transferFeeDetectorPlugin,
  pauseDetectorPlugin,
  transferLimitsDetectorPlugin,
  ownershipDetectorPlugin,
  transferHooksDetectorPlugin,
  sellBlockDetectorPlugin,
  proxyUpgradeDetectorPlugin,
] as const;

function bytecodeFeaturesOf(bytecodeHex: string): number[] {
  const parsed = Bytecode.parse(bytecodeHex);
  if (!parsed.ok) {
    return FEATURE_PLUGINS.map(() => 0);
  }
  const code = parsed.value;
  const hash = CodeHash.of(code);
  if (!hash.ok) {
    return FEATURE_PLUGINS.map(() => 0);
  }
  const input = Object.freeze({ bytecode: code, codeHash: hash.value });
  return FEATURE_PLUGINS.map((plugin) => {
    try {
      return plugin.detect(input).length > 0 ? 1 : 0;
    } catch {
      return 0;
    }
  });
}

const { byId: snapshotById } = indexSnapshotById(snapshot);
const servableIndex = frozen.onchainServableFeatures.map((name) => ONCHAIN_FEATURE_NAMES.indexOf(name));
const joined = joinOnchainSnapshot(holdoutRows, snapshot);

const bytecodeMatrix = holdoutRows.map((row) => bytecodeFeaturesOf(effectiveBytecodeOf(row)));
const onchainRaw = joined.matrix;
const onchainAvail = holdoutRows.map((row) => {
  const snap = snapshotById.get(row.address.toLowerCase()) ?? null;
  return frozen.onchainServableFeatures.map((feature) => featureAvailable(snap, feature));
});
const onchainMatrix = onchainRaw.map((vector, index) => {
  const picked = servableIndex.map((col) => vector[col] ?? 0);
  return [...applyFrozenScaler(picked, onchainAvail[index] ?? [], frozen.scaler)];
});
const bothMatrix = bytecodeMatrix.map((base, index) => [...base, ...(onchainMatrix[index] ?? [])]);

const armMatrices = {
  bytecode: bytecodeMatrix,
  onchain: onchainMatrix,
  both: bothMatrix,
} as const;

const labels = holdoutRows.map((row) => row.label);
const knownIndex = labels.map((label, index) => (isUnknownLabel(label) ? -1 : index)).filter((index) => index >= 0);
const knownLabels = knownIndex.map((index) => badLabelOf(labels[index] ?? "")) as (0 | 1)[];
const unknownIndex = labels.map((label, index) => (isUnknownLabel(label) ? index : -1)).filter((index) => index >= 0);

const elevated = frozen.bandThresholds.elevated;
const high = frozen.bandThresholds.high;

type ArmReport = {
  readonly count: number;
  readonly auc: number;
  readonly aucCI: { readonly lower: number; readonly upper: number; readonly resamples: number };
  readonly brier: number;
  readonly bands: { readonly low: number; readonly elevated: number; readonly high: number };
  readonly unknownBands: { readonly low: number; readonly elevated: number; readonly high: number };
  readonly confusion: { readonly truePositives: number; readonly falsePositives: number; readonly trueNegatives: number; readonly falseNegatives: number };
};

const arms: Record<string, ArmReport> = {};
for (const name of ["bytecode", "onchain", "both"] as const) {
  const matrix = armMatrices[name];
  const arm = frozen.arms[name];
  const probs = matrix.map((features) => scoreFrozenArm(features, arm));
  const knownProbs = knownIndex.map((index) => probs[index] ?? 0);
  const unknownProbs = unknownIndex.map((index) => probs[index] ?? 0);
  arms[name] = Object.freeze({
    count: knownProbs.length,
    auc: round6(aucRank(knownProbs, knownLabels)),
    aucCI: bootstrapAucCI(knownProbs, knownLabels, 1000, frozen.seed + 1),
    brier: round6(brier(knownProbs, knownLabels)),
    bands: bandCountsOf(knownProbs, elevated, high),
    unknownBands: bandCountsOf(unknownProbs, elevated, high),
    confusion: confusionOf(knownProbs, knownLabels, elevated),
  });
}

const CLASS_LABELS = ["legit", "rug", "honeypot", "scam", "unknown"] as const;
const coverage: Record<string, { readonly rows: number; readonly withSnapshot: number; readonly withLpV2: number; readonly withHolders: number; readonly scored: Record<string, number> }> = {};
for (const label of CLASS_LABELS) {
  const indexes = labels.map((entry, index) => (entry === label ? index : -1)).filter((index) => index >= 0);
  let withSnapshot = 0;
  let withLpV2 = 0;
  let withHolders = 0;
  for (const index of indexes) {
    const row = holdoutRows[index];
    const snap = row === undefined ? null : (snapshotById.get(row.address.toLowerCase()) ?? null);
    if (snap !== null && snap.snapshot.status === "ok") {
      withSnapshot += 1;
    }
    if (lpIsV2(snap)) {
      withLpV2 += 1;
    }
    if (snap !== null && holdersReliable(snap)) {
      withHolders += 1;
    }
  }
  coverage[label] = Object.freeze({
    rows: indexes.length,
    withSnapshot,
    withLpV2,
    withHolders,
    scored: Object.freeze({ bytecode: indexes.length, onchain: indexes.length, both: indexes.length }),
  });
}

// Exactly-once marker first, then results: a second run with the same
// out-dir refuses above, so the holdout scores exactly once.
mkdirSync(outDir, { recursive: true });
const datasetSha256 = shaOfBytes(datasetText);
const snapshotSha256 = shaOfBytes(snapshotText);
const marker = {
  marker: "HOLDOUT-V2-EVALUATED",
  createdAt: new Date().toISOString(),
  frozenHashes,
  frozenSha256: effectiveFrozenHash,
  datasetSha256,
  snapshotSha256,
  datasetRows: holdoutRows.length,
};
writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");

const output = {
  holdout: "holdout-v2",
  frozenSha256: effectiveFrozenHash,
  frozenVersion: frozen.frozenVersion,
  modelVersion: frozen.modelVersion,
  dataVersion: frozen.dataVersion,
  seed: frozen.seed,
  positiveClass: frozen.positiveClass,
  unknownHandling: frozen.unknownHandling,
  decisionRule: frozen.decisionRule,
  bandThresholds: frozen.bandThresholds,
  datasetRows: holdoutRows.length,
  knownRows: knownIndex.length,
  unknownRows: unknownIndex.length,
  arms,
  coverage,
};
writeFileSync(join(outDir, "holdout-v2-metrics.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");

// Aggregate stdout only: counts, AUC with CI, Brier, bands, confusion and
// coverage. Never per-token values.
for (const name of ["bytecode", "onchain", "both"] as const) {
  const report = arms[name];
  if (report === undefined) {
    continue;
  }
  process.stdout.write(
    `${name} n=${report.count} auc=${report.auc} ci=${report.aucCI.lower}-${report.aucCI.upper} brier=${report.brier} bands=${report.bands.low}/${report.bands.elevated}/${report.bands.high}\n`,
  );
}
process.stdout.write(`coverage rows=${holdoutRows.length} known=${knownIndex.length} unknown=${unknownIndex.length}\n`);
void repoRoot;

