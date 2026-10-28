# Decompiler differential eval: own pipeline versus extdecomp

Corpus contracts: 5. Own pass rate: 100.0% (expected 100 ± 3).
Spot agreement: 13/13 (100.0%, expected 100 ± 3).
extdecomp runs: 5 (binary extdecomp 0.9.1).

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

