// Live new-tokens list domain (E-11 follow-up): newest-first ordering,
// cap, queue bound, WETH-side liquidity parsing, persistence shape and
// backoff. Written first (red) per A-21: src/domain/liveTokens.ts does
// not exist yet. Fixtures only, no network, no clock beyond injected ms.
import { describe, expect, test } from "vitest";
import { QUOTE_TOKENS, V2_SYNC_TOPIC0, V3_MINT_TOPIC0, resolveNewToken } from "../../../src/domain/lpFeed.ts";
import type { QuoteSet } from "../../../src/domain/lpFeed.ts";
import {
  LIVE_TOKENS_BACKOFF_BASE_MS,
  LIVE_TOKENS_BACKOFF_MAX_MS,
  LIVE_TOKENS_LOOKBACK_BLOCKS,
  LIVE_TOKENS_MAX_ITEMS,
  LIVE_TOKENS_MAX_QUEUE,
  LIVE_TOKENS_POLL_INTERVAL_MS,
  ageSeconds,
  enforceQueueBound,
  formatWethAmount,
  nextBackoffMs,
  parseLiveTokensDoc,
  requeueInterrupted,
  serializeLiveTokensDoc,
  upsertLiveToken,
  wethLiquidityFromLog,
} from "../../../src/domain/liveTokens.ts";
import type { LiveTokenItem } from "../../../src/domain/liveTokens.ts";
import { syntheticAddress, syntheticTxHash } from "../../helpers/syntheticAddresses.ts";

// Synthetic fixture addresses (tests only; src hard-codes no addresses).
const WETH = syntheticAddress(1);
const TOKEN_A = syntheticAddress(2);
const TOKEN_B = syntheticAddress(3);
const TOKEN_C = syntheticAddress(4);
const PAIR_A = syntheticAddress(10);
const PAIR_B = syntheticAddress(11);

function quotes(weth: string | null = WETH): QuoteSet {
  return {
    usdc: QUOTE_TOKENS.usdc,
    usdt: QUOTE_TOKENS.usdt,
    dai: QUOTE_TOKENS.dai,
    weth,
    allowNativeZero: false,
  };
}

function syntheticBlockMs(offsetMs = 0): number {
  return 1700000000000 + offsetMs;
}

function item(partial: Partial<LiveTokenItem> & { pairAddress: string }): LiveTokenItem {
  return {
    chainId: 1,
    tokenAddress: TOKEN_A,
    symbol: null,
    name: null,
    dex: "Uniswap V2",
    block: 21600000,
    txHash: syntheticTxHash(1),
    logIndex: 0,
    createdAt: 1700000000000,
    blockTimestampMs: syntheticBlockMs(),
    initialLiquidityWeth: null,
    state: "queued",
    ...partial,
  };
}

describe("live tokens domain", () => {
  test("polling cadence and bounds stay polite on the free tier", () => {
    // One logs poll per ~15 s: 5,760 cycles/day, far below the daily cap
    // even with pair-address paging on top (see service budget note).
    expect(LIVE_TOKENS_POLL_INTERVAL_MS).toBe(15_000);
    expect(LIVE_TOKENS_LOOKBACK_BLOCKS).toBe(300);
    expect(LIVE_TOKENS_MAX_ITEMS).toBe(200);
    expect(LIVE_TOKENS_MAX_QUEUE).toBe(50);
  });

  test("token extraction follows the existing quote-side rule with WETH from config", () => {
    // WETH pairs resolve the other side; the WETH value arrives from
    // BK_WETH_ADDRESS, never hard-coded in src.
    expect(resolveNewToken(WETH, TOKEN_A, quotes())).toEqual({
      kind: "new-token",
      tokenAddress: TOKEN_A.toLowerCase(),
    });
    // Stable pairs resolve the non-stable side (existing domain rule).
    expect(resolveNewToken(QUOTE_TOKENS.usdc, TOKEN_A, quotes()).kind).toBe("new-token");
    // Both sides quoted, or neither side quoted, skips with a reason.
    expect(resolveNewToken(QUOTE_TOKENS.usdc, QUOTE_TOKENS.usdt, quotes())).toEqual({
      kind: "skipped",
      reason: "both-quote",
    });
    expect(resolveNewToken(TOKEN_A, TOKEN_B, quotes())).toEqual({
      kind: "skipped",
      reason: "neither-quote",
    });
  });

  test("backoff doubles up to the cap", () => {
    expect(LIVE_TOKENS_BACKOFF_BASE_MS).toBe(5_000);
    expect(LIVE_TOKENS_BACKOFF_MAX_MS).toBe(60_000);
    expect(nextBackoffMs(5_000)).toBe(10_000);
    expect(nextBackoffMs(40_000)).toBe(60_000);
    expect(nextBackoffMs(60_000)).toBe(60_000);
  });

  test("V2 Sync reserves pick the WETH side", () => {
    const reserveWeth = 1_500_000_000_000_000_000n;
    const reserveToken = 9_000_000_000_000_000_000_000n;
    const data = `0x${reserveWeth.toString(16).padStart(64, "0")}${reserveToken.toString(16).padStart(64, "0")}`;
    const found = wethLiquidityFromLog(
      { topic0: V2_SYNC_TOPIC0, data },
      WETH,
      TOKEN_A,
      WETH,
    );
    expect(found).toBe("1.5");
  });

  test("V3 Mint amounts pick the WETH side from the last two words", () => {
    const amount0 = 250_000_000_000_000_000n;
    const amount1 = 500_000_000_000_000_000_000n;
    const pad = (value: bigint): string => value.toString(16).padStart(64, "0");
    const data = `0x${pad(1n)}${pad(2n)}${pad(3n)}${pad(4n)}${pad(5n)}${pad(amount0)}${pad(amount1)}`;
    const found = wethLiquidityFromLog(
      { topic0: V3_MINT_TOPIC0, data },
      TOKEN_A,
      WETH,
      WETH,
    );
    expect(found).toBe("500");
  });

  test("liquidity is null when neither side is WETH or the data is malformed", () => {
    const data = `0x${(1n).toString(16).padStart(64, "0")}${(2n).toString(16).padStart(64, "0")}`;
    expect(
      wethLiquidityFromLog(
        { topic0: V2_SYNC_TOPIC0, data },
        TOKEN_A,
        TOKEN_B,
        WETH,
      ),
    ).toBeNull();
    expect(
      wethLiquidityFromLog(
        { topic0: V2_SYNC_TOPIC0, data: "0x00" },
        WETH,
        TOKEN_A,
        WETH,
      ),
    ).toBeNull();
  });

  test("weth amounts format without trailing noise", () => {
    expect(formatWethAmount(0n)).toBe("0");
    expect(formatWethAmount(1_500_000_000_000_000_000n)).toBe("1.5");
    expect(formatWethAmount(1_234_567_890_000_000_000n)).toBe("1.2345");
  });

  test("upsert dedupes by pair, orders newest first and caps at 200", () => {
    let items: readonly LiveTokenItem[] = [];
    items = upsertLiveToken(items, item({ pairAddress: PAIR_A, block: 100, logIndex: 0 }));
    items = upsertLiveToken(items, item({ pairAddress: PAIR_B, block: 102, logIndex: 0 }));
    expect(items.map((entry) => entry.pairAddress)).toEqual([PAIR_B, PAIR_A]);
    // Same pair re-seen updates state without duplicating.
    items = upsertLiveToken(
      items,
      item({ pairAddress: PAIR_A, block: 100, logIndex: 0, state: "analyzing" }),
    );
    expect(items).toHaveLength(2);
    expect(items.find((entry) => entry.pairAddress === PAIR_A)?.state).toBe("analyzing");
    // Cap: 201 inserts keep the 200 newest.
    let many: readonly LiveTokenItem[] = [];
    for (let index = 0; index < 201; index += 1) {
      const pair = `0x${index.toString(16).padStart(40, "0")}`;
      many = upsertLiveToken(many, item({ pairAddress: pair, tokenAddress: TOKEN_C, block: index }));
    }
    expect(many).toHaveLength(200);
    expect(many[0]?.block).toBe(200);
    expect(many[199]?.block).toBe(1);
  });

  test("queue bound drops the oldest queued as skipped", () => {
    let items: readonly LiveTokenItem[] = [];
    for (let index = 0; index <= LIVE_TOKENS_MAX_QUEUE; index += 1) {
      const pair = `0x${index.toString(16).padStart(40, "0")}`;
      items = upsertLiveToken(items, item({ pairAddress: pair, tokenAddress: TOKEN_C, block: index }));
    }
    const queued = items.filter((entry) => entry.state === "queued");
    expect(queued).toHaveLength(LIVE_TOKENS_MAX_QUEUE + 1);
    const bounded = enforceQueueBound(items, LIVE_TOKENS_MAX_QUEUE);
    expect(bounded.filter((entry) => entry.state === "queued")).toHaveLength(LIVE_TOKENS_MAX_QUEUE);
    const dropped = bounded.find((entry) => entry.block === 0);
    expect(dropped?.state).toBe("skipped");
    expect(dropped?.reason).toContain("queue-full");
  });

  test("persistence round trips and rejects corrupt docs", () => {
    const doc = { version: 1 as const, cursorBlock: 21600010, items: [item({ pairAddress: PAIR_A })] };
    const parsed = parseLiveTokensDoc(JSON.parse(serializeLiveTokensDoc(doc)) as unknown);
    expect(parsed?.cursorBlock).toBe(21600010);
    expect(parsed?.items).toHaveLength(1);
    expect(parseLiveTokensDoc(null)).toBeNull();
    expect(parseLiveTokensDoc({ version: 2, cursorBlock: 1, items: [] })).toBeNull();
    expect(parseLiveTokensDoc({ version: 1, cursorBlock: -1, items: [] })).toBeNull();
  });

  test("interrupted analysis goes back to queued on restart", () => {
    const items = requeueInterrupted([
      item({ pairAddress: PAIR_A, state: "analyzing" }),
      item({ pairAddress: PAIR_B, state: "done", score: 12, riskBand: "Low" }),
    ]);
    expect(items.find((entry) => entry.pairAddress === PAIR_A)?.state).toBe("queued");
    expect(items.find((entry) => entry.pairAddress === PAIR_B)?.state).toBe("done");
  });

  test("age counts seconds between creation and now", () => {
    expect(ageSeconds(1700000000000, 1700000000000 + 125_000)).toBe(125);
  });

  test("age comes from the chain block time and stays unknown without it", () => {
    // A pair created hours earlier must not read as seconds old just
    // because the service saw it late: age derives from the block time.
    const blockMs = 1700000000000 - 3 * 3600 * 1000;
    expect(ageSeconds(blockMs, 1700000000000)).toBe(3 * 3600);
    expect(ageSeconds(null, 1700000000000)).toBeNull();
    expect(ageSeconds(undefined, 1700000000000)).toBeNull();
  });

  test("old cached docs without block time load with unknown age", () => {
    const withoutField = {
      chainId: 1,
      tokenAddress: TOKEN_A,
      symbol: null,
      name: null,
      pairAddress: PAIR_A,
      dex: "Uniswap V2",
      block: 21600000,
      txHash: syntheticTxHash(1),
      logIndex: 0,
      createdAt: 1700000000000,
      initialLiquidityWeth: null,
      state: "queued",
    };
    const parsed = parseLiveTokensDoc({ version: 1, cursorBlock: 1, items: [withoutField] });
    expect(parsed).not.toBeNull();
    expect(parsed?.items[0]?.blockTimestampMs ?? null).toBeNull();
    expect(ageSeconds(parsed?.items[0]?.blockTimestampMs ?? null, 1700000000000)).toBeNull();
  });

  test("newest-first order stays by block not first-seen", () => {
    const olderBlock = item({ pairAddress: PAIR_A, block: 100, logIndex: 0, createdAt: 1700000005000 });
    const newerBlock = item({ pairAddress: PAIR_B, block: 102, logIndex: 0, createdAt: 1700000000000 });
    let items: readonly LiveTokenItem[] = [];
    items = upsertLiveToken(items, olderBlock);
    items = upsertLiveToken(items, newerBlock);
    expect(items.map((entry) => entry.pairAddress)).toEqual([PAIR_B, PAIR_A]);
  });
});
