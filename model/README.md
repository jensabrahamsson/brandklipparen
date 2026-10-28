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

`model-card-<version>.json` is the versioned model card (K-208): artifact
checksum and version, data version, split methods and versions, metric
values per class and split, and the documented limits of the synthetic and
placeholder calibration. `evaluation-<version>.json` carries the same card
beside the split ratios the metrics were computed with. Both files are
generated offline with `npm run evaluate-metrics` from the frozen artifact
in this directory and the synthetic labelled dataset in
`offline/data`, with no network reads. Re-running that command reproduces
both files byte for byte. The implementation lives in the pure domain
modules `src/domain/metrics.ts` and `src/domain/modelCard.ts`; file input
and output stay in `scripts/evaluate-metrics.ts`.

## Prior artifact 0.1.0-prior.1 (current default, S-115)

`artifact-0.1.0-prior.1.json` is the documented default artifact: same
synthetic placeholder counts as `0.0.0-synthetic.1` with principled but
uncalibrated prior weights for the nine owner-control detectors overlaid
from `priors-0.1.0-prior.1.json`. The priors are domain reasoning, never
fitted to data: mint and sell-block at 1.0, blacklist and proxy-upgrade
at 0.9, pause at 0.8, transfer-hooks at 0.7, transfer-fee at 0.6,
transfer-limits at 0.5, ownership at 0.4, each mapped to the risk family
its capability enables (supply inflation to rug-pull, trade gating to
honeypot). The full table with rationale lives in
`docs/decisions/log.md` (2026-10-28). The card for this version carries
the `prior-weights-uncalibrated-v1` method and an explicit prior-weights
limitation: the score moves on bytecode while no measured calibration
backs the numbers.

Reproduce it with:

```sh
node --experimental-strip-types scripts/freeze-artifact.ts --version 0.1.0-prior.1 --priors model/priors-0.1.0-prior.1.json
node --experimental-strip-types scripts/evaluate-metrics.ts --artifact-version 0.1.0-prior.1 --calibration-method prior-weights-uncalibrated-v1
```

Calibration readiness: both scripts consume a labeled calibration file
through `--dataset <path>` (or `BK_CALIBRATION_DATASET`, never a default
path inside the repo) with per-row `labelBasis` weighting
(`--basis-weights` or `BK_BASIS_WEIGHTS`, defaults 3/2/1 for dataset,
incident report and token list). A JSON array is read as calibration rows and
converted through `src/domain/calibrationRows.ts` under the provisional
label policy `0.1.0-provisional`. Row-derived freezes still require at
least one positive per risk; the category map covers no bot-pump
positive yet, so freezing on the real file fails loudly until the policy
covers that family. Evaluation on rows works today with weighted
replication. No script here ever reads real tokens: verification used a
tiny synthetic fixture only.
