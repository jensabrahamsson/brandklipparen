// Live new-tokens application service (E-11 follow-up): polite polling
// with fallback, token extraction, bounded analysis queue and restart.
// Written first (red) per A-21: src/application/liveTokensService.ts
// does not exist yet. Fixtures and fakes only: no network, no clock
// beyond the injected reader.
import { describe, expect, test } from "vitest";
import {
  FEED_FACTORIES,
  QUOTE_TOKENS,
  V2_PAIR_CREATED_TOPIC0,
  V2_SYNC_TOPIC0,
  V3_MINT_TOPIC0,
  V3_POOL_CREATED_TOPIC0,
} from "../../../src/domain/lpFeed.ts";
import type { FeedFactory, QuoteSet } from "../../../src/domain/lpFeed.ts";
import type { LiveTokensDoc } from "../../../src/domain/liveTokens.ts";
import type {
  FeedLog,
  FeedPollInput,
  LpFeedError,
  LpFeedPort,
} from "../../../src/ports/lpFeed.ts";
import { err, ok } from "../../../src/domain/result.ts";
import type { Result } from "../../../src/domain/result.ts";
import { createLiveTokensService } from "../../../src/application/liveTokensService.ts";
import type {
  LiveTokensAnalyzeResult,
  LiveTokensServiceOptions,
} from "../../../src/application/liveTokensService.ts";
import { syntheticAddress, syntheticTxHash } from "../../helpers/syntheticAddresses.ts";
import { realLiveTokensTimers } from "../../helpers/liveTokensTimers.ts";

// Synthetic fixture addresses (tests only; src hard-codes no addresses).
const WETH = syntheticAddress(1);
const TOKEN_A = syntheticAddress(2);
const TOKEN_B = syntheticAddress(3);
const PAIR_A = syntheticAddress(10);
const PAIR_B = syntheticAddress(11);
const POOL_V3 = syntheticAddress(12);
const BLOCK_HASH = syntheticTxHash(7);
const TX_ONE = syntheticTxHash(1);
const TX_TWO = syntheticTxHash(2);

const FACTORY_V2 = FEED_FACTORIES.find((entry) => entry.dex === "uniswap-v2")?.address ?? "";
const FACTORY_V3 = FEED_FACTORIES.find((entry) => entry.dex === "uniswap-v3")?.address ?? "";

function word(value: string): string {
  return `0x${"0".repeat(24)}${value.slice(2).toLowerCase()}`;
}

function uintWord(value: number): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
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
    address: FACTORY_V2,
    topics: [V2_PAIR_CREATED_TOPIC0, word(token0), word(token1)],
    data: `${word(pair)}${uintWord(1).slice(2)}`.toLowerCase(),
    blockNumber: block,
    blockHash: BLOCK_HASH,
    txHash: tx,
    logIndex: 0,
    blockTimestampMs,
  };
}

function v3Creation(
  token0: string,
  token1: string,
  fee: number,
  pool: string,
  block: number,
  tx: string,
  blockTimestampMs: number | null = chainMs(),
): FeedLog {
  return {
    address: FACTORY_V3,
    topics: [V3_POOL_CREATED_TOPIC0, word(token0), word(token1), uintWord(fee)],
    data: `0x${uintWord(60).slice(2)}${"0".repeat(24)}${pool.slice(2).toLowerCase()}`,
    blockNumber: block,
    blockHash: BLOCK_HASH,
    txHash: tx,
    logIndex: 0,
    blockTimestampMs,
  };
}

function txOf(index: number): string {
  return `0xe3${index.toString(16).padStart(62, "0")}`;
}

function syncLog(
  pair: string,
  reserveWeth: bigint,
  reserveToken: bigint,
  block: number,
  tx: string,
  blockTimestampMs: number | null = chainMs(),
): FeedLog {
  const pad = (value: bigint): string => value.toString(16).padStart(64, "0");
  return {
    address: pair,
    topics: [V2_SYNC_TOPIC0],
    data: `0x${pad(reserveWeth)}${pad(reserveToken)}`,
    blockNumber: block,
    blockHash: BLOCK_HASH,
    txHash: tx,
    logIndex: 1,
    blockTimestampMs,
  };
}

type FeedAnswer = Result<{ logs: readonly FeedLog[]; coveredToBlock: number }, LpFeedError>;

function served(input: FeedPollInput, logs: readonly FeedLog[]): FeedAnswer {
  return ok({ logs: Object.freeze(logs.slice()), coveredToBlock: input.toBlock });
}

class FakeFeed implements LpFeedPort {
  readonly calls: FeedPollInput[] = [];
  private readonly answer: (input: FeedPollInput) => FeedAnswer;
  constructor(answer: (input: FeedPollInput) => FeedAnswer) {
    this.answer = answer;
  }
  async pollLogs(input: FeedPollInput): Promise<FeedAnswer> {
    this.calls.push(input);
    return this.answer(input);
  }
}

function notConfigured(): FeedAnswer {
  return err({ kind: "not-configured", message: "the feed is not configured" });
}

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

function memoryStore(): {
  load: () => LiveTokensDoc | null;
  save: (doc: LiveTokensDoc) => void;
  saved: LiveTokensDoc[];
} {
  const saved: LiveTokensDoc[] = [];
  let current: LiveTokensDoc | null = null;
  return {
    load: () => current,
    save: (doc: LiveTokensDoc) => {
      current = doc;
      saved.push(doc);
    },
    saved,
  };
}

function doneResult(score: number): LiveTokensAnalyzeResult {
  return {
    kind: "done",
    score,
    riskBand: score < 30 ? "Low" : score < 60 ? "Elevated" : "High",
  };
}

function options(partial: Partial<LiveTokensServiceOptions>): LiveTokensServiceOptions {
  const store = memoryStore();
  return {
    primary: new FakeFeed((input) => served(input, [])),
    fallback: new FakeFeed(() => notConfigured()),
    quotes: quotes(),
    factories: factories(),
    getLatestBlock: async () => 1000,
    analyze: async () => doneResult(12),
    store,
    now: () => 1700000000000,
    timers: realLiveTokensTimers,
    ...partial,
  };
}

describe("live tokens service", () => {
  test("reports not-configured with the key message when no source is usable", async () => {
    const service = createLiveTokensService(
      options({ primary: new FakeFeed(() => notConfigured()) }),
    );
    await service.pollOnce();
    const snapshot = service.snapshot();
    expect(snapshot.status).toBe("not-configured");
    expect(snapshot.source).toBe("none");
    expect(snapshot.message).toContain("set an Etherscan key");
    expect(snapshot.items).toEqual([]);
  });

  test("fresh start anchors at the lookback and clamps the span", async () => {
    const primary = new FakeFeed((input) => served(input, []));
    const service = createLiveTokensService(options({ primary, getLatestBlock: async () => 1000 }));
    await service.pollOnce();
    const ranges = primary.calls.map((call) => [call.fromBlock, call.toBlock]);
    expect(ranges).toContainEqual([700, 799]);
  });

  test("V2 creation with WETH becomes a queued item, newest first", async () => {
    const primary = new FakeFeed((input) =>
      input.factory.toLowerCase() === FACTORY_V2.toLowerCase()
        ? served(input, [v2Creation(WETH, TOKEN_A, PAIR_A, 799, TX_ONE)])
        : served(input, []),
    );
    const service = createLiveTokensService(options({ primary }));
    await service.pollOnce();
    const snapshot = service.snapshot();
    expect(snapshot.status).toBe("live");
    expect(snapshot.source).toBe("etherscan");
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({
      tokenAddress: TOKEN_A.toLowerCase(),
      pairAddress: PAIR_A.toLowerCase(),
      dex: "Uniswap V2",
      block: 799,
      state: "done",
      score: 12,
      riskBand: "Low",
    });
    expect(snapshot.items[0]?.ageSeconds).toBe(0);
  });

  test("V3 creation records dex and fee tier", async () => {
    const primary = new FakeFeed((input) =>
      input.factory.toLowerCase() === FACTORY_V3.toLowerCase()
        ? served(input, [v3Creation(TOKEN_A, WETH, 3000, POOL_V3, 799, TX_ONE)])
        : served(input, []),
    );
    const service = createLiveTokensService(options({ primary }));
    await service.pollOnce();
    const snapshot = service.snapshot();
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({ dex: "Uniswap V3", feeTier: 3000 });
  });

  test("pairs without a quoted side skip without an item", async () => {
    const primary = new FakeFeed((input) =>
      input.factory.toLowerCase() === FACTORY_V2.toLowerCase()
        ? served(input, [v2Creation(TOKEN_A, TOKEN_B, PAIR_A, 799, TX_ONE)])
        : served(input, []),
    );
    const service = createLiveTokensService(options({ primary }));
    await service.pollOnce();
    expect(service.snapshot().items).toEqual([]);
  });

  test("duplicate logs and reorg-ish repeats never duplicate items", async () => {
    const log = v2Creation(WETH, TOKEN_A, PAIR_A, 799, TX_ONE);
    const primary = new FakeFeed((input) =>
      input.factory.toLowerCase() === FACTORY_V2.toLowerCase() ? served(input, [log, log]) : served(input, []),
    );
    const service = createLiveTokensService(options({ primary }));
    await service.pollOnce();
    await service.pollOnce();
    const snapshot = service.snapshot();
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]?.createdAt).toBe(1700000000000);
  });

  test("first Sync in the pair poll fills initial WETH liquidity", async () => {
    const primary = new FakeFeed((input) => {
      if (input.factory.toLowerCase() === FACTORY_V2.toLowerCase()) {
        return served(input, [v2Creation(WETH, TOKEN_A, PAIR_A, 799, TX_ONE)]);
      }
      if (input.factory.toLowerCase() === PAIR_A.toLowerCase()) {
        return served(input, [
          syncLog(PAIR_A, 1_500_000_000_000_000_000n, 9_000_000_000_000_000_000_000n, 799, TX_ONE),
        ]);
      }
      return served(input, []);
    });
    const service = createLiveTokensService(
      options({ primary, maxPairPollsPerCycle: 8, now: () => 1700000000000 }),
    );
    await service.pollOnce();
    expect(service.snapshot().items[0]?.initialLiquidityWeth).toBe("1.5");
  });

  test("RPC fallback serves when Etherscan is not configured", async () => {
    const fallback = new FakeFeed((input) =>
      input.factory.toLowerCase() === FACTORY_V2.toLowerCase()
        ? served(input, [v2Creation(WETH, TOKEN_A, PAIR_A, 799, TX_ONE)])
        : served(input, []),
    );
    const service = createLiveTokensService(
      options({ primary: new FakeFeed(() => notConfigured()), fallback }),
    );
    await service.pollOnce();
    const snapshot = service.snapshot();
    expect(snapshot.source).toBe("rpc");
    expect(snapshot.status).toBe("live");
    expect(snapshot.items).toHaveLength(1);
  });

  test("failing polls keep the list and report a short message", async () => {
    const failing = new FakeFeed(() =>
      err({ kind: "unavailable", message: "feed log source is unavailable" }),
    );
    const service = createLiveTokensService(options({ primary: failing, fallback: failing }));
    await service.pollOnce();
    const snapshot = service.snapshot();
    expect(snapshot.status).toBe("live");
    expect(snapshot.items).toEqual([]);
    expect(snapshot.message).toBe("feed log source is unavailable");
  });

  test("failing polls back off before retrying the feed", async () => {
    const failing = new FakeFeed(() =>
      err({ kind: "unavailable", message: "feed log source is unavailable" }),
    );
    let nowMs = 1700000000000;
    const service = createLiveTokensService(
      options({ primary: failing, fallback: failing, now: () => nowMs }),
    );
    await service.pollOnce();
    const callsAfterFirst = failing.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    // Still inside the base backoff: the feed sees no new calls.
    nowMs += 1_000;
    await service.pollOnce();
    expect(failing.calls.length).toBe(callsAfterFirst);
    // Past the backoff: polling resumes and the message stays short.
    nowMs += 10_000;
    await service.pollOnce();
    expect(failing.calls.length).toBeGreaterThan(callsAfterFirst);
    expect(service.snapshot().message).toBe("feed log source is unavailable");
  });

  test("the queue analyzes one item at a time by default", async () => {
    const primary = new FakeFeed((input) =>
      input.factory.toLowerCase() === FACTORY_V2.toLowerCase()
        ? served(input, [
            v2Creation(WETH, TOKEN_A, PAIR_A, 799, TX_ONE),
            v2Creation(WETH, TOKEN_B, PAIR_B, 798, TX_TWO),
          ])
        : served(input, []),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = createLiveTokensService(
      options({
        primary,
        analyze: async () => {
          await gate;
          return doneResult(12);
        },
      }),
    );
    const polling = service.pollOnce();
    await service.settled(50);
    const states = service.snapshot().items.map((entry) => entry.state).sort();
    expect(states).toEqual(["analyzing", "queued"]);
    release();
    await polling;
    await service.settled();
    expect(service.snapshot().items.map((entry) => entry.state).sort()).toEqual(["done", "done"]);
    service.stop();
  });

  test("concurrency 2 analyzes two queued items side by side", async () => {
    const primary = new FakeFeed((input) =>
      input.factory.toLowerCase() === FACTORY_V2.toLowerCase()
        ? served(input, [
            v2Creation(WETH, TOKEN_A, PAIR_A, 799, TX_ONE),
            v2Creation(WETH, TOKEN_B, PAIR_B, 798, TX_TWO),
          ])
        : served(input, []),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = createLiveTokensService(
      options({
        primary,
        concurrency: 2,
        analyze: async () => {
          await gate;
          return doneResult(12);
        },
      }),
    );
    const polling = service.pollOnce();
    await service.settled(50);
    expect(service.snapshot().items.map((entry) => entry.state).sort()).toEqual([
      "analyzing",
      "analyzing",
    ]);
    release();
    await polling;
    await service.settled();
    expect(service.snapshot().items.map((entry) => entry.state).sort()).toEqual(["done", "done"]);
    service.stop();
  });

  test("analysis queue drives state transitions including cant-tell and error", async () => {
    const primary = new FakeFeed((input) =>
      input.factory.toLowerCase() === FACTORY_V2.toLowerCase()
        ? served(input, [
            v2Creation(WETH, TOKEN_A, PAIR_A, 799, TX_ONE),
            v2Creation(WETH, TOKEN_B, PAIR_B, 798, TX_TWO),
          ])
        : served(input, []),
    );
    let calls = 0;
    const service = createLiveTokensService(
      options({
        primary,
        analyze: async (address: string): Promise<LiveTokensAnalyzeResult> => {
          calls += 1;
          if (address === TOKEN_A.toLowerCase()) {
            return { kind: "cant-tell", reason: "no contract code at the pinned block" };
          }
          return { kind: "error", reason: "rpc budget spent" };
        },
      }),
    );
    await service.pollOnce();
    await service.settled();
    expect(calls).toBe(2);
    const snapshot = service.snapshot();
    expect(snapshot.items.find((entry) => entry.tokenAddress === TOKEN_A.toLowerCase())).toMatchObject({
      state: "cant-tell",
      reason: "no contract code at the pinned block",
    });
    expect(snapshot.items.find((entry) => entry.tokenAddress === TOKEN_B.toLowerCase())).toMatchObject({
      state: "error",
      reason: "rpc budget spent",
    });
    // Newest first: block 799 before block 798.
    expect(snapshot.items[0]?.block).toBe(799);
  });

  test("queue bound drops the oldest queued entry as skipped", async () => {
    const logs: FeedLog[] = [];
    for (let index = 0; index < 51; index += 1) {
      const pair = `0x${(index + 1).toString(16).padStart(40, "0")}`;
      const token = `0x9${index.toString(16).padStart(39, "0")}`;
      logs.push(v2Creation(WETH, token, pair, 749 + index, txOf(index)));
    }
    const primary = new FakeFeed((input) =>
      input.factory.toLowerCase() === FACTORY_V2.toLowerCase() ? served(input, logs) : served(input, []),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = createLiveTokensService(
      options({
        primary,
        analyze: async () => {
          await gate;
          return doneResult(12);
        },
        maxQueued: 50,
      }),
    );
    const polling = service.pollOnce();
    await service.settled(50);
    release();
    await polling;
    await service.settled();
    const snapshot = service.snapshot();
    expect(snapshot.items).toHaveLength(51);
    const skipped = snapshot.items.filter((entry) => entry.state === "skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toContain("queue-full");
  });

  test("persistence round trips and restarts analyzing items as queued", async () => {
    const store = memoryStore();
    const primary = new FakeFeed((input) =>
      input.factory.toLowerCase() === FACTORY_V2.toLowerCase()
        ? served(input, [v2Creation(WETH, TOKEN_A, PAIR_A, 799, TX_ONE)])
        : served(input, []),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = createLiveTokensService(
      options({
        primary,
        store,
        analyze: async () => {
          await gate;
          return doneResult(12);
        },
      }),
    );
    const polling = first.pollOnce();
    await first.settled(50);
    release();
    await polling;
    first.stop();
    expect(store.saved.length).toBeGreaterThan(0);
    const second = createLiveTokensService(
      options({ primary, store, analyze: async () => doneResult(12), getLatestBlock: async () => 1005 }),
    );
    await second.pollOnce();
    await second.settled();
    // Restart resumes the persisted cursor instead of rewinding 300 blocks.
    const ranges = primary.calls.map((call) => [call.fromBlock, call.toBlock]);
    expect(ranges[ranges.length - 1]).toEqual([800, 899]);
    expect(second.snapshot().items[0]?.state).toBe("done");
    second.stop();
  });

  test("since filters to newer items only", async () => {
    const primary = new FakeFeed((input) =>
      input.factory.toLowerCase() === FACTORY_V2.toLowerCase()
        ? served(input, [v2Creation(WETH, TOKEN_A, PAIR_A, 799, TX_ONE)])
        : served(input, []),
    );
    const service = createLiveTokensService(options({ primary }));
    await service.pollOnce();
    expect(service.snapshot(1700000000001).items).toEqual([]);
    expect(service.snapshot(1699999999999).items).toHaveLength(1);
  });

  test("stops cleanly without dangling timers", async () => {
    const service = createLiveTokensService(options({ pollIntervalMs: 15_000 }));
    service.start();
    service.stop();
    service.stop();
  });

  test("uses the V3 Mint log for initial liquidity when present", async () => {
    const pad = (value: bigint): string => value.toString(16).padStart(64, "0");
    const amount0 = 250_000_000_000_000_000n;
    const amount1 = 500_000_000_000_000_000_000n;
    const primary = new FakeFeed((input) => {
      if (input.factory.toLowerCase() === FACTORY_V3.toLowerCase()) {
        return served(input, [v3Creation(TOKEN_A, WETH, 3000, POOL_V3, 799, TX_ONE)]);
      }
      if (input.factory.toLowerCase() === POOL_V3.toLowerCase()) {
        return served(input, [
          {
            address: POOL_V3,
            topics: [V3_MINT_TOPIC0],
            data: `0x${pad(1n)}${pad(2n)}${pad(3n)}${pad(4n)}${pad(5n)}${pad(amount0)}${pad(amount1)}`,
            blockNumber: 799,
            blockHash: BLOCK_HASH,
            txHash: TX_ONE,
            logIndex: 1,
            blockTimestampMs: chainMs(),
          },
        ]);
      }
      return served(input, []);
    });
    const service = createLiveTokensService(options({ primary, maxPairPollsPerCycle: 8 }));
    await service.pollOnce();
    expect(service.snapshot().items[0]?.initialLiquidityWeth).toBe("500");
  });

  test("age comes from the chain block time, not first-seen", async () => {
    // A pair created three hours earlier but first seen now reads three
    // hours old instead of a few seconds.
    const blockTime = chainMs(-3 * 3600 * 1000);
    const primary = new FakeFeed((input) =>
      input.factory.toLowerCase() === FACTORY_V2.toLowerCase()
        ? served(input, [v2Creation(WETH, TOKEN_A, PAIR_A, 799, TX_ONE, blockTime)])
        : served(input, []),
    );
    const service = createLiveTokensService(options({ primary }));
    await service.pollOnce();
    await service.settled();
    const entry = service.snapshot().items[0];
    expect(entry?.blockTimestampMs).toBe(blockTime);
    expect(entry?.createdAt).toBe(1700000000000);
    expect(entry?.ageSeconds).toBe(3 * 3600);
    service.stop();
  });

  test("unknown block time keeps an honest null age", async () => {
    const primary = new FakeFeed((input) =>
      input.factory.toLowerCase() === FACTORY_V2.toLowerCase()
        ? served(input, [v2Creation(WETH, TOKEN_A, PAIR_A, 799, TX_ONE, null)])
        : served(input, []),
    );
    const service = createLiveTokensService(options({ primary }));
    await service.pollOnce();
    await service.settled();
    const entry = service.snapshot().items[0];
    expect(entry?.blockTimestampMs).toBeNull();
    expect(entry?.ageSeconds).toBeNull();
    service.stop();
  });

  test("service order stays by block when logs arrive out of order", async () => {
    const primary = new FakeFeed((input) =>
      input.factory.toLowerCase() === FACTORY_V2.toLowerCase()
        ? served(input, [
            v2Creation(WETH, TOKEN_B, PAIR_B, 798, TX_TWO, chainMs(-10_000)),
            v2Creation(WETH, TOKEN_A, PAIR_A, 799, TX_ONE, chainMs()),
          ])
        : served(input, []),
    );
    const service = createLiveTokensService(options({ primary }));
    await service.pollOnce();
    await service.settled();
    expect(service.snapshot().items.map((entry) => entry.block)).toEqual([799, 798]);
    service.stop();
  });
});
