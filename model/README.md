# Versioned calibration artifact

`artifact-<version>.json` is the frozen, checksummed calibration artifact
(A-20, K-211): it carries the calibration model, detection thresholds,
weights and limits plus the training data version and the locked seed, with
a SHA-256 checksum over the artifact's canonical JSON form. The core loads
solely artifacts with a correct checksum through `ModelArtifactPort`, and
every response states the model version and the artifact checksum.

The current file is the synthetic placeholder for tests and the demo: small
hand-picked counts with no predictive meaning, frozen from
`tests/fixtures/artifact/synthetic-dataset-v1.json` with
`npm run freeze-artifact`. Re-running that command reproduces the file byte
for byte. Production values arrive through the versioned offline
calibration chain per A-28 and K-210.
