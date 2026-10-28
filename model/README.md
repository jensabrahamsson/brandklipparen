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

## Calibrated artifact 1.0.1 (current default, real calibration)

`artifact-1.0.1.json` is the documented default artifact: per-plugin
per-head detector weights fitted on the labeled calibration set (outside
the repo) with stratified grouped 75/25 split, seed 42, sample weights by
label strength, L2 logistic regression with a non-negative constraint on
risk-increasing detectors, and a monotone (slope at least 0) Platt map per
head. Slot-linked detector proofs keep each detector on its own
behavioural evidence. Bot-pump keeps prior parameters and is marked
uncalibrated; the fitted bands are diagnostics while product surfaces
apply 30/60. Reproduce with paths outside the repo only:

```sh
BK_CALIBRATION_DATASET=$BK_CALIBRATION_DATASET BK_HOLDOUT_DATASET=$BK_HOLDOUT_DATASET node --experimental-strip-types scripts/calibrate-real.ts --version 1.0.1 --seed 42 --data-version calibration-v1
```

See `model-card-1.0.1.json` and `evaluation-1.0.1.json` for aggregate
metrics (no per-token data). The smoke harness defaults to 1.0.1
(`BK_SMOKE_MODEL_VERSION` overrides).

## Prior artifact 0.1.0-prior.1 (S-115)

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

## Known limitations of 1.0.1

- Discrimination is near chance: test bad-versus-legit ROC AUC 0.56 (bootstrap 95 percent interval 0.49 to 0.62), rug-pull head 0.50, honeypot head 0.68; holdout bad AUC 0.59. Brier score (bad) 0.27 on test.
- All test, holdout and unknown scores fall between 19 and 30. Under the applied 30/60 bands every token is shown as Low, including known honeypots. A Low band from this artifact is not evidence of safety.
- Only the ownership detector carries signal on its own in the TRAIN ablation. Pause and fee recall is low by design (unproven writers stay silent).
- Labels are noisy: the rule-based scam set is the weakest label, some rug labels are honeypots, and legit means token-list membership, not an audit.
- Bytecode cannot see owner status, liquidity locks, holder concentration or token age. These are the next planned features.

