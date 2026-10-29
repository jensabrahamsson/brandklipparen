// Qualifying pools and T0 search planning (session A).
// Pure domain module: which pools qualify, how creation logs decode, and
// how the forward scan is chunked. Factory addresses and quote tokens are
// the pinned protocol values from the feed domain (Uniswap V2/V3 and
// SushiSwap V2/V3 factories, USDC/USDT/DAI; WETH arrives from operator
// configuration). No network, no clock, no randomness.
import { FEED_FACTORIES, QUOTE_TOKENS } from "../lpFeed.ts";
import { addressOfTopicWord } from "./topics.ts";
import { V2_PAIR_CREATED_TOPIC, V3_POOL_CREATED_TOPIC } from "./topics.ts";

// Analysis offsets in blocks: primary W plus the sensitivity pair.
export const ANALYSIS_WINDOWS: readonly number[] = Object.freeze([0, 300, 7200]);
export const PRIMARY_WINDOW = 7200;

// Forward search bounds, documented in the extractor and the design log:
// pool creation is scanned forward from the deployment block (clamped to
// the factory genesis once the run resolves it) up to this many blocks.
export const T0_SEARCH_BLOCKS = 500000;
// First-liquidity scan per candidate pool, in blocks from its creation.
export const FIRST_LIQUIDITY_SEARCH_BLOCKS = 50000;
// Default log chunk size in blocks; the driver halves it on range errors.
export const DEFAULT_LOG_RANGE_BLOCKS = 9000;
export const MIN_LOG_RANGE_BLOCKS = 50;

export type PoolKind = "v2" | "v3";

export type QualifyingFactory = {
  readonly dex: string;
  readonly address: string;
  readonly kind: PoolKind;
};

// The four qualifying factories: Uniswap V2, SushiSwap V2, Uniswap V3 and
// SushiSwap V3. Newer pool kinds stay out, so T0 is comparable per token.
export function qualifyingFactories(): readonly QualifyingFactory[] {
  const wanted = new Set(["uniswap-v2", "sushiswap-v2", "uniswap-v3", "sushiswap-v3"]);
  return Object.freeze(
    FEED_FACTORIES.filter((factory) => wanted.has(factory.dex) && (factory.kind === "v2" || factory.kind === "v3"))
      .map((factory) => Object.freeze({
        dex: factory.dex,
        address: factory.address,
        kind: factory.kind as PoolKind,
      })),
  );
}

export type QuoteSet = {
  readonly weth: string | null;
  readonly usdc: string;
  readonly usdt: string;
  readonly dai: string;
};

export function quoteSet(weth: string | null): QuoteSet {
  return Object.freeze({
    weth,
    usdc: QUOTE_TOKENS.usdc,
    usdt: QUOTE_TOKENS.usdt,
    dai: QUOTE_TOKENS.dai,
  });
}

// Lowercase quote list for membership tests: WETH plus the three stables.
export function quoteList(quotes: QuoteSet): readonly string[] {
  const out = [quotes.usdc.toLowerCase(), quotes.usdt.toLowerCase(), quotes.dai.toLowerCase()];
  if (quotes.weth !== null) {
    out.push(quotes.weth.toLowerCase());
  }
  return Object.freeze(out);
}

export function isQuoteSide(address: string, quotes: QuoteSet): boolean {
  return quoteList(quotes).includes(address.toLowerCase());
}

export type PoolCandidate = {
  readonly kind: PoolKind;
  readonly dex: string;
  readonly address: string;
  readonly quote: string;
  readonly creationBlock: number;
  readonly creationLogIndex: number;
  readonly creationTxHash: string;
};

export type DecodableLog = {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly txHash: string;
  readonly logIndex: number;
};

function topicEquals(actual: string | undefined, expected: string): boolean {
  return (actual ?? "").toLowerCase() === expected.toLowerCase();
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

// V2 PairCreated(address,address,address,uint256): indexed token0 and
// token1 in topics 1-2, the pair address in the first data word.
export function decodeV2PairCreated(log: DecodableLog): {
  readonly token0: string;
  readonly token1: string;
  readonly pair: string;
} | null {
  if (!topicEquals(log.topics[0], V2_PAIR_CREATED_TOPIC) || log.topics.length !== 3) {
    return null;
  }
  const token0 = addressOfTopicWord(log.topics[1] ?? "");
  const token1 = addressOfTopicWord(log.topics[2] ?? "");
  const words = dataWords(log.data);
  const pair = words !== null && words.length >= 1 ? addressOfTopicWord(words[0] ?? "") : null;
  if (token0 === null || token1 === null || pair === null) {
    return null;
  }
  return Object.freeze({ token0, token1, pair });
}

function feeOfWord(word: string): number | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(word)) {
    return null;
  }
  const value = parseInt(word.slice(-6), 16);
  return Number.isSafeInteger(value) ? value : null;
}

// V3 PoolCreated(address,address,uint24,int24,address): indexed token0,
// token1 and fee in topics 1-3, the pool address in the second data word.
export function decodeV3PoolCreated(log: DecodableLog): {
  readonly token0: string;
  readonly token1: string;
  readonly pool: string;
} | null {
  if (!topicEquals(log.topics[0], V3_POOL_CREATED_TOPIC) || log.topics.length !== 4) {
    return null;
  }
  const token0 = addressOfTopicWord(log.topics[1] ?? "");
  const token1 = addressOfTopicWord(log.topics[2] ?? "");
  const fee = feeOfWord(log.topics[3] ?? "");
  const words = dataWords(log.data);
  const pool = words !== null && words.length >= 2 ? addressOfTopicWord(words[1] ?? "") : null;
  if (token0 === null || token1 === null || fee === null || pool === null) {
    return null;
  }
  return Object.freeze({ token0, token1, pool });
}

// The token side of a creation log when exactly one side is a quote:
// the new-token side, or null when both or neither side is a quote.
export function qualifyingTokenSide(
  token0: string,
  token1: string,
  quotes: QuoteSet,
): { readonly token: string; readonly quote: string } | null {
  const firstIsQuote = isQuoteSide(token0, quotes);
  const secondIsQuote = isQuoteSide(token1, quotes);
  if (firstIsQuote && !secondIsQuote) {
    return Object.freeze({ token: token1.toLowerCase(), quote: token0.toLowerCase() });
  }
  if (secondIsQuote && !firstIsQuote) {
    return Object.freeze({ token: token0.toLowerCase(), quote: token1.toLowerCase() });
  }
  return null;
}

// Half-open block chunks [from, to] covering [fromBlock, toBlock].
export function planChunks(fromBlock: number, toBlock: number, rangeBlocks: number): readonly {
  readonly from: number;
  readonly to: number;
}[] {
  if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) || fromBlock > toBlock) {
    return Object.freeze([]);
  }
  const size = Math.max(1, Math.floor(rangeBlocks));
  const out: { readonly from: number; readonly to: number }[] = [];
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    out.push(Object.freeze({ from: cursor, to: Math.min(toBlock, cursor + size - 1) }));
    cursor += size;
  }
  return Object.freeze(out);
}

// Analysis-block arithmetic: T0 + W with the recorded W values.
export function analysisBlock(t0: number, window: number): number {
  return t0 + window;
}
