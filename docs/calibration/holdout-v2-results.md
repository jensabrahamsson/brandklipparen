# Holdout-v2 results (evaluated once)

Protocol: [holdout-v2-protocol.md](holdout-v2-protocol.md). The model and decision rule were frozen on TRAIN/TEST first, then holdout-v2 was scored exactly once. Aggregate numbers only; no addresses, codehashes or bytecode.

## Frozen configuration

| Field | Value |
|---|---|
| Frozen config sha256 | `cac6c7ed0165082453d4adc0edbaccc429ccb69ccd943bf07c8b90188f332bf8` |
| Frozen from commit | `809a6e9` (clean tree) |
| Candidate model | 1.1.0-rc2 (on-chain 1.2 fixes, seed 42 artifact split, `--skip-holdout`) |
| Arms | bytecode, onchain, both |
| Positive class | bad = rug, scam or honeypot; legit = 0; unknown excluded from AUC, Brier and confusion |
| Decision rule | prob*100 through the frozen fitted bands (elevated 19, high 60); predicted bad = Elevated or High |
| AUC interval | bootstrap 95 percent, 1000 resamples |

No dataset-only columns that exist for legit rows alone in calibration (creation block, age, liquidity note, WETH in pools) are features; deploy and first-liquidity information comes from the snapshot only. V3 LP distribution counts as unavailable, matching calibration.

## Holdout-v2

248 tokens: legit 115, rug 67, honeypot 34, scam 20, unknown 12 (236 known). Zero address and codehash overlap with calibration; era-matched by deploy and first-liquidity year.

| Arm | AUC | 95% CI | Brier | Bands low/elevated/high | TP | FP | TN | FN |
|---|---|---|---|---|---|---|---|---|
| bytecode | 0.587 | 0.518-0.655 | 0.269 | 0/236/0 | 121 | 115 | 0 | 0 |
| onchain | 0.636 | 0.563-0.705 | 0.229 | 10/193/33 | 119 | 107 | 8 | 2 |
| both | 0.681 | 0.612-0.748 | 0.222 | 39/176/21 | 114 | 83 | 32 | 7 |

Unknown rows (12) land in Elevated on every arm.

For reference, the same candidate on TEST (seed 42): bytecode 0.565, onchain 0.703, both 0.707 (docs/calibration/onchain-1.2.md).

## Per-class coverage

| Class | Rows | Usable V2 on-chain snapshot | Holders | Scored (each arm) |
|---|---|---|---|---|
| legit | 115 | 55 | 41 | 115 |
| rug | 67 | 52 | 43 | 67 |
| honeypot | 34 | 34 | 32 | 34 |
| scam | 20 | 18 | 13 | 20 |
| unknown | 12 | 0 | 0 | 12 |

Rows without on-chain data are scored with missing features mapped to zero, the same as on TEST.

## Reading

- `both` is the best arm on holdout-v2 and its interval excludes chance; it generalizes close to its TEST level (0.707 to 0.681).
- Its interval overlaps the bytecode arm's (0.612-0.748 against 0.518-0.655), so the gain is likely but not clearly established.
- Coverage differs by class: 48 percent of legit rows have a usable V2 snapshot against 78-100 percent of the bad classes, mostly because V3-only legit tokens count as unavailable. With missing features mapped to zero, part of the on-chain lift can come from data availability rather than token behaviour. A subset analysis on holdout-v2 now would be post hoc, so it is not reported here.
- The frozen decision rule is weak: the bytecode arm calls every known row bad, and `both` reaches 94 percent sensitivity at 28 percent specificity.
- No serving path consumes on-chain weights yet, and training reads at first liquidity plus 7200 blocks while serving reads at the current block.

## Decision

Keep artifact 1.0.1 as the demo and serving default. The on-chain `both` candidate is promising but not clearly better once the overlapping intervals, the class-dependent coverage, the weak decision rule and the train/serve gap are taken into account. Next steps: availability-matched evaluation (a pre-registered rule for missing on-chain data, or V3 LP distribution in training), a decision rule chosen for specificity on TRAIN, and a serving path for on-chain features; then a fresh holdout.
