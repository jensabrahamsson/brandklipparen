# Own EVM decompiler: worked example

This page shows one emission of the deterministic ERC-20 decompiler
(`src/domain/evmLift.ts`, `src/domain/evmFlow.ts`,
`src/domain/evmNames.ts`, `src/domain/evmSsa.ts`). The unit test
`k524_three_published_case_fixtures_render_expected_pseudo_solidity_and_docs_snippet`
requires the block below to match the transfer fixture emission byte
for byte: if the emitter changes, this page changes in the same
review, or the suite turns red.

The fixture is a hand-assembled transfer-like body: it loads two
calldata words, guards on the sender, reads a storage slot and writes
it back guarded. The emission names the function from its published
selector, annotates the guarded state update, and labels the missing
plain return with its cause instead of inventing one.

```solidity
function transfer(address arg0, uint256 arg1) /* selector 0xa9059cbb */ {
  // token-pattern: guarded-state-update
  require((calldata[0x00] == msg.sender));
  storage[0x01] = (storage[0x01] + calldata[0x02]);
  // cause: no-plain-return (body carries no plain return info)
}
```

Reading the emission: `calldata[0x00]` is the first calldata word,
`require` is a dominating `JUMPI` guard, and the `storage[0x01]`
assignment reads the slot back on its right-hand side. Every line maps
to the exact `[startPc, endPc)` range it was lifted from; the
structured function value carries those ranges per statement.

## Differential eval: results format and metrics

The dev/eval-only harness (`scripts/eval-decompiler.ts`, S-082, D-09,
D-10) compares the own pipeline against extdecomp on the frozen ERC-20
corpus (`tests/fixtures/evm/corpus/`). It runs only on local bytecode:
the binary named by `extdecomp_BIN` is invoked as
`extdecomp decompile <hex-or-file>` with `HOME` set to a fresh temp dir,
`extdecomp --version` is checked against the pinned expected `0.9.1`
(a mismatch fails the eval and installs nothing), and no `-r`, RPC
URL, address, LLM or naming flag may appear in the invocation. Without
`extdecomp_BIN` the harness evaluates the own pipeline, marks every
extdecomp column `not-run`, and exits 0, so the runtime suite stays
green with the variable unset and CI never runs extdecomp.

### Per-contract results format

One row per corpus contract, for both decompilers:

| Field | Meaning |
|---|---|
| `id` | Corpus contract id (for example `token-simple`) |
| `ownFunctions` / `expectedFunctions` | Emitted function count versus the corpus ground truth |
| `entriesMatch` | Every emitted entry agrees on selector, name, entry PC and cause |
| `patternsMatch` | Every expected token pattern appears in the emission |
| `spotAgreed` / `spotTotal` | Golden text fragments present exactly as expected |
| `ownUnresolved` | Unresolved-jump count (lower is better; a guess counts as an error) |
| `offsetCoverage` | Share of emitted statements carrying an exact `[startPc, endPc)` range (target 100%) |
| `passed` | `entriesMatch` and `patternsMatch` and full spot agreement and 100% offset coverage |
| `extdecomp` | `not-run`, or `ok` with the reported version and mentioned selectors, or `failed` with version and input digest |

The summary totals the contracts, the pass rate, the spot agreement
(the frozen corpus expects `ownPassRate` 100 and `spotAgreement` 100),
the extdecomp run count, the K-523 published-selector table coverage and
an opcode profile, plus a `consistent` flag proving the evaluated set
is exactly the frozen corpus in order.

### The four metrics

| # | Metric | Decided by |
|---|---|---|
| 1 | Correct CFG / function boundaries | `entriesMatch`: dispatcher selector entries against the corpus ground truth |
| 2 | Fewer unresolved jumps | `ownUnresolved` versus extdecomp's count; a guessed target counts as an error, never as resolved |
| 3 | Readable pseudo-Solidity for token patterns | `patternsMatch` plus spot checks on the golden readable shapes (transfer guard, allowance check, mint/burn, pause flag, owner gate) |
| 4 | Evidence mapped to exact bytecode offsets | `offsetCoverage` at 100% by construction; any item without a range fails the contract |

The own pipeline wins a contract when it is at least as good on every
metric and strictly better on at least one; the epic wins when it wins
the median corpus contract without losing any metric on more than a
stated minority of contracts. An unresolved jump the own pipeline
labels and extdecomp guesses counts in the own pipeline's favour only
when the guess is wrong against ground truth.

### Runtime consumption

The pipeline ships as the detector plugin
`dev.brandklipparen.decompiler` (S-081, D-07, D-08): one finding per
decompiled function with selector and entry-PC evidence, the exact
`[startPc, endPc)` range, token-pattern annotations, cause label and
contract-wide unresolved-jump count in the payload. The shared service
carries it in `pluginResults`, so the REST, MCP and Expert UI surfaces
consume the same functions, offsets and unresolved-jump count; findings
stay at weight 0 until the calibration artifact names the plugin
(S-085). Suggested display names arrive only through the optional
naming overlay (S-083, D-11): opt-in, validated whole, display-only,
never an analysis input.

## Local eval run (28/10)

Reran after the output-file fix with `extdecomp_BIN` set: the binary
reported `extdecomp 0.9.1` (matches the pinned version), every invocation
ran as `decompile <local-hex-file>` with its working directory set to a
fresh temp dir (and `HOME` set to a second fresh temp dir), the harness
read the generated files from under each work dir's `output/` directory
besides stdout, both temp dirs were deleted afterwards, and no RPC,
address, LLM or naming flag appeared. Nothing was written into the repo.
Exit code 0.

| Contract | Own functions | Entries | Patterns | Spot | Own unresolved | extdecomp |
|---|---|---|---|---|---|---|
| edge-fallback | 0/0 | match | match | 0/0 | 0 | ok, 0 selectors mentioned |
| edge-invalid | 1/1 | match | match | 2/2 | 1 | ok, 0 selectors mentioned |
| token-allowance | 4/4 | match | match | 4/4 | 0 | ok, 0 selectors mentioned |
| token-pausable | 2/2 | match | match | 3/3 | 0 | ok, 0 selectors mentioned |
| token-simple | 2/2 | match | match | 4/4 | 0 | ok, 0 selectors mentioned |

Summary: own pass rate 100% (5/5 contracts), spot agreement 13/13,
offset coverage 100% by construction, 5 extdecomp runs completed. The
extdecomp runs exited 0 but mentioned none of the expected selectors in
their output files or stdout (each run wrote only an empty
`output/local/abi.json` for these hand-assembled fixtures), so metric 2
(fewer unresolved jumps) is recorded, not decided, on this run. Full
output lives in `docs/eval-decompiler-results.md`.
