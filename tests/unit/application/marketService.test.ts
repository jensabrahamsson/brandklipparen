// Market listing service (DX-B1): the server-side cache bound, the
// read-only analysis enrichment and the typed provider states. Fake feed
// and fake clock only; no network, no real analyses.
import { describe, expect, test } from "vitest";
import { Address } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import { err, ok } from "../../../src/domain/result.ts";
import {
  MARKET_BUFFER_MAX_ITEMS,
  MARKET_BUFFER_TTL_MS,
  MARKET_CACHE_TTL_MS,
  MARKET_REFRESH_MS,
  createMarketService,
} from "../../../src/application/marketService.ts";
import type {
  MarketAnalysisLookup,
  MarketFeedError,
  MarketFeedPort,
  MarketFeedResult,
  MarketTokenItem,
} from "../../../src/ports/marketFeed.ts";
import { syntheticAddress } from "../../helpers/syntheticAddresses.ts";

function checksum(raw: string): string {
  const parsed = Address.parse(raw);
  if (!parsed.ok) {
    throw new Error(`synthetic address must parse: ${raw}`);
  }
  return parsed.value as string;
}

function item(tokenIndex: number, pairIndex: number): MarketTokenItem {
  return Object.freeze({
    tokenAddress: checksum(syntheticAddress(tokenIndex)),
    symbol: "SYN",
    name: "Synthetic Token",
    pairAddress: checksum(syntheticAddress(pairIndex)),
    dex: "uniswap",
    createdAt: 1700000000000,
    liquidityUsd: 100,
    volume1hUsd: 10,
    volume24hUsd: 50,
    priceChange24hPct: null,
  });
}

class FakeFeed implements MarketFeedPort {
  calls = 0;
  private readonly answer: Result<MarketFeedResult, MarketFeedError>;
  constructor(answer: Result<MarketFeedResult, MarketFeedError>) {
    this.answer = answer;
  }

  async fetchNewTokens(): Promise<Result<MarketFeedResult, MarketFeedError>> {
    this.calls += 1;
    return this.answer;
  }
}

describe("market listing service", () => {
  test("the server-side cache holds for at least 30 seconds", async () => {
    expect(MARKET_CACHE_TTL_MS).toBeGreaterThanOrEqual(30000);
    expect(MARKET_REFRESH_MS).toBeGreaterThanOrEqual(60000);
    let at = 1700000100000;
    const feed = new FakeFeed(ok({ items: [item(51, 61)] }));
    const service = createMarketService({ feed, now: () => at });
    const first = await service.getMarket("ethereum");
    expect(first.status).toBe("live");
    expect(first.updatedAt).toBe(at);
    expect(first.items).toHaveLength(1);
    at += 29000;
    const cached = await service.getMarket("ethereum");
    expect(cached.updatedAt).toBe(1700000100000);
    expect(feed.calls).toBe(1);
    // The rolling buffer refreshes about once a minute (W-13): at 31 s
    // the buffer still serves with zero provider calls.
    at += 2000;
    const stillCached = await service.getMarket("ethereum");
    expect(stillCached.updatedAt).toBe(1700000100000);
    expect(feed.calls).toBe(1);
    at += 30000;
    const refreshed = await service.getMarket("ethereum");
    expect(refreshed.updatedAt).toBe(1700000161000);
    expect(feed.calls).toBe(2);
  });

  test("a shorter configured ttl clamps up to the minimum", async () => {
    let at = 1700000100000;
    const feed = new FakeFeed(ok({ items: [item(52, 62)] }));
    const service = createMarketService({ feed, now: () => at, cacheTtlMs: 1000 });
    await service.getMarket("ethereum");
    at += 5000;
    await service.getMarket("ethereum");
    expect(feed.calls).toBe(1);
  });

  test("analysis attaches solely from the lookup and never starts work", async () => {
    const feed = new FakeFeed(ok({ items: [item(53, 63), item(54, 64)] }));
    const seen: string[] = [];
    const lookup: MarketAnalysisLookup = (tokenAddress: string) => {
      seen.push(tokenAddress);
      if (tokenAddress.toLowerCase() === syntheticAddress(53).toLowerCase()) {
        return { score: 12, powersFound: 2, powersExtended: 1 };
      }
      return null;
    };
    const service = createMarketService({ feed, readAnalysis: lookup, now: () => 1700000100000 });
    const snapshot = await service.getMarket("ethereum");
    expect(snapshot.status).toBe("live");
    expect(snapshot.items[0]).toMatchObject({
      analysis: { score: 12, powersFound: 2, powersExtended: 1 },
    });
    expect(snapshot.items[1]).not.toHaveProperty("analysis");
    // The lookup ran once per listed token and never triggered provider
    // work: the only feed call is the listing refresh itself.
    expect(seen).toHaveLength(2);
    expect(feed.calls).toBe(1);
  });

  test("a throwing lookup leaves the item plain instead of failing", async () => {
    const feed = new FakeFeed(ok({ items: [item(55, 65)] }));
    const service = createMarketService({
      feed,
      readAnalysis: () => {
        throw new Error("lookup failed");
      },
      now: () => 1700000100000,
    });
    const snapshot = await service.getMarket("ethereum");
    expect(snapshot.status).toBe("live");
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).not.toHaveProperty("analysis");
  });

  test("w13_the_buffer_dedups_tokens_and_prunes_after_24h", async () => {
    expect(MARKET_BUFFER_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(MARKET_BUFFER_MAX_ITEMS).toBeGreaterThanOrEqual(100);
    const base = 1700000100000;
    let at = base;
    // A feed that answers a fresh listing per call: the first refresh
    // holds two tokens, the second repeats one with newer market data.
    const answers: Array<Result<MarketFeedResult, MarketFeedError>> = [
      ok({ items: [item(51, 61), item(52, 62)] }),
      ok({ items: [{ ...item(51, 61), liquidityUsd: 999 }, item(53, 63)] }),
    ];
    let calls = 0;
    const feed = {
      async fetchNewTokens(): Promise<Result<MarketFeedResult, MarketFeedError>> {
        const answer = answers[Math.min(calls, answers.length - 1)];
        calls += 1;
        if (answer === undefined) {
          throw new Error("no answer");
        }
        return answer;
      },
    } satisfies MarketFeedPort;
    const service = createMarketService({ feed, now: () => at });
    const first = await service.getMarket("ethereum");
    expect(first.items).toHaveLength(2);
    at += MARKET_REFRESH_MS + 1000;
    const second = await service.getMarket("ethereum");
    // Token 51 appears once with refreshed market data; token 52 from the
    // first refresh survives beside the new token 53.
    const tokens = second.items.map((entry) => entry.tokenAddress.toLowerCase());
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(tokens).toHaveLength(3);
    expect(second.items.find((entry) => entry.tokenAddress.toLowerCase() === syntheticAddress(51).toLowerCase()))
      .toMatchObject({ liquidityUsd: 999 });
    // Past 24 h the first listing ages out of the rolling buffer.
    at += MARKET_BUFFER_TTL_MS + MARKET_REFRESH_MS;
    const pruned = await service.getMarket("ethereum");
    expect(pruned.items.map((entry) => entry.tokenAddress.toLowerCase())).not.toContain(
      syntheticAddress(52).toLowerCase(),
    );
  });

  test("w13_a_failed_refresh_serves_the_buffered_list", async () => {
    const base = 1700000100000;
    let at = base;
    let failing = false;
    const feed = {
      async fetchNewTokens(): Promise<Result<MarketFeedResult, MarketFeedError>> {
        if (failing) {
          return err({ kind: "unavailable", message: "down" });
        }
        return ok({ items: [item(51, 61)] });
      },
    } satisfies MarketFeedPort;
    const service = createMarketService({ feed, now: () => at });
    const first = await service.getMarket("ethereum");
    expect(first.status).toBe("live");
    failing = true;
    at += MARKET_REFRESH_MS + 1000;
    const stale = await service.getMarket("ethereum");
    // The buffered list survives a failed refresh instead of blinking out.
    expect(stale.status).toBe("live");
    expect(stale.updatedAt).toBe(base);
    expect(stale.items).toHaveLength(1);
  });

  test("provider states map to typed snapshots with empty items", async () => {
    const off = createMarketService({
      feed: new FakeFeed(err({ kind: "not-configured", message: "off" })),
      now: () => 1700000100000,
    });
    const disabled = await off.getMarket("ethereum");
    expect(disabled.status).toBe("not-configured");
    expect(disabled.items).toEqual([]);
    const down = createMarketService({
      feed: new FakeFeed(err({ kind: "unavailable", message: "down" })),
      now: () => 1700000100000,
    });
    const unavailable = await down.getMarket("ethereum");
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.items).toEqual([]);
    const other = await down.getMarket("solana");
    expect(other.status).toBe("unavailable");
    expect(other.items).toEqual([]);
  });
});
