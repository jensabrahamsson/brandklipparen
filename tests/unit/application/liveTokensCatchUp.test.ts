// Session 18 feed catch-up: far-behind cursors converge in bounded
// steps, partial factory coverage advances the cursor, and the RPC
// fallback serves the bounded span when the primary backs off. Fakes
// only: a 1-call-per-second bucket, a range-capped fallback and the
// shared synthetic address helpers. Never real values, no network.
import { describe, expect, test } from "vitest";
import {
  FEED_FACTORIES,
  QUOTE_TOKENS,
  V2_PAIR_CREATED_TOPIC0,
} from "../../../src/domain/lpFeed.ts";
import type { FeedFactory, QuoteSet } from "../../../src/domain/lpFeed.ts";
import type { LiveTokensDoc } from "../../../src/domain/liveTokens.ts";
import type { FeedLog, FeedPollInput, LpFeedError, LpFeedPort } from "../../../src/ports/lpFeed.ts";
import { err, ok } from "../../../src/domain/result.ts";
import type { Result } from "../../../src/domain/result.ts";
import { createLiveTokensService } from "../../../src/application/liveTokensService.ts";
import type {
  LiveTokensAnalyzeResult,
  LiveTokensServiceOptions,
} from "../../../src/application/liveTokensService.ts";
import { syntheticAddress, syntheticTxHash } from "../../helpers/syntheticAddresses.ts";
import { realLiveTokensTimers } from "../../helpers/liveTokensTimers.ts";

const WETH = syntheticAddress(1);
const TOKEN = syntheticAddress(2);
const PAIR = syntheticAddress(10);
const BLOCK_HASH = syntheticTxHash(7);
const TX_ONE = syntheticTxHash(1);

const HEAD = 2000;
const START_CURSOR = 200;

function word(value: string): string {
  return `0x${"0".repeat(24)}${value.slice(2).toLowerCase()}`;
}

function chainMs(offsetMs = 0): number {
  return 1700000000000 + offsetMs;
}

function v2Creation(
  token0: string,
  token1: string,
  pair: string,
  block: number,
  tx: string,
  blockTimestampMs: number | null = chainMs(),
): FeedLog {
  return {
    address: FEED_FACTORIES.find((entry) => entry.dex === "uniswap-v2")?.address ?? "",
    topics: [V2_PAIR_CREATED_TOPIC0, word(token0), word(token1)],
    data: `${word(pair)}${"0".repeat(62)}02`.toLowerCase(),
    blockNumber: block,
    blockHash: BLOCK_HASH,
    txHash: tx,
    logIndex: 0,
    blockTimestampMs,
  };
}

type FeedAnswer = Result<{ logs: readonly FeedLog[]; coveredToBlock: number }, LpFeedError>;

function quotes(): QuoteSet {
  return {
    usdc: QUOTE_TOKENS.usdc,
    usdt: QUOTE_TOKENS.usdt,
    dai: QUOTE_TOKENS.dai,
    weth: WETH,
    allowNativeZero: false,
  };
}

function factories(): readonly FeedFactory[] {
  return FEED_FACTORIES.filter((entry) => entry.dex === "uniswap-v2" || entry.dex === "uniswap-v3");
}

function doneResult(score: number): LiveTokensAnalyzeResult {
  return {
    kind: "done",
    score,
    riskBand: score < 30 ? "Low" : score < 60 ? "Elevated" : "High",
  };
}

// Primary with a 1-call-per-second token bucket on the injected clock:
// the first call per second serves, further calls answer a local-scope
// rate limit without consuming the daily budget.
class BucketPrimary implements LpFeedPort {
  readonly calls: FeedPollInput[] = [];
  private tokens = 1;
  private lastMs: number;
  private readonly clock: () => number;
  constructor(now: () => number) {
    this.clock = now;
    this.lastMs = now();
  }
  async pollLogs(input: FeedPollInput): Promise<FeedAnswer> {
    this.calls.push(input);
    const at = this.clock();
    this.tokens = Math.min(1, this.tokens + ((at - this.lastMs) / 1000) * 1);
    this.lastMs = at;
    if (this.tokens < 1) {
      return err({ kind: "rate-limited", message: "feed token bucket is empty", retryAfterMs: 1000, scope: "local" });
    }
    this.tokens -= 1;
    return ok({ logs: Object.freeze([]), coveredToBlock: input.toBlock });
  }
}

// Fallback without a bucket (the RPC shape): every bounded span serves,
// mirroring a provider range cap that turns wide spans away.
class RangeCappedFallback implements LpFeedPort {
  readonly calls: FeedPollInput[] = [];
  async pollLogs(input: FeedPollInput): Promise<FeedAnswer> {
    this.calls.push(input);
    if (input.toBlock - input.fromBlock > 100) {
      return err({ kind: "unavailable", message: "query exceeds the block range cap" });
    }
    return ok({ logs: Object.freeze([]), coveredToBlock: input.toBlock });
  }
}

class AlwaysBackingOff implements LpFeedPort {
  readonly calls: FeedPollInput[] = [];
  async pollLogs(input: FeedPollInput): Promise<FeedAnswer> {
    this.calls.push(input);
    return err({
      kind: "rate-limited",
      message: "feed backs off after a provider rate-limit answer",
      retryAfterMs: 5000,
      scope: "provider",
    });
  }
}

function savingStore(cursorBlock: number): {
  store: { load: () => LiveTokensDoc | null; save: (doc: LiveTokensDoc) => void };
  saved: LiveTokensDoc[];
  current: () => LiveTokensDoc | null;
} {
  const saved: LiveTokensDoc[] = [];
  let current: LiveTokensDoc | null = { version: 1, cursorBlock, items: [] };
  return {
    store: {
      load: () => current,
      save: (doc: LiveTokensDoc): void => {
        current = doc;
        saved.push(doc);
      },
    },
    saved,
    current: () => current,
  };
}

function serviceOptions(
  primary: LpFeedPort,
  fallback: LpFeedPort,
  holder: ReturnType<typeof savingStore>,
  now: () => number,
): LiveTokensServiceOptions {
  return {
    primary,
    fallback,
    quotes: quotes(),
    factories: factories(),
    getLatestBlock: async () => HEAD,
    analyze: async () => doneResult(12),
    store: holder.store,
    now,
    timers: realLiveTokensTimers,
  };
}

describe("live feed catch-up after a restart (session 18)", () => {
  test("a far-behind cursor converges to head in bounded cycles with source rpc", async () => {
    let nowMs = 1700000000000;
    const holder = savingStore(START_CURSOR);
    const primary = new BucketPrimary(() => nowMs);
    const fallback = new RangeCappedFallback();
    const service = createLiveTokensService(serviceOptions(primary, fallback, holder, () => nowMs));
    let cycles = 0;
    for (;;) {
      await service.pollOnce();
      await service.settled();
      cycles += 1;
      nowMs += 15_000;
      if ((holder.current()?.cursorBlock ?? -1) >= HEAD || cycles > 25) {
        break;
      }
    }
    expect(holder.current()?.cursorBlock).toBe(HEAD);
    expect(cycles).toBeLessThanOrEqual(25);
    // Every asked span stays bounded: no cycle asks for more than the
    // per-cycle span, so one cycle fits the per-second budget.
    for (const call of [...primary.calls, ...fallback.calls]) {
      expect(call.toBlock - call.fromBlock).toBeLessThanOrEqual(99);
    }
    expect(service.snapshot().source).toBe("rpc");
    expect(service.snapshot().status).toBe("live");
    service.stop();
  });

  test("fallback serves the bounded span when the primary backs off", async () => {
    let nowMs = 1700000000000;
    const holder = savingStore(START_CURSOR);
    const primary = new AlwaysBackingOff();
    const fallback = new RangeCappedFallback();
    const service = createLiveTokensService(serviceOptions(primary, fallback, holder, () => nowMs));
    let cycles = 0;
    for (;;) {
      await service.pollOnce();
      await service.settled();
      cycles += 1;
      nowMs += 15_000;
      if ((holder.current()?.cursorBlock ?? -1) >= HEAD || cycles > 25) {
        break;
      }
    }
    expect(holder.current()?.cursorBlock).toBe(HEAD);
    expect(cycles).toBeLessThanOrEqual(25);
    for (const call of fallback.calls) {
      expect(call.toBlock - call.fromBlock).toBeLessThanOrEqual(99);
    }
    expect(service.snapshot().source).toBe("rpc");
    expect(service.snapshot().status).toBe("live");
    service.stop();
  });

  test("partial factory coverage advances the cursor to the covered block", async () => {
    const creation = v2Creation(WETH, TOKEN, PAIR, 250, TX_ONE, chainMs(-3600 * 1000));
    const partial: LpFeedPort = {
      pollLogs: async (input: FeedPollInput): Promise<FeedAnswer> => {
        if (input.fromBlock <= 250) {
          return ok({ logs: Object.freeze([creation]), coveredToBlock: 250 });
        }
        return ok({ logs: Object.freeze([]), coveredToBlock: input.toBlock });
      },
    };
    const notConfigured: LpFeedPort = {
      pollLogs: async (): Promise<FeedAnswer> =>
        err({ kind: "not-configured", message: "the feed is not configured" }),
    };
    const nowMs = 1700000000000;
    const holder = savingStore(START_CURSOR);
    const service = createLiveTokensService({
      primary: partial,
      fallback: notConfigured,
      quotes: quotes(),
      factories: factories(),
      getLatestBlock: async () => HEAD,
      analyze: async () => doneResult(12),
      store: holder.store,
      now: () => nowMs,
      timers: realLiveTokensTimers,
    });
    await service.pollOnce();
    await service.settled();
    expect(holder.current()?.cursorBlock).toBe(250);
    expect(service.snapshot().items).toHaveLength(1);
    expect(service.snapshot().source).toBe("etherscan");
    // The catch-up entry carries the chain time, so the age reflects the
    // block rather than the late first-seen instant.
    expect(service.snapshot().items[0]?.blockTimestampMs).toBe(chainMs(-3600 * 1000));
    expect(service.snapshot().items[0]?.ageSeconds).toBe(3600);
    service.stop();
  });

  test("catch-up order stays by block not first-seen", async () => {
    const holder = savingStore(START_CURSOR);
    const first = v2Creation(WETH, TOKEN, PAIR, 260, TX_ONE, chainMs(-2000));
    const primary: LpFeedPort = {
      pollLogs: async (input: FeedPollInput): Promise<FeedAnswer> => {
        if (input.fromBlock <= 260) {
          return ok({ logs: Object.freeze([first]), coveredToBlock: 260 });
        }
        return ok({ logs: Object.freeze([]), coveredToBlock: input.toBlock });
      },
    };
    const notConfigured: LpFeedPort = {
      pollLogs: async (): Promise<FeedAnswer> =>
        err({ kind: "not-configured", message: "the feed is not configured" }),
    };
    const nowMs = 1700000000000;
    const service = createLiveTokensService({
      primary,
      fallback: notConfigured,
      quotes: quotes(),
      factories: factories(),
      getLatestBlock: async () => HEAD,
      analyze: async () => doneResult(12),
      store: holder.store,
      now: () => nowMs,
      timers: realLiveTokensTimers,
    });
    await service.pollOnce();
    await service.settled();
    // Same first-seen instant for every entry: the stored order still
    // follows the chain block, not the discovery order.
    expect(service.snapshot().items[0]?.block).toBe(260);
    expect(service.snapshot().items[0]?.ageSeconds).toBe(2);
    service.stop();
  });
});
