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

## Internal eval: results format and metrics

The dev/eval-only harness (`scripts/eval-decompiler.ts`, S-082, D-09
as retired by the Decision update in `docs/adr-evm-decompiler.md`)
evaluates the internal pipeline on the frozen ERC-20 corpus
(`tests/fixtures/evm/corpus/`). It reads solely the corpus files in
the repo with no external binary, process, or home directory on the
path, and exits nonzero when the pass rate or spot agreement leaves
its tolerance band.

### Per-contract results format

One row per corpus contract:

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

The summary totals the contracts, the pass rate, the spot agreement
(the frozen corpus expects `ownPassRate` 100 and `spotAgreement` 100),
the K-523 published-selector table coverage and
an opcode profile, plus a `consistent` flag proving the evaluated set
is exactly the frozen corpus in order.

### The four metrics

| # | Metric | Decided by |
|---|---|---|
| 1 | Correct CFG / function boundaries | `entriesMatch`: dispatcher selector entries against the corpus ground truth |
| 2 | Fewer unresolved jumps | `ownUnresolved`: the engine's unresolved-jump count; a guessed target counts as an error, never as resolved |
| 3 | Readable pseudo-Solidity for token patterns | `patternsMatch` plus spot checks on the golden readable shapes (transfer guard, allowance check, mint/burn, pause flag, owner gate) |
| 4 | Evidence mapped to exact bytecode offsets | `offsetCoverage` at 100% by construction; any item without a range fails the contract |

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

Historical record: this run compared the pipeline against an external
comparison tool that is no longer part of the product (see the note in
`docs/eval-decompiler-results.md`). The table below states the
internal pipeline's own numbers from that run; nothing was written
into the repo. Exit code 0.

| Contract | Own functions | Entries | Patterns | Spot | Own unresolved |
|---|---|---|---|---|---|
| edge-fallback | 0/0 | match | match | 0/0 | 0 |
| edge-invalid | 1/1 | match | match | 2/2 | 1 |
| token-allowance | 4/4 | match | match | 4/4 | 0 |
| token-pausable | 2/2 | match | match | 3/3 | 0 |
| token-simple | 2/2 | match | match | 4/4 | 0 |

Summary: own pass rate 100% (5/5 contracts), spot agreement 13/13,
offset coverage 100% by construction. The hand-assembled fixtures
dispatch on a minimal stack pattern with no calldata-load plus shift
preamble. No larger fixtures added: the repo holds no tiny Solidity
sources to compile locally, and network fetches plus real addresses
are out of scope.

Per-metric state on this corpus: M1 functions own N; M2 unresolved
own counts (0, 1, 0, 0, 0, labelled never guessed); M3 readability own
patterns plus spot; M4 offsets own 100% exact ranges. Full output
lives in `docs/eval-decompiler-results.md`.
