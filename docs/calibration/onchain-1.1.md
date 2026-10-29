# On-chain calibration report (onchain-v2 mapping, artifact decision: keep 1.0.1)

Date: 2026-10-29. Mapping version `onchain-v2`. Seed 42 is the artifact
seed; seeds 7 and 1337 are variance runs reported separately. The holdout
was evaluated exactly once (seed 42 run); the seed 7/1337 runs pass
`--skip-holdout` and never touch it. Aggregate numbers only: no addresses,
codehashes, transaction hashes or per-token values appear here.

## Binary target

`bad=1` when the calibration label is `rug`, `scam` or `honeypot`;
`bad=0` when the label is `legit`. Rows labelled `unknown` are excluded
from train/test fits and reported separately (55 rows). This matches the
1.0.1 definition: unknown never trains a head.

## Split (identical to artifact 1.0.1)

Seed 42, 75/25 stratified grouped split by codehash, 27 holdout overlaps
and 4 within-set duplicates dropped. Kept 515 rows, fitted 460, unknown
55, holdout 39. Train 343 (legit 172, rug 96, honeypot 46, scam 29),
test 117 (legit 58, rug 33, honeypot 16, scam 10). Regularization per arm
comes from grouped 3-fold cross-validation inside train only (lambda grid
0.01/0.1/1.0, ties keep the larger lambda); test is never tuned on. Both
heads are constrained L2 logistic fits with a monotone Platt map:
risk-increasing columns clip at 0 from below, risk-decreasing columns
clip at 0 from above (new `nonPositive` support in the shared fitter).

## Part A bytecode fix and its effect

The capability detector and the domain sweep no longer attribute a CALL
occurrence through a positional fallback: only the paired function whose
body holds the occurrence is cited, and unattributable occurrences are
skipped. The changer is no longer the analysed address: it is the live
owner address behind the ownership proof, and ownerless code carries the
changerless `can-change-unknown` temporality. The nine binary calibration
features used below come from the owner-control detector plugins as
presence bits, which the fix does not change. Measured on this split,
frozen artifact 1.0.1 as-is scores test bad-AUC 0.556 (95 percent interval
0.49-0.62, Brier 0.274) and the retrained bytecode arm scores 0.565
(0.47-0.66, Brier 0.268): overlapping intervals, i.e. re-fit stability,
not a fix effect. The fix is user-facing honesty (no false changer
claims), not new discrimination.

## Snapshot join and validation

File top level `meta`/`calibration`/`real` keyed by address; offset 7200
from `meta.snapshotOffsetBlocks`. Strict per-row validation: 573 rows
parse, 12 fail (7 holder shares outside [0, 1], 5 deployer shares outside
[0, 1]; all extreme values on rows whose log-balance sum is also wild, so
treating them as fully missing is conservative and honest). 23 duplicate
rows (calibration/real overlap, first wins), 6 snapshot rows match no
calibration, holdout or unknown row. Offset violations: 0. Row presence
("matched") is not feature availability: unknown rows are all present but
only 6 of 55 carry usable snapshot sections.

Coverage (matched/missing rows): train 337/6, test 115/2, holdout 37/2,
unknown 55/0 present (6 usable).

## Leakage traps

(a) Missingness follows labels, so no status, reason, missingness
indicator, `pairIsMain`, `mainPairDex`, `afterFixtureBlock` or pair count
enters the vector, and there are no missing-indicator columns at all: a
missing value maps to 0, which contributes exactly zero to a linear head.
Proven by unit test (missing vector scores the bias; dropping a column
and its weight leaves the score unchanged). Univariate AUCs below use
only the subset where the feature is available.

(b) Drained LP: 76 calibration rows carry minimum-liquidity-only supply
(honeypot 50, legit 11, rug 12, scam 0, unknown 3; plus real rows for a
file total of 82), all with burnedShare 1.0. The drain is visible at the
snapshot block, so it is legitimate point-in-time signal, but burnedShare
1.0 there means drained, not locked: the mapping forces burnedShare to 0
and raises the affirmed `liquidity_removed_24h` flag instead. No
post-snapshot information enters.

(c) Holder figures are zeroed when `logBalanceSumOverSupply` deviates
from 1 beyond 0.10 (68 calibration rows: honeypot 6, legit 22, rug 29,
scam 11, unknown 0; file total 75). Cutoffs at 0.05/0.10/0.25 flag
93/78/62 file rows respectively; 0.10 is documented in the mapping.

(d) Era confounding: deployBlock alone scores train AUC 0.41 and test
0.35; snapshotBlock alone scores 0.45 and 0.37 (diagnostic only, never
features). Deploy-to-first-liquidity is capped at 216000 blocks (about
30 days); 126 calibration rows hit the cap (legit 119, unknown 5, rug 1,
scam 1, honeypot 0), i.e. the cap binds almost exclusively old legit
tokens, which limits but does not remove the era/behaviour confound in
that feature (see findings).

(e) Train/serve consistency: the artifact may only weight features whose
live computation matches the snapshot definition. Servable: the four
owner flags, the three LP shares, the drained flag and capped
deploy-to-first. Diagnostic-only: holder deployer/top-1/top-10 shares
(live excludes lockers and rebuilds balances from logs; snapshot counts
lockers and reads balances directly) and log liquidity (serving-side unit
normalisation pending). The serving path reads at "now", training at
first-liquidity plus 7200 blocks; a token analysed long after launch is
in a different regime than training rows.

## Coverage per feature (available/total, seed 42 split)

Train (343 rows: honeypot 46, legit 172, rug 96, scam 29):

- owner flags (shared availability): honeypot 16/46, legit 77/172, rug
  44/96, scam 13/29; bad=1 73/171, bad=0 77/172.
- lp_burned_share: honeypot 14/46, legit 79/172, rug 63/96, scam 28/29;
  bad=1 105/171, bad=0 79/172.
- lp_locker_share, lp_deployer_or_owner_share, liquidity_removed_24h:
  honeypot 45/46, legit 86/172, rug 72/96, scam 28/29; bad=1 145/171,
  bad=0 86/172.
- conc_deployer/top1/top10_share: honeypot 40/46, legit 134/172, rug
  57/96, scam 18/29; bad=1 115/171, bad=0 134/172.
- liq_log10_1p_weth, blocks_deploy_to_first_capped: honeypot 45/46,
  legit 154/172, rug 76/96, scam 28/29; bad=1 149/171, bad=0 154/172.

Test (117 rows: honeypot 16, legit 58, rug 33, scam 10):

- owner flags: honeypot 10/16, legit 25/58, rug 20/33, scam 7/10;
  bad=1 37/59, bad=0 25/58.
- lp_burned_share: honeypot 4/16, legit 23/58, rug 21/33, scam 9/10;
  bad=1 34/59, bad=0 23/58.
- lp_locker/deployer_or_owner/drained: honeypot 16/16, legit 27/58, rug
  24/33, scam 9/10; bad=1 49/59, bad=0 27/58.
- conc trio: honeypot 15/16, legit 44/58, rug 23/33, scam 8/10; bad=1
  46/59, bad=0 44/58.
- liq/blocks: honeypot 16/16, legit 51/58, rug 29/33, scam 9/10; bad=1
  54/59, bad=0 51/58.

Holdout (39 rows): lp_burned bad=1 9/17, bad=0 20/22; other features at
similar rates (see JSON). Unknown (55 rows): 6/55 usable per feature.

## Univariate AUC (available subset only)

Train then test: owner_renounced 0.63/0.60, owner_eoa 0.63/0.64,
owner_contract 0.42/0.45, owner_safe 0.33/0.31, lp_burned_share 0.51/0.53,
lp_locker_share 0.59/0.60, lp_deployer_or_owner_share 0.59/0.55,
liquidity_removed_24h 0.60/0.58, conc_deployer_share 0.75/0.67,
conc_top1_share 0.46/0.34, conc_top10_share 0.34/0.21,
liq_log10_1p_weth 0.37/0.45, blocks_deploy_to_first_capped 0.07/0.08.
Notes: safe/contract run below 0.5 (protective, against the shipped sign
prior; finding, not re-tuned), deploy-to-first is strongly directional
but confounded with era (d), top-10 concentration runs inverted.

## Ablation table (test AUC with bootstrap 95 percent CI, Brier)

Seed 42 (artifact seed; holdout evaluated once):

- bytecode: train 0.543, test 0.565 [0.47, 0.66], Brier 0.268, bands
  Low 11 / Elevated 106 / High 0 (diagnostic prob mapping), holdout
  0.707 (Brier 0.242).
- onchain (servable only): train 0.635, test 0.614 [0.51, 0.72],
  Brier 0.284, bands Low 0 / Elevated 105 / High 12, holdout 0.694
  (Brier 0.243).
- both: train 0.512, test 0.482 [0.43, 0.54], Brier 0.301, bands Low 0 /
  Elevated 105 / High 12, holdout 0.559 (Brier 0.229). Rug head
  uncalibrated (no monotone train signal in the combined space).

Seed 7 (no holdout): bytecode test 0.482 [0.37, 0.59] Brier 0.275;
onchain test 0.698 [0.62, 0.79] Brier 0.496 (saturated near-1.0
probabilities: ranking without calibration); both test 0.473 [0.41, 0.53]
Brier 0.530.

Seed 1337 (no holdout): bytecode test 0.476 [0.38, 0.57] Brier 0.271;
onchain test 0.599 [0.50, 0.70] Brier 0.290; both test 0.491 [0.44, 0.54]
Brier 0.513.

Per-class test score spread (seed 42, bad-probability mean, min-max):
bytecode bad=1 0.358 (0.26-0.41) vs bad=0 0.345 (0.26-0.39); onchain
bad=1 0.568 (0.53-1.0) vs bad=0 0.585 (0.53-1.0); both bad=1 0.430
(0.38-1.0) vs bad=0 0.453 (0.38-1.0). Class means are near-identical
within every arm: weak discrimination is not hidden. The production
1.0.1 fit puts all 117 test and all 39 holdout scores in 19-30 (Low
band), including known honeypots; a Low band from 1.0.1 is not evidence
of safety.

Train-only error analysis: bytecode arm has 0 false positives and 7
false negatives (bad rows score low: weak recall); onchain arm has 18
false positives (legit rows score high: saturated) and 0 false
negatives; both arm mirrors onchain (18/0, firing blacklist/ownership/
hooks). No test rows were inspected for tuning.

## Decision: keep 1.0.1, no new artifact

`both` does not beat `bytecode` on test on any seed (0.48-0.49 vs
0.48-0.57, CIs overlapping or worse), and the single holdout reading
does not contradict that (both 0.559 vs bytecode 0.707). `onchain` alone
ranks modestly better but its intervals overlap bytecode on seeds 42 and
1337, its probabilities are saturated/miscalibrated, its strongest
columns are era-confounded or diagnostic-only, and no serving path
consumes on-chain weights today. Writing a 1.1.0 artifact would therefore
change the default on noise. Artifact 1.0.1 stays the demo default
(`scripts/demo.ts`, `model/README.md` unchanged); 1.0.1 still verifies;
this report is the saved evaluation. Exact command:

```sh
export PATH="$HOME/.local/node22/bin:$PATH"
BK_CALIBRATION_DATASET=<calibration-tokens.json> \
BK_HOLDOUT_DATASET=<real-tokens.json> \
BK_ONCHAIN_SNAPSHOT=<onchain-snapshot.json> \
node --experimental-strip-types scripts/calibrate-real.ts \
--version 1.1.0-rc1 --seed 42 --data-version calibration-v1 \
--out-dir <scratch dir> --onchain-mode both
```

Variance seeds add `--skip-holdout --seed 7` (resp. 1337). All paths
stay outside the repo; the run writes only the scratch out-dir.

## Open risks and findings (not re-tuned after the holdout reading)

- Safe/contract owner flags look protective (univariate 0.31-0.45) but
  ship constrained risk-increasing; the prior needs revisiting on future
  train-only evidence.
- Unscaled blocks dominate the honey head (deploy-to-first weight about
  -2743 against 0/1 columns): features need standardization before any
  artifact fit.
- On-chain probabilities saturate (seed 7: every test prob rounds to
  1.0); ranking without calibration.
- Deploy-to-first-liquidity mixes behaviour with era even capped; the cap
  binds 119 legit against 2 bad rows.
- 12 extreme rows fail validation and score as missing; holder figures
  for 68 calibration rows are tolerance-zeroed.
- Live parity gaps (locker exclusions, balance sources, liquidity units)
  keep four features diagnostic-only until the serving path is aligned.
