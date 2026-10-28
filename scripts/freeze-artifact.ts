// Freeze command for the versioned calibration artifact (K-211, S-019;
// S-115 calibration readiness). Run from the repo root with
// `npm run freeze-artifact`: reads the small synthetic placeholder dataset
// under tests/fixtures/artifact, trains the scoring artifact through the
// pure domain freeze in src/domain/artifact.ts and writes the frozen,
// checksummed file `model/artifact-<version>.json` verbatim. Re-running
// with the same dataset and version reproduces the file byte for byte;
// changing the dataset or the seed requires deliberately re-running this
// command and committing the regenerated file, and the retraining test
// turns red until then. Production calibration runs offline per A-28 and
// K-210; this command carries the synthetic placeholder only.
//
// Calibration readiness (S-115): the same command consumes a labeled
// calibration file through `--dataset <path>` (or BK_CALIBRATION_DATASET,
// no default path inside the repo) and overlays prior weights through
// `--priors <path>` (or BK_PRIORS_FILE). A dataset that parses as a JSON
// array is read as calibration rows (the labeled-tokens shape) and rolled
// up to risk outcomes with per-row basis weighting (`--basis-weights` as
// inline JSON or BK_BASIS_WEIGHTS, defaults documented in
// src/domain/dataset.ts); severity, cause and share counts stay on the
// synthetic placeholder until real calibration lands, and the training
// still requires at least one positive per risk. `--version` names the
// artifact version, `--data-version` stamps row-derived training input,
// and `--out-dir` redirects the output file (default `model/`).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freezeArtifactFile, trainArtifact } from "../src/domain/artifact.ts";
import { ModelVersion } from "../src/domain/types.ts";
import { parseModelArtifact } from "../src/domain/risk.ts";
import { calibrationRowsToDataset } from "../src/domain/calibrationRows.ts";
import { expandByBasisWeight, parseBasisWeights, summarizeForTraining } from "../src/domain/dataset.ts";

// Locked version, dataset and output for the synthetic placeholder freeze.
// A new model version or dataset revision changes these constants together
// with the committed file in the same change.
const MODEL_VERSION = "0.0.0-synthetic.1";
const DATASET_FILE = join("tests", "fixtures", "artifact", "synthetic-dataset-v1.json");

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function fail(message: string): never {
  process.stderr.write(`freeze-artifact: ${message}\n`);
  process.exit(1);
}

// Minimal named-flag reader over argv: `--name value` or `--name=value`.
// The default zero-flag run keeps the locked constants below.
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

function readJsonFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    fail(`cannot read file ${path}`);
    throw new Error("unreachable");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    fail(`file ${path} is not valid JSON`);
    throw new Error("unreachable");
  }
}

const versionText = flagValue("version") ?? MODEL_VERSION;
const version = ModelVersion.parse(versionText);
if (!version.ok) {
  fail(`invalid model version: ${versionText}`);
  throw new Error("unreachable");
}
const datasetPath = flagValue("dataset") ?? process.env["BK_CALIBRATION_DATASET"] ?? join(repoRoot, DATASET_FILE);
const priorsPath = flagValue("priors") ?? process.env["BK_PRIORS_FILE"];
const outDir = flagValue("out-dir") ?? join(repoRoot, "model");
const outputFile = `artifact-${versionText}.json`;

const rawDataset = readJsonFile(datasetPath);
let trainingInput: unknown = rawDataset;
if (Array.isArray(rawDataset)) {
  // Calibration rows (the labeled-tokens shape): roll the rows up to
  // risk outcomes with basis weighting, keeping severity, cause and
  // share counts on the synthetic placeholder until real calibration.
  const basisRaw = flagValue("basis-weights") ?? process.env["BK_BASIS_WEIGHTS"];
  let basisInput: unknown;
  if (basisRaw !== undefined) {
    try {
      basisInput = JSON.parse(basisRaw) as unknown;
    } catch {
      fail("--basis-weights is not valid JSON");
      throw new Error("unreachable");
    }
  }
  const weights = parseBasisWeights(basisInput);
  if (!weights.ok) {
    fail(`invalid basis weights: ${weights.error.message}`);
    throw new Error("unreachable");
  }
  const rowsDataVersion = flagValue("data-version") ?? "calibration-v1";
  const converted = calibrationRowsToDataset(rawDataset, rowsDataVersion);
  if (!converted.ok) {
    fail(`calibration rows failed: ${converted.error.message}`);
    throw new Error("unreachable");
  }
  const base = readJsonFile(join(repoRoot, DATASET_FILE));
  if (typeof base !== "object" || base === null || Array.isArray(base)) {
    fail("placeholder training input is not an object");
    throw new Error("unreachable");
  }
  const expanded = expandByBasisWeight(converted.value.datapoints, weights.value);
  trainingInput = {
    ...(base as Record<string, unknown>),
    dataVersion: rowsDataVersion,
    riskOutcomes: summarizeForTraining({ ...converted.value, datapoints: expanded }),
  };
}
const trained = trainArtifact(trainingInput, version.value);
if (!trained.ok) {
  fail(`training failed: ${trained.error.message}`);
  throw new Error("unreachable");
}
let artifactJson: unknown = {
  biases: trained.value.artifact.biases,
  calibration: trained.value.artifact.calibration,
  causeWeights: trained.value.artifact.causeWeights,
  scoreWeights: trained.value.artifact.scoreWeights,
  severityWeights: trained.value.artifact.severityWeights,
  version: versionText,
  pluginWeights: trained.value.artifact.pluginWeights,
  ...(Object.keys(trained.value.artifact.pluginFeatureCatalogue).length === 0
    ? {}
    : { pluginFeatureCatalogue: trained.value.artifact.pluginFeatureCatalogue }),
  ...(trained.value.artifact.scoreBands === undefined ? {} : { scoreBands: trained.value.artifact.scoreBands }),
  ...(trained.value.artifact.detectorHeadWeights === undefined
    ? {}
    : { detectorHeadWeights: trained.value.artifact.detectorHeadWeights }),
  ...(trained.value.artifact.uncalibratedHeads === undefined
    ? {}
    : { uncalibratedHeads: trained.value.artifact.uncalibratedHeads }),
};
if (priorsPath !== undefined) {
  // Prior overlay (S-115): principled default weights for the
  // owner-control features, documented in docs/decisions/log.md. The
  // overlay merges over the trained base and re-validates, so a
  // misspelled plugin id or an out-of-vocabulary risk fails loudly.
  const priors = readJsonFile(priorsPath);
  if (typeof priors !== "object" || priors === null || Array.isArray(priors)) {
    fail(`priors file ${priorsPath} must be a JSON object`);
    throw new Error("unreachable");
  }
  const record = priors as Record<string, unknown>;
  artifactJson = {
    ...(artifactJson as Record<string, unknown>),
    ...(record["pluginWeights"] === undefined ? {} : { pluginWeights: record["pluginWeights"] }),
    ...(record["pluginFeatureCatalogue"] === undefined
      ? {}
      : { pluginFeatureCatalogue: record["pluginFeatureCatalogue"] }),
    ...(record["scoreBands"] === undefined ? {} : { scoreBands: record["scoreBands"] }),
    ...(record["uncalibratedHeads"] === undefined ? {} : { uncalibratedHeads: record["uncalibratedHeads"] }),
  };
}
const parsed = parseModelArtifact(artifactJson);
if (!parsed.ok) {
  fail(`artifact failed validation: ${parsed.error.message}`);
  throw new Error("unreachable");
}
const frozen = freezeArtifactFile({
  artifact: parsed.value,
  dataVersion: trained.value.dataVersion,
  seed: trained.value.seed,
});
if (!frozen.ok) {
  fail(`freeze failed: ${frozen.error.message}`);
  throw new Error("unreachable");
}
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, outputFile), frozen.value, "utf8");
process.stdout.write(`froze ${outputFile} from ${datasetPath}\n`);
