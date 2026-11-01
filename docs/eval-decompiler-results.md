# Decompiler differential eval: own pipeline versus extdecomp

> Historical record: past runs compared the internal pipeline against an external comparison tool; that tool is no longer part of the product.

Corpus contracts: 5. Own pass rate: 100.0% (expected 100 ± 3).
Spot agreement: 13/13 (100.0%, expected 100 ± 3).
extdecomp runs: 5 (binary extdecomp 0.9.1).
extdecomp method: each run used a fresh temp work dir (HOME a second fresh temp dir); stdout plus files under the work dir output/ parsed; both temp dirs deleted; nothing written into the repo.

| Contract | Own functions | Entries match | Patterns match | Spot | Unresolved | extdecomp |
|---|---|---|---|---|---|---|
| edge-fallback | 0/0 | true | true | 0/0 | 0 | ok (0 selectors, extdecomp 0.9.1) |
| edge-invalid | 1/1 | true | true | 2/2 | 1 | ok (0 selectors, extdecomp 0.9.1) |
| token-allowance | 4/4 | true | true | 4/4 | 0 | ok (0 selectors, extdecomp 0.9.1) |
| token-pausable | 2/2 | true | true | 3/3 | 0 | ok (0 selectors, extdecomp 0.9.1) |
| token-simple | 2/2 | true | true | 4/4 | 0 | ok (0 selectors, extdecomp 0.9.1) |

## K-523 published-selector coverage

| Selector | Contracts | Table hit |
|---|---|---|
| 0x095ea7b3 | token-allowance | true |
| 0x23b872dd | token-allowance | true |
| 0x70a08231 | token-pausable, token-simple | true |
| 0xa9059cbb | edge-invalid, token-allowance, token-pausable, token-simple | true |

## Opcode profile across the corpus

PUSH1 63, DUP1 29, JUMPDEST 24, PUSH2 20, JUMPI 19, REVERT 15, CALLDATALOAD 15, EQ 13, MSTORE 9, PUSH4 9, SLOAD 7, ISZERO 6, SSTORE 6, CALLVALUE 5, POP 5, CALLER 4, ADD 4, STOP 4, RETURN 4, JUMP 1

## Per-metric comparison (honest, 28/10 rerun)

Parser after the fix: each invocation runs as
`decompile <local-hex-file> --include-sol` (local-output flag only, no
RPC, address, LLM or naming flag), with cwd set to a fresh temp dir and
`HOME` set to a second fresh temp dir. Selector matching runs over
stdout plus every file under the work-dir `output/` directory,
case-insensitive, with and without the `0x` prefix, so it covers
`@custom:selector 0x...` lines in `decompiled.sol`, bare hex in `.yul`
output, and `Unresolved_<bare>` function names (`abi.json` alone
carries names without hex). A fake-runner unit test with a recorded
synthetic sample shaped like real extdecomp 0.9.1 output locks this in,
and a control run against a realistic Paris (pre-PUSH0) solc runtime
confirms the parser counts 4 functions when extdecomp actually finds
them.

Outcome on the frozen synthetic corpus: extdecomp genuinely finds
nothing. Every run exits 0 but logs `discovered no function selectors`
with a stack-underflow trace; the default output is an empty
`output/local/abi.json`, and with `--include-sol` a fallback-only
`decompiled.sol` with a single unresolved entry and none of the
expected selectors in any form. Cause: the hand-assembled fixtures
dispatch on a minimal stack pattern with no calldata-load plus shift
preamble, which the extdecomp tracer does not recognise as a
dispatcher. No larger fixtures added: the repo holds no tiny Solidity
sources to compile locally, and network fetches plus real addresses are
out of scope.

| Contract | M1 functions (own / extdecomp) | M2 unresolved (own / extdecomp) | M3 readability (own / extdecomp) | M4 offsets (own / extdecomp) |
|---|---|---|---|---|
| edge-fallback | 0 / 0 mentioned | 0 / not reported | match / fallback-only, no patterns | 100% / no PC ranges |
| edge-invalid | 1 / 0 mentioned | 1 labelled / not reported | 2/2 spot / fallback-only | 100% / no PC ranges |
| token-allowance | 4 / 0 mentioned | 0 / not reported | match, 4/4 spot / fallback-only | 100% / no PC ranges |
| token-pausable | 2 / 0 mentioned | 0 / not reported | match, 3/3 spot / fallback-only | 100% / no PC ranges |
| token-simple | 2 / 0 mentioned | 0 / not reported | match, 4/4 spot / fallback-only | 100% / no PC ranges |

Metric 2 is recorded, not decided, on this corpus: the own pipeline
labels unresolved jumps and never guesses, while extdecomp emits no jump
counts to compare. Metric 4 favours the own pipeline by construction
(exact ranges per statement) against extdecomp's selector annotations
with no PC ranges.

