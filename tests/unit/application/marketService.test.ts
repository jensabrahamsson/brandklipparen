// Market listing service (DX-B1): the server-side cache bound, the
// read-only analysis enrichment and the typed provider states. Fake feed
// and fake clock only; no network, no real analyses.
import { describe, expect, test } from "vitest";
import { Address } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import { err, ok } from "../../../src/domain/result.ts";
import { MARKET_CACHE_TTL_MS, createMarketService } from "../../../src/application/marketService.ts";
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
    at += 2000;
    const refreshed = await service.getMarket("ethereum");
    expect(refreshed.updatedAt).toBe(1700000131000);
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
