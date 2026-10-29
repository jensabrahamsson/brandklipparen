# Holdout-v2 protocol: freeze first, evaluate once

Status: the model and decision rule are NOT yet frozen and holdout-v2 is
NOT yet evaluated. This file records the procedure only. No holdout-v2
numbers appear here; the operator runs the evaluation exactly once, after
the freeze, and records the outcome separately.

## What holdout-v2 is

A fresh holdout of 248 tokens (legit 115, rug 67, honeypot 34, scam 20,
unknown 12) held as two private files outside the repo. It is evaluated
EXACTLY ONCE by the operator, after the model and decision rule are
frozen. Building and testing of this path used SYNTHETIC fixtures only;
no real holdout-v2 file was opened, read, parsed, hashed or run.

## Input formats

Dataset rows carry the same record format as the calibration dataset
(address, symbol, name, label, labelSource, labelBasis, datasetName,
labelNote, block, codehash, bytecode, implementation, features,
featuresNote, plus `datasetSplit: "holdout-v2"`).

The on-chain snapshot keeps the same structure and method as the
calibration snapshot: `meta` plus ONE section named `holdout`, keyed by
address. `meta.lockers` holds 7 lockers (UNCX V2, three UNCX V3, Team
Finance, PinkLock v1 and v2).

Two comparability rules:

- LP-distribution-derived features use only `lpDistribution.dex == "v2"`.
  A V3 value reads as unavailable, the same as in calibration, where
  V3-only tokens arrive unavailable. The venue filter lives in
  `src/domain/onchain/snapshot.ts` (`lpIsV2`, the mapping and the
  availability check); a file without the venue field keeps working and
  counts as v2.
- Leakage rule (hard): in the calibration dataset only legit rows carry
  the four extra columns, and those four columns must NEVER be features,
  filters, imputation inputs or decision inputs anywhere. The snapshot
  deployBlock and firstLiquidityBlock are used instead. A test builds
  features from two synthetic rows that differ ONLY in those four columns
  and asserts identical feature vectors and scores, plus a static check
  that the feature code never names those columns.

## Positive class and unknown handling

Identical to the TEST metrics in onchain-1.2.md:

- Positive class: bad = 1 when the label is rug, scam or honeypot;
  bad = 0 when legit. Stated in every frozen config and every metrics
  file.
- Unknown handling: unknown rows are excluded from the AUC, Brier and
  confusion denominators. They are reported separately with band
  distribution and coverage only, never scored into the headline metrics.

## Step 1: freeze

Run the calibration with `--skip-holdout` and add `--freeze <path>` (or
reuse an existing candidate artifact output by re-running the same command
with `--freeze` added; the run is deterministic). The freeze needs the
snapshot so all three ablations (bytecode, onchain, both) are fitted:

```sh
export PATH="$HOME/.local/node22/bin:$PATH"
BK_CALIBRATION_DATASET=<calibration-tokens.json> \
BK_HOLDOUT_DATASET=<real-tokens.json> \
BK_ONCHAIN_SNAPSHOT=<onchain-snapshot.json> \
node --experimental-strip-types scripts/calibrate-real.ts \
--version 1.1.0-rc2 --seed 42 --data-version calibration-v1 \
--out-dir <scratch-dir> --onchain-mode both --skip-holdout \
--freeze <frozen-config>.json
```

The frozen config holds everything scoring needs and nothing else is
fitted afterwards: the three ablation fits (weights, biases, Platt slope
and intercept, uncalibrated flags), the TRAIN-only scaler params, the
sign rules, the locker list used for the features, the regularization
choice (grid and selection rule), the band thresholds with the decision
rule, the seed, the git commit, and the sha256 of the calibration
dataset and snapshot files.

The script prints the frozen config sha256 (canonical JSON) to stderr,
for example `freeze: sha256 <hash>`. Record that hash: the evaluation
refuses to run when `--expect-sha256` disagrees with the frozen file.

Hash construction: the frozen object is serialized with the shared
canonical JSON (`canonicalSerialize`: sorted keys, stable arrays), and
sha256 runs over those canonical bytes. The file itself holds exactly
those canonical bytes, so the sha256 of the file and the printed hash
agree. Two freezes with the same inputs give the same hash.

Artifact 1.0.1 stays the serving and demo default; the freeze writes
only the given path and the usual scratch out-dir.

## Step 2: evaluate once

```sh
export PATH="$HOME/.local/node22/bin:$PATH"
node --experimental-strip-types scripts/evaluate-holdout-v2.ts \
--frozen <frozen-config>.json --expect-sha256 <hash> \
--dataset <holdout-v2-dataset>.json \
--onchain-snapshot <holdout-v2-snapshot>.json \
--out-dir <empty-results-dir>
```

`--frozen` takes one file with all three ablations, or three files that
merge positionally (first bytecode, second onchain, third both) after a
metadata consistency check. `--dataset` also reads
`BK_HOLDOUT_V2_DATASET`; `--onchain-snapshot` also reads
`BK_HOLDOUT_V2_SNAPSHOT`. The script never fits, tunes or re-thresholds:
it loads the frozen config and scores.

Exactly-once guard: the run writes
`<out-dir>/HOLDOUT-V2-EVALUATED.json` (timestamp, frozen hash, input
file sha256s) BEFORE the results file, and refuses to run when that
marker exists. Keep the marker; a second run must fail.

Outputs per ablation (bytecode, onchain, both), aggregate numbers only:

- AUC with bootstrap 95 percent CI (1000 resamples, seeded LCG, same
  construction and seed rule as the TEST metrics), Brier, band
  distribution under the frozen bands, and confusion at the frozen
  decision rule (predicted bad is Elevated or High, that is prob*100 at
  or above the frozen elevated cutoff).
- Per-class coverage for each class (legit, rug, honeypot, scam,
  unknown): rows, rows with a usable snapshot, rows with lpDistribution
  v2, rows with holders, and rows actually scored per ablation. Every
  row is scored (a missing input maps to the neutral zero and still
  emits a probability), so the scored counts equal the row counts and
  prove nothing was silently dropped.

No addresses, codehashes or bytecode are printed or written anywhere;
stdout and both output files carry counts and metrics only.

## Tests

`tests/unit/onchain/holdoutV2.test.ts` (synthetic fixtures only):
holdout-section parsing, the v2-only LP filter (v2 counts, v3 reads
unavailable, absent counts as v2, unknown venue fails), the leakage
identical-vectors/scores test with the static column-name check, frozen
hash determinism and single-byte sensitivity, the hand-computed AUC /
Brier / bands / confusion example, and the script-level hash-mismatch
and exactly-once refusal runs.
