// Freeze command for the versioned calibration artifact (K-211, S-019).
// Run from the repo root with `npm run freeze-artifact`: reads the small
// synthetic placeholder dataset under tests/fixtures/artifact, trains the
// scoring artifact through the pure domain freeze in
// src/domain/artifact.ts and writes the frozen, checksummed file
// `model/artifact-<version>.json` verbatim. Re-running with the same
// dataset and version reproduces the file byte for byte; changing the
// dataset or the seed requires deliberately re-running this command and
// committing the regenerated file, and the retraining test turns red until
// then. Production calibration runs offline per A-28 and K-210; this
// command carries the synthetic placeholder only.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freezeArtifactFile, trainArtifact } from "../src/domain/artifact.ts";
import { ModelVersion } from "../src/domain/types.ts";

// Locked version, dataset and output for the synthetic placeholder freeze.
// A new model version or dataset revision changes these constants together
// with the committed file in the same change.
const MODEL_VERSION = "0.0.0-synthetic.1";
const DATASET_FILE = join("tests", "fixtures", "artifact", "synthetic-dataset-v1.json");
const OUTPUT_FILE = `artifact-${MODEL_VERSION}.json`;

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function fail(message: string): never {
  process.stderr.write(`freeze-artifact: ${message}\n`);
  process.exit(1);
}

const version = ModelVersion.parse(MODEL_VERSION);
if (!version.ok) {
  fail(`invalid model version: ${MODEL_VERSION}`);
}
let datasetRaw: string;
try {
  datasetRaw = readFileSync(join(repoRoot, DATASET_FILE), "utf8");
} catch {
  fail(`cannot read dataset file ${DATASET_FILE}`);
  throw new Error("unreachable");
}
let dataset: unknown;
try {
  dataset = JSON.parse(datasetRaw) as unknown;
} catch {
  fail(`dataset file ${DATASET_FILE} is not valid JSON`);
  throw new Error("unreachable");
}
const trained = trainArtifact(dataset, version.value);
if (!trained.ok) {
  fail(`training failed: ${trained.error.message}`);
  throw new Error("unreachable");
}
const frozen = freezeArtifactFile(trained.value);
if (!frozen.ok) {
  fail(`freeze failed: ${frozen.error.message}`);
  throw new Error("unreachable");
}
mkdirSync(join(repoRoot, "model"), { recursive: true });
writeFileSync(join(repoRoot, "model", OUTPUT_FILE), frozen.value, "utf8");
process.stdout.write(`froze ${OUTPUT_FILE} from ${DATASET_FILE}\n`);
