// Child-process runner for k211_retraining_reproduces_artifact_bit_identical.
// Reads a training dataset path and a model version from argv, runs the pure
// domain freeze (train plus canonical serialization plus checksum) and
// writes the frozen artifact bytes to stdout. This runner lives in the test
// layer: src/domain holds no process access.
import { readFileSync } from "node:fs";
import { freezeArtifactFile, trainArtifact } from "../../src/domain/artifact.ts";
import { ModelVersion } from "../../src/domain/types.ts";

const datasetPath = process.argv[2];
const versionRaw = process.argv[3];
if (datasetPath === undefined || datasetPath.length === 0 || versionRaw === undefined || versionRaw.length === 0) {
  process.stderr.write("usage: k211-run-freeze <dataset-path> <model-version>\n");
  process.exit(1);
}
const version = ModelVersion.parse(versionRaw);
if (!version.ok) {
  process.stderr.write(`invalid model version: ${versionRaw}\n`);
  process.exit(1);
}
const dataset = JSON.parse(readFileSync(datasetPath, "utf8")) as unknown;
const trained = trainArtifact(dataset, version.value);
if (!trained.ok) {
  process.stderr.write(`training failed: ${trained.error.message}\n`);
  process.exit(1);
}
const frozen = freezeArtifactFile(trained.value);
if (!frozen.ok) {
  process.stderr.write(`freeze failed: ${frozen.error.message}\n`);
  process.exit(1);
}
process.stdout.write(frozen.value);
