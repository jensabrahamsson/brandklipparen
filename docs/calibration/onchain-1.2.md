# On-chain calibration report 1.2 (onchain-v3 mapping, TRAIN/TEST only, no holdout)

Date: 2026-10-29. Mapping version `onchain-v3`. This run fixes the five
open issues from
[onchain-1.1](onchain-1.1.md)
on TRAIN/TEST only. Aggregate numbers only: no addresses, codehashes,
transaction hashes or per-token values appear here.

holdout not evaluated in this run; final evaluation on holdout-v2.

Artifact 1.0.1 stays the demo/serving default (`scripts/demo.ts`,
`model/README.md` and config defaults unchanged); no new artifact was
added to `model/`. A candidate fit plus a scaler sidecar were written to
a scratch out-dir outside the repo only.

## Split (identical to artifact 1.0.1 and to 1.1)

Seed 42, 75/25 stratified grouped split by codehash, 27 holdout overlaps
and 4 within-set duplicates dropped. Kept 515 rows, fitted 460, unknown
55. Train 343, test 117. The holdout file was read for the overlap
exclusion only, so the seed-42 train/test split stays identical; no
holdout row was scored. Seeds 7 and 1337 use the same pipeline with
`--skip-holdout` and their own 343/117 splits.

Snapshot join: train 337/6 matched/missing, test 115/2, unknown 55/0
present (6 usable), 12 invalid rows, 6 unmatched snapshot rows, 23
duplicate rows, 0 offset violations. Same as 1.1.

## What changed for each issue

### 1. Feature standardization

Continuous on-chain columns (the three LP shares) are standardized with
TRAIN-only mean/sd over the available subset per column; the fitted
params ship in a scaler sidecar beside the candidate artifact so serving
applies the same transform. Binary columns (four owner flags, drained
flag) pass through as 0/1. A missing value maps to 0 after scaling, so
it contributes exactly zero to a linear head. Unit-tested: TRAIN-only
fit, stored params on test/serve, missing-to-zero.

Seed-42 TRAIN scaler params: burned share mean 0.039 sd 0.191; locker
share mean 0.151 sd 0.352; deployer/owner share mean 0.156 sd 0.358.
(Seeds 7/1337 fit their own TRAIN params in the same ranges.)

### 2. Sign rules

Risk directions now live in one documented domain table
(`src/domain/onchain/signs.ts`), decided from what each feature means
and checked against TRAIN-only grouped-CV univariate evidence (3-fold,
grouped by codehash, inside train). Safe/multisig and contract owners
are protective: a quorum or coded logic constrains unilateral action, so
a multisig or contract owner is not the same risk as an EOA owner. No
sign was picked from test.

TRAIN-CV sign check (seed 42; seeds 7/1337 show the same pattern):

| feature | prior | TRAIN CV AUC | verdict |
|---|---|---|---|
| owner renounced | decreasing | 0.63 | mismatch, constraint kept |
| owner EOA | increasing | 0.62 | agrees |
| owner contract | decreasing | 0.42 | agrees |
| owner Safe | decreasing | 0.33 | agrees |
| burned share | decreasing | 0.51 | mismatch (neutral), constraint kept |
| locker share | decreasing | 0.59 | mismatch, constraint kept |
| deployer/owner share | increasing | 0.60 | agrees |
| drained flag | increasing | 0.60 | agrees |

Mismatches keep their domain constraint without relaxation: the fit pins
those weights at 0 rather than fitting noise (seed-42 both-arm weights:
renounced 0/0, locker 0/-0.14, burned rug 0; contract -0.61/-0.56, Safe
-1.09/-0.46, EOA small positive, deployer share +0.17/+0.59, drained
honeypot +2.46). The renounced mismatch (renounced owners skew bad on
train) is kept as a documented open question, not a sign flip.

### 3. Era signal

The blocks-from-deploy-to-first-liquidity feature is dropped from the
model. TRAIN-only evidence: grouped-CV AUC 0.06-0.07 across seeds
(extreme directionality for a behavioural story), while the cap binds
almost exclusively old legit tokens (1.1: 119 legit against 2 bad rows
at the cap). Pearson correlation with deployBlock on the TRAIN available
subset is weak linear (0.03-0.11); the cap pile-up makes the relation
nonlinear, so the low linear number does not exonerate it. The mapping
still computes the column and its univariate stays in the report as a
diagnostic; the era diagnostics (deployBlock alone: train 0.41, test
0.35; snapshotBlock alone: train 0.45, test 0.37 on seed 42) are kept.

### 4. Locker set alignment

One source of truth (`LOCKER_REGISTRY`): the snapshot-time lockers join
the registry with their public verifications, the snapshot mapping
recomputes the locker share from the per-locker breakdown through the
registry (unknown locker names never enter), and the live LP plugin
reads balances at exactly the registry addresses. A unit test proves
both sides derive from the registry: the mapping sums exactly the
registry locker names and the live plugin counts exactly the registry
locker addresses. Remaining caveat: factory-routed locks outside the
single documented Team Finance holder still land in otherShare on both
sides.

### 5. Probability saturation

Diagnosis: the unscaled blocks column (magnitude up to 216000) produced
weights near -2743, so logits saturated and seed 7 put every test
probability at 1.0 (ranking without calibration, Brier up to 0.53).
After dropping that column, standardizing the shares, and keeping
grouped-CV regularization inside TRAIN only (grid 0.01/0.1/1.0; both
onchain and combined arms chose 0.01 on all three seeds; bytecode stays
at its fixed 0.1), the largest fitted weight magnitude is about 2.5 and
no TEST probability sits above 0.99 or below 0.01 on any arm or seed
(see per-class spreads below). Brier falls to 0.21-0.22 on the
on-chain/combined arms.

The four diagnostic-only live-parity gaps that remain: holder deployer
share, holder top-1 share and holder top-10 share (live excludes lockers
and rebuilds balances from logs while the snapshot counts lockers and
reads balances directly) and log liquidity (serving-side unit
normalisation pending).

## Ablation tables (TEST only)

Test AUC with bootstrap 95 percent CI (1000 resamples), Brier, and band
distribution under the diagnostic prob-mapping. Previous 1.1 TEST
numbers beside the new ones.

Seed 42:

| arm | test AUC new | 95 percent CI | Brier new | bands L/E/H | test AUC 1.1 | Brier 1.1 |
|---|---|---|---|---|---|---|
| bytecode | 0.565 | 0.47-0.66 | 0.268 | 11/106/0 | 0.565 | 0.268 |
| onchain | 0.703 | 0.60-0.80 | 0.223 | 14/82/21 | 0.614 | 0.284 |
| both | 0.707 | 0.61-0.80 | 0.217 | 23/78/16 | 0.482 | 0.301 |

Seed 7:

| arm | test AUC new | 95 percent CI | Brier new | bands L/E/H | test AUC 1.1 | Brier 1.1 |
|---|---|---|---|---|---|---|
| bytecode | 0.482 | 0.37-0.59 | 0.275 | 13/104/0 | 0.482 | 0.275 |
| onchain | 0.706 | 0.61-0.80 | 0.210 | 11/91/15 | 0.698 | 0.496 |
| both | 0.658 | 0.55-0.75 | 0.220 | 21/78/18 | 0.473 | 0.530 |

Seed 1337:

| arm | test AUC new | 95 percent CI | Brier new | bands L/E/H | test AUC 1.1 | Brier 1.1 |
|---|---|---|---|---|---|---|
| bytecode | 0.476 | 0.38-0.57 | 0.271 | 9/108/0 | 0.476 | 0.271 |
| onchain | 0.752 | 0.67-0.83 | 0.215 | 15/85/17 | 0.599 | 0.290 |
| both | 0.745 | 0.65-0.82 | 0.207 | 18/85/14 | 0.491 | 0.513 |

Train AUCs (new): seed 42 bytecode 0.543 / onchain 0.727 / both 0.770;
seed 7 0.565 / 0.688 / 0.764; seed 1337 0.564 / 0.712 / 0.756.

The bytecode arm reproduces 1.1 exactly (same path, untouched). The
frozen 1.0.1 artifact as-is on the seed-42 split scores 0.556
(0.49-0.62, Brier 0.274), matching 1.1.

## Per-class TEST score spread (bad probability)

Mean, min, quartiles, max, and the saturation shares above 0.99 and
below 0.01. Saturation shares are 0/0 in every row: no TEST probability
saturates on any arm or seed (1.1 had seed 7 onchain at all-1.0).

Seed 42, bad=1:

| arm | mean | min | p25 | p50 | p75 | max |
|---|---|---|---|---|---|---|
| bytecode | 0.36 | 0.26 | 0.35 | 0.35 | 0.37 | 0.41 |
| onchain | 0.46 | 0.07 | 0.34 | 0.40 | 0.65 | 0.68 |
| both | 0.48 | 0.09 | 0.36 | 0.44 | 0.65 | 0.80 |

Seed 42, bad=0:

| arm | mean | min | p25 | p50 | p75 | max |
|---|---|---|---|---|---|---|
| bytecode | 0.34 | 0.26 | 0.35 | 0.35 | 0.37 | 0.39 |
| onchain | 0.33 | 0.07 | 0.34 | 0.37 | 0.37 | 0.68 |
| both | 0.32 | 0.02 | 0.16 | 0.36 | 0.44 | 0.77 |

Seed 7, bad=1: bytecode 0.35 (0.29-0.41); onchain 0.47
(0.36-0.71); both 0.48 (0.25-0.89). Seed 7, bad=0: bytecode 0.34
(0.29-0.40); onchain 0.33 (0.09-0.52); both 0.34 (0.03-0.61).
Seed 1337, bad=1: bytecode 0.35 (0.27-0.41); onchain 0.45
(0.35-0.64); both 0.49 (0.13-0.87). Seed 1337, bad=0: bytecode 0.35
(0.27-0.41); onchain 0.32 (0.11-0.62); both 0.33 (0.03-0.57).
Class means stay close within the bytecode arm (weak discrimination)
and separate modestly in the onchain/combined arms.

## Train-only error analysis (aggregate, never per-token)

False positives are legit TRAIN rows at/above the applied high band;
false negatives are bad TRAIN rows below the applied elevated band.

- Bytecode: 0 FP on all seeds; FN 7 (seed 42), 6 (seed 7), 8 (seed
  1337): weak recall, same as 1.1.
- Onchain seed 42: 6 FP leaning on EOA owners, drained flags and
  deployer-held LP; 3 FN leaning on contract/Safe owners (the
  protective constraint holds). Seeds 7/1337: 8/7 FP with the same
  pattern; 4/6 FN, again contract/Safe owners.
- Both seed 42: 4 FP (detector firings plus deployer LP); 11 FN mixing
  detector silence with protective owners. Seeds 7/1337: 3/3 FP, 15/14
  FN with the same mix.

No test rows were inspected for tuning.

## Verdict on this run (TEST only)

`both` beats `bytecode` on point test-AUC on all three seeds (42:
0.707 vs 0.565; 7: 0.658 vs 0.482; 1337: 0.745 vs 0.476), with better
Brier everywhere (0.21-0.22 vs 0.27). The intervals still overlap on
seeds 42 and 7 and separate only on 1337, so this is not a tuned claim:
nothing was tuned toward it, and the final judgement waits for
holdout-v2. holdout not evaluated in this run; final evaluation on
holdout-v2.

## Exact commands (paths as placeholders)

```sh
export PATH="$HOME/.local/node22/bin:$PATH"
BK_CALIBRATION_DATASET=<calibration-tokens.json> \
BK_HOLDOUT_DATASET=<real-tokens.json> \
BK_ONCHAIN_SNAPSHOT=<onchain-snapshot.json> \
node --experimental-strip-types scripts/calibrate-real.ts \
--version 1.1.0-rc2 --seed 42 --data-version calibration-v1 \
--out-dir <scratch dir> --onchain-mode both --skip-holdout
```

Seeds 7 and 1337 replace `--seed 42` with `--seed 7` (resp. 1337) and
their own scratch out-dir. Every run passes `--skip-holdout`: no holdout
scores, AUCs, Brier values or band counts are computed, printed or
written anywhere (the holdout file feeds the overlap exclusion only, so
the seed-42 split stays identical; a unit test proves no holdout row
reaches scoring in skip mode). All paths stay outside the repo; each run
writes only its scratch out-dir (candidate artifact plus the
`onchain-scaler-<version>.json` sidecar).

## Follow-ups for holdout-v2 and serving

- Final evaluation on holdout-v2 decides whether any candidate ships;
  1.0.1 stays default until then.
- The renounced-owner mismatch (protective prior vs bad-leaning train)
  needs its own investigation, not a sign flip.
- Locker holdings outside the single documented Team Finance holder
  stay otherShare; a serving inventory of factory-routed locks would
  tighten both sides.
- The four diagnostic-only gaps (holder shares, liquidity units) need
  serving-path alignment before those features can carry weight.
- Train/serve regime gap stands: serving reads at now, training at
  first-liquidity plus 7200 blocks.
