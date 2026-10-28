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
