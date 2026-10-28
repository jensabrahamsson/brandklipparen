// New LP pairs feed on Ethereum mainnet (S-086, K-039). Pure domain
// module: pinned topic0 values, factory and quote-token addresses, and
// quote-side resolution. No live calls, no clock, no randomness. The
// mainnet WETH address never appears here (or anywhere tracked): it
// arrives from operator configuration (`BK_WETH_ADDRESS`) and tests use
// a synthetic fixture address instead.

// Creation event signatures. Topic0 is keccak256 of the signature;
// tests recompute each value through the shared pure keccak helper.
export const V2_PAIR_CREATED_SIG = "PairCreated(address,address,address,uint256)";
export const V3_POOL_CREATED_SIG = "PoolCreated(address,address,uint24,int24,address)";
export const V4_INITIALIZE_SIG =
  "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)";

// Pinned creation topic0 values (K-039).
export const V2_PAIR_CREATED_TOPIC0 =
  "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
export const V3_POOL_CREATED_TOPIC0 =
  "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";
export const V4_INITIALIZE_TOPIC0 =
  "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";

// Liquidity event signatures that gate the handoff to analysis (S-089).
export const V2_MINT_SIG = "Mint(address,uint256,uint256)";
export const V2_SYNC_SIG = "Sync(uint112,uint112)";
export const V3_MINT_SIG = "Mint(address,address,int24,int24,uint128,uint256,uint256)";
export const V4_MODIFY_LIQUIDITY_SIG = "ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)";

// Liquidity topic0 values, derived from the signatures above with the
// shared pure keccak helper (checked by the S-086 pin test pattern).
export const V2_MINT_TOPIC0 =
  "0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f";
export const V2_SYNC_TOPIC0 =
  "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1";
export const V3_MINT_TOPIC0 =
  "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde";
export const V4_MODIFY_LIQUIDITY_TOPIC0 =
  "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec";

export type FeedDexId =
  | "uniswap-v2"
  | "uniswap-v3"
  | "uniswap-v4"
  | "sushiswap-v2"
  | "sushiswap-v3"
  | "pancakeswap-v2"
  | "pancakeswap-v3"
  | "fraxswap-v2";

// Operational cadence (K-039): one factory per call, about one poll a
// minute; each poll re-reads the last blocks so reorgs surface, and
// unfunded pairs wait in the pending queue up to the TTL.
export const LP_FEED_POLL_INTERVAL_MS = 60_000;
export const LP_FEED_REORG_WINDOW_BLOCKS = 3;
export const LP_FEED_PENDING_TTL_MS = 30 * 60_000;

export type FeedFactoryKind = "v2" | "v3" | "v4";

export type FeedFactory = {
  readonly dex: FeedDexId;
  readonly address: string;
  readonly kind: FeedFactoryKind;
  readonly enabledByDefault: boolean;
};

// Pinned mainnet factories (K-039). Fraxswap V2 is known but off by
// default, so the default poll set holds five factories. PancakeSwap V2/V3
// stay out until their full 40-hex mainnet addresses are confirmed from an
// authoritative source already present in the repo: the previously pinned
// values were truncated and every poll rejected them.
export const FEED_FACTORIES: readonly FeedFactory[] = Object.freeze([
  { dex: "uniswap-v2", address: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f", kind: "v2", enabledByDefault: true },
  { dex: "uniswap-v3", address: "0x1F98431c8aD98523631AE4a59f267346ea31F984", kind: "v3", enabledByDefault: true },
  { dex: "uniswap-v4", address: "0x000000000004444c5dc75cB358380D2e3dE08A90", kind: "v4", enabledByDefault: true },
  { dex: "sushiswap-v2", address: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac", kind: "v2", enabledByDefault: true },
  { dex: "sushiswap-v3", address: "0xbACEB8eC6b9355Dfc0269C18bac9d6E2Bdc29C4F", kind: "v3", enabledByDefault: true },
  { dex: "fraxswap-v2", address: "0x43eC799eAdd63848443E2347C49f5f52e8Fe0F6f", kind: "v2", enabledByDefault: false },
]);

// Native ETH side in V4 pairs: the zero address, V4 only (K-039).
export const ETH_ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Pinned stablecoin quotes (K-039). WETH is intentionally absent: it
// arrives from operator configuration (`BK_WETH_ADDRESS`), never from
// this module.
export const QUOTE_TOKENS = Object.freeze({
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  dai: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
});

export type QuoteSet = {
  // Lowercase or checksummed quote addresses from QUOTE_TOKENS plus the
  // configured WETH (null when `BK_WETH_ADDRESS` is unset). Native zero
  // counts as a quote only when `allowNativeZero` is true (V4 pairs).
  readonly usdc: string;
  readonly usdt: string;
  readonly dai: string;
  readonly weth: string | null;
  readonly allowNativeZero: boolean;
};

function lowerSet(quotes: QuoteSet): Set<string> {
  const set = new Set<string>([
    quotes.usdc.toLowerCase(),
    quotes.usdt.toLowerCase(),
    quotes.dai.toLowerCase(),
  ]);
  if (quotes.weth !== null) {
    set.add(quotes.weth.toLowerCase());
  }
  if (quotes.allowNativeZero) {
    set.add(ETH_ZERO_ADDRESS);
  }
  return set;
}

export type NewTokenResolution =
  | { readonly kind: "new-token"; readonly tokenAddress: string }
  | { readonly kind: "skipped"; readonly reason: "both-quote" | "neither-quote" };

export type FeedDecodeError = { readonly kind: "invalid-feed-log"; readonly message: string };

// Minimal structural view of a log for decoding: the port's FeedLog
// satisfies this shape, so decoders stay decoupled from the port module
// and the dependency arrow points at the domain only.
export type DecodableLog = {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly txHash: string;
  readonly logIndex: number;
};

function addressOfWord(word: string): string | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(word)) {
    return null;
  }
  return `0x${word.slice(-40).toLowerCase()}`;
}

function dataWords(data: string): string[] | null {
  if (!/^0x[0-9a-fA-F]*$/.test(data) || (data.length - 2) % 64 !== 0) {
    return null;
  }
  const words: string[] = [];
  for (let offset = 2; offset < data.length; offset += 64) {
    words.push(`0x${data.slice(offset, offset + 64)}`);
  }
  return words;
}

function topic0Matches(log: DecodableLog, topic0: string): boolean {
  return (log.topics[0] ?? "").toLowerCase() === topic0.toLowerCase();
}

export type V2PairCreation = {
  readonly kind: "v2";
  readonly token0: string;
  readonly token1: string;
  readonly pair: string;
};

// V2 PairCreated(address,address,address,uint256): indexed token0 and
// token1 in topics 1-2; the pair address is the first data word.
export function decodeV2PairCreated(
  log: DecodableLog,
): { ok: true; value: V2PairCreation } | { ok: false; error: FeedDecodeError } {
  if (!topic0Matches(log, V2_PAIR_CREATED_TOPIC0) || log.topics.length !== 3) {
    return { ok: false, error: { kind: "invalid-feed-log", message: "log is not a V2 PairCreated event" } };
  }
  const token0 = addressOfWord(log.topics[1] ?? "");
  const token1 = addressOfWord(log.topics[2] ?? "");
  const words = dataWords(log.data);
  const pair = words !== null && words.length >= 1 ? addressOfWord(words[0] ?? "") : null;
  if (token0 === null || token1 === null || pair === null) {
    return { ok: false, error: { kind: "invalid-feed-log", message: "V2 PairCreated log carries malformed fields" } };
  }
  return { ok: true, value: { kind: "v2", token0, token1, pair } };
}

export type V3PoolCreation = {
  readonly kind: "v3";
  readonly token0: string;
  readonly token1: string;
  readonly fee: number;
  readonly pool: string;
};

function feeOfWord(word: string): number | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(word)) {
    return null;
  }
  const value = parseInt(word.slice(-6), 16);
  return Number.isSafeInteger(value) ? value : null;
}

// V3 PoolCreated(address,address,uint24,int24,address): indexed token0,
// token1 and fee in topics 1-3; tick spacing and the pool address travel
// in the two data words.
export function decodeV3PoolCreated(
  log: DecodableLog,
): { ok: true; value: V3PoolCreation } | { ok: false; error: FeedDecodeError } {
  if (!topic0Matches(log, V3_POOL_CREATED_TOPIC0) || log.topics.length !== 4) {
    return { ok: false, error: { kind: "invalid-feed-log", message: "log is not a V3 PoolCreated event" } };
  }
  const token0 = addressOfWord(log.topics[1] ?? "");
  const token1 = addressOfWord(log.topics[2] ?? "");
  const fee = feeOfWord(log.topics[3] ?? "");
  const words = dataWords(log.data);
  const pool = words !== null && words.length >= 2 ? addressOfWord(words[1] ?? "") : null;
  if (token0 === null || token1 === null || fee === null || pool === null) {
    return { ok: false, error: { kind: "invalid-feed-log", message: "V3 PoolCreated log carries malformed fields" } };
  }
  return { ok: true, value: { kind: "v3", token0, token1, fee, pool } };
}

export type V4PoolCreation = {
  readonly kind: "v4";
  readonly poolId: string;
  readonly currency0: string;
  readonly currency1: string;
  readonly hooks: string;
};

// V4 Initialize on the PoolManager: indexed pool id and currencies in
// topics 1-3; fee, tick spacing, hooks, price and tick travel in the
// five data words. `hooks` is context for analysis, never score input.
export function decodeV4Initialize(
  log: DecodableLog,
): { ok: true; value: V4PoolCreation } | { ok: false; error: FeedDecodeError } {
  if (!topic0Matches(log, V4_INITIALIZE_TOPIC0) || log.topics.length !== 4) {
    return { ok: false, error: { kind: "invalid-feed-log", message: "log is not a V4 Initialize event" } };
  }
  const poolId = (log.topics[1] ?? "").toLowerCase();
  if (!/^0x[0-9a-fA-F]{64}$/.test(poolId)) {
    return { ok: false, error: { kind: "invalid-feed-log", message: "V4 Initialize log carries a malformed pool id" } };
  }
  const currency0 = addressOfWord(log.topics[2] ?? "");
  const currency1 = addressOfWord(log.topics[3] ?? "");
  const words = dataWords(log.data);
  const hooks = words !== null && words.length >= 3 ? addressOfWord(words[2] ?? "") : null;
  if (currency0 === null || currency1 === null || hooks === null) {
    return { ok: false, error: { kind: "invalid-feed-log", message: "V4 Initialize log carries malformed fields" } };
  }
  return { ok: true, value: { kind: "v4", poolId, currency0, currency1, hooks } };
}

// Pool reference for the liquidity check: the pair or pool address for
// V2/V3, the bytes32 pool id for V4 (matched against topic1).
export type PoolRef =
  | { readonly kind: "pair"; readonly address: string }
  | { readonly kind: "poolId"; readonly id: string };

function liquidityDeltaAboveZero(data: string): boolean {
  const words = dataWords(data);
  if (words === null || words.length < 3) {
    return false;
  }
  const raw = (words[2] ?? "").toLowerCase();
  const magnitude = BigInt(raw);
  // int256 two's complement: values at or above 2^255 are negative.
  if (magnitude >= 1n << 255n) {
    return false;
  }
  return magnitude > 0n;
}

// First-liquidity check (S-089): V2 Mint or Sync on the pair, V3 pool
// Mint on the pool address, V4 ModifyLiquidity with delta above zero
// filtered on topic1 equal to the pool id.
export function isFirstLiquidityLog(log: DecodableLog, pool: PoolRef): boolean {
  const topic0 = (log.topics[0] ?? "").toLowerCase();
  if (pool.kind === "pair") {
    if (log.address.toLowerCase() !== pool.address.toLowerCase()) {
      return false;
    }
    return topic0 === V2_MINT_TOPIC0.toLowerCase() || topic0 === V2_SYNC_TOPIC0.toLowerCase() ||
      topic0 === V3_MINT_TOPIC0.toLowerCase();
  }
  if (topic0 !== V4_MODIFY_LIQUIDITY_TOPIC0.toLowerCase()) {
    return false;
  }
  if ((log.topics[1] ?? "").toLowerCase() !== pool.id.toLowerCase()) {
    return false;
  }
  return liquidityDeltaAboveZero(log.data);
}

export type SameTxLiquidityHint = {
  readonly log: DecodableLog;
  readonly poolAddress: string;
};

// Same-transaction fast path (S-089): a creation whose transaction also
// carries first liquidity for its pool hands to analysis immediately
// (the addLiquidityETH case); anything else waits in the pending queue.
export function gateCreation(
  pool: PoolRef,
  sameTx: readonly SameTxLiquidityHint[],
  creationTxHash: string,
): "ready" | "pending" {
  for (const hint of sameTx) {
    if (hint.log.txHash.toLowerCase() !== creationTxHash.toLowerCase()) {
      continue;
    }
    if (pool.kind === "pair" && hint.poolAddress.toLowerCase() !== pool.address.toLowerCase()) {
      continue;
    }
    if (isFirstLiquidityLog(hint.log, pool)) {
      return "ready";
    }
  }
  return "pending";
}

// Candidate identity and pending queue (S-089, S-090).
export type PoolPointer =
  | { readonly kind: "pair"; readonly address: string }
  | { readonly kind: "poolId"; readonly id: string };

export type PendingCandidate = {
  readonly chainId: 1;
  readonly tokenAddress: string;
  readonly pool: PoolPointer;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly txHash: string;
  readonly logIndex: number;
  readonly dex: FeedDexId;
  readonly hooks?: string | undefined;
  readonly queuedAtMs: number;
};

// Candidate key (S-090): (txHash, logIndex), lowercased.
export function candidateKeyOf(txHash: string, logIndex: number): string {
  return `${txHash.toLowerCase()}|${logIndex}`;
}

export function candidateKeyOfPending(candidate: PendingCandidate): string {
  return candidateKeyOf(candidate.txHash, candidate.logIndex);
}

// Pending queue with TTL (S-089): pairs created without liquidity wait
// here until a later poll observes their first liquidity or the TTL
// drops them. Pure functions over the injected clock.
export function enqueuePending(
  queue: readonly PendingCandidate[],
  candidate: Omit<PendingCandidate, "queuedAtMs">,
  nowMs: number,
  _ttlMs: number,
): PendingCandidate[] {
  void _ttlMs;
  const key = candidateKeyOf(candidate.txHash, candidate.logIndex);
  if (queue.some((held) => candidateKeyOfPending(held) === key)) {
    return queue.slice();
  }
  return [...queue, { ...candidate, queuedAtMs: nowMs }];
}

export function sweepPending(
  queue: readonly PendingCandidate[],
  nowMs: number,
  ttlMs: number,
): { readonly active: readonly PendingCandidate[]; readonly expired: readonly PendingCandidate[] } {
  const active: PendingCandidate[] = [];
  const expired: PendingCandidate[] = [];
  for (const held of queue) {
    if (nowMs - held.queuedAtMs > ttlMs) {
      expired.push(held);
    } else {
      active.push(held);
    }
  }
  return { active: Object.freeze(active), expired: Object.freeze(expired) };
}

// Quote-side resolution (S-086, S-090): the new token is the side that
// is not a quote. Both or neither sides a quote logs and skips with a
// typed reason; the caller records the skip and emits no candidate.
export function resolveNewToken(
  token0: string,
  token1: string,
  quotes: QuoteSet,
): NewTokenResolution {
  const set = lowerSet(quotes);
  const first = token0.toLowerCase();
  const second = token1.toLowerCase();
  const firstIsQuote = set.has(first);
  const secondIsQuote = set.has(second);
  if (firstIsQuote && !secondIsQuote) {
    return { kind: "new-token", tokenAddress: second };
  }
  if (secondIsQuote && !firstIsQuote) {
    return { kind: "new-token", tokenAddress: first };
  }
  return { kind: "skipped", reason: firstIsQuote ? "both-quote" : "neither-quote" };
}
