# Training dataset (K-201, S-017)

`dataset-synthetic-v1.json` is the committed fixture dataset for the MVP
path: six hand-assembled synthetic rows that satisfy the versioned dataset
schema validated by `src/domain/dataset.ts`. Every address, bytecode
sequence and block number is invented for tests; no row links to a real
contract and no number carries predictive meaning. Production rows arrive
through the versioned offline calibration chain per A-28 and K-210.

## Schema per datapoint

Each row carries `address`, `bytecode`, `blockNumber`, `source` and a
`label` under the policy in `docs/dataset-label-policy.md`, plus a pinned
`codeHash` derived from the bytecode with `CodeHash.of`. The parser derives
the hash again at the boundary and rejects a row whose carried hash
disagrees, so a copied row with a stale hash fails before training. Each
row lies inside the file `blockRange`. Named test
`k201_each_datapoint_has_address_bytecode_block_source` pins this shape.

## Licence

This fixture is authored in this repository and carries the same licence as
the project (see `LICENSE` at the repo root). No third-party source is
mixed into this file, so no external licence applies to it. Any future
dataset that mixes an outside source must record that source, its licence
and its terms beside the file before use (K-201).

## Refused source paths

Two outside paths were considered and refused for this change, so the
synthetic placeholder above stays the whole dataset for now:

- A hosted chain explorer API that needs a paid key was refused: fetching
  from it requires credentials, and this task forbids secrets and key-gated
  fetches.
- A commercial label feed without a published licence was refused: reuse
  needs documented terms, and none are published for it.

## Training input shape (S-019)

`src/domain/dataset.ts` rolls the labels up with `summarizeForTraining`
into per-risk positive and negative counts, which is the risk-outcome
section the freeze path in S-019 consumes. Severity, cause and share counts
for that path stay synthetic placeholders under
`tests/fixtures/artifact/` until the offline calibration chain lands.

## Changing this file

After editing any bytecode, re-derive the affected `codeHash` with
`CodeHash.of` and update the pinned value deliberately in the same change;
the k201 test turns red until the pin matches again.
