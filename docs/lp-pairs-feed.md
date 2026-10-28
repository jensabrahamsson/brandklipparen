# New LP pairs feed on Ethereum mainnet

Author: Jens Abrahamsson.
Status: implemented (backlog E-11, stories S-086–S-091; requirement
K-039 in `docs/requirements.md`, threats H-43–H-45 with
countermeasures M-49–M-51 in `docs/threat-model.md`).

The feed discovers only new LP pairs and pools that receive
liquidity on Ethereum mainnet (chainId 1) and emits one candidate
per pair:

`(chainId=1, tokenAddress, pool address or V4 poolId, blockNumber,
txHash, logIndex, dex)`

plus `blockHash` and V4 `hooks` as operational context. The feed
never affects score or evidence: the candidate type has no score,
probability, signal, or evidence field (property
`k039_feed_leaves_score_and_evidence_unchanged`).

## Sources

- Primary: Etherscan API V2 logs (`module=logs&action=getLogs`,
  chainid 1), one factory per call over a block range about once a
  minute. Free key from `ETHERSCAN_API_KEY`; the adapter reports
  `not configured` with zero sends without it.
- Fallback: JSON-RPC `eth_getLogs` behind the same `LpFeedPort`
  (`BRANDKLIPPAREN_FEED_RPC_URL`); `not configured` without it.

Pacing is a token bucket (3 calls per second), a daily budget
(100k), and backoff on rate-limit answers. Tests use a fake logs
transport with recorded fixtures under
`tests/fixtures/lpfeed/`; no live calls run in CI.

## Rules

- Factories and topic0 values are pinned in
  `src/domain/lpFeed.ts` (Uniswap V2/V3/V4, Sushi V2/V3,
  PancakeSwap V2/V3; Fraxswap V2 known but off by default).
- Quote side is resolved by address only (USDC, USDT, DAI, WETH
  from `BK_WETH_ADDRESS`, native zero for V4 only). The literal
  WETH address never appears in any tracked file; tests use a
  synthetic address. Both-or-neither-quote pairs log and skip.
- Handoff waits for first liquidity (V2 Mint or Sync, V3 Mint,
  V4 ModifyLiquidity with delta above zero on topic1 equal to
  the pool id), with a same-transaction fast path (the
  `addLiquidityETH` case) and a TTL pending queue otherwise.
- Idempotency uses the candidate key `(txHash, logIndex)`. Each
  poll re-reads the last three blocks, stores the block hash per
  candidate, and marks `orphaned` on change.
- Chain is mainnet only: any other `BRANDKLIPPAREN_CHAIN_ID`
  fails startup with a typed error.

## One-shot CLI

`npm run feed:once [-- --fromBlock N --toBlock M]` performs one
poll with the configured adapter and prints the candidates as
JSON, then exits. Without arguments it polls the trailing three
blocks. Pending entries do not persist across runs; a scheduler
keeps its own block cursor and re-polls about once a minute.
