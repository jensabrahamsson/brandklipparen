// Market listing application service (DX-B1). Holds the server-side
// listing cache behind MarketNewReader and enriches each item with the
// analysis summary for tokens this server already analysed. The service
// never starts an analysis: enrichment reads solely through the injected
// lookup, and a missing entry leaves the item without an analysis field.
// Scoring, signals and evidence stay untouched.
import { MARKET_CHAIN } from "../ports/marketFeed.ts";
import type {
  MarketAnalysisLookup,
  MarketFeedPort,
  MarketNewReader,
  MarketSnapshot,
  MarketTokenItem,
} from "../ports/marketFeed.ts";

// Minimum server-side listing cache: a refresh younger than this is
// served as is, so bursts of callers share one provider answer.
export const MARKET_CACHE_TTL_MS = 30000;

export type MarketServiceOptions = {
  readonly feed: MarketFeedPort;
  // Read-only lookup over already-analysed tokens. Absent means no item
  // carries an analysis summary.
  readonly readAnalysis?: MarketAnalysisLookup | undefined;
  // Injected clock (milliseconds since the epoch). The application layer
  // never reads the system clock itself: the composition root supplies it.
  readonly now: () => number;
  // Lower values are clamped up to the minimum, so the cache never drops
  // below the contracted bound.
  readonly cacheTtlMs?: number | undefined;
};

export type MarketService = MarketNewReader & {
  // Test and diagnostic hook: listings skipped as invalid by the feed.
  readonly skippedFeedItems?: (() => number) | undefined;
};

export function createMarketService(options: MarketServiceOptions): MarketService {
  const feed = options.feed;
  const readAnalysis = options.readAnalysis;
  const now = options.now;
  const ttl =
    options.cacheTtlMs !== undefined &&
    Number.isSafeInteger(options.cacheTtlMs) &&
    options.cacheTtlMs > MARKET_CACHE_TTL_MS
      ? options.cacheTtlMs
      : MARKET_CACHE_TTL_MS;

  let cachedAt: number | null = null;
  let cachedItems: readonly MarketTokenItem[] = Object.freeze([]);

  function enrich(items: readonly MarketTokenItem[]): readonly MarketTokenItem[] {
    if (readAnalysis === undefined) {
      return items;
    }
    return Object.freeze(
      items.map((item) => {
        let summary = null;
        try {
          summary = readAnalysis(item.tokenAddress);
        } catch {
          summary = null;
        }
        if (summary === null) {
          return item;
        }
        return Object.freeze({ ...item, analysis: Object.freeze({ ...summary }) });
      }),
    );
  }

  async function getMarket(chain: string): Promise<MarketSnapshot> {
    const at = now();
    if (chain !== MARKET_CHAIN) {
      return {
        status: "unavailable",
        message: `unsupported chain: expected ${MARKET_CHAIN}`,
        updatedAt: cachedAt ?? at,
        items: Object.freeze([]),
      };
    }
    if (cachedAt !== null && at - cachedAt < ttl) {
      return { status: "live", updatedAt: cachedAt, items: enrich(cachedItems) };
    }
    let fetched;
    try {
      fetched = await feed.fetchNewTokens(
        { chain: MARKET_CHAIN },
        { requestId: `market-${at}`, deadlineMs: at + 30000 },
      );
    } catch {
      return {
        status: "unavailable",
        message: "the market listing is unavailable",
        updatedAt: cachedAt ?? at,
        items: Object.freeze([]),
      };
    }
    if (!fetched.ok) {
      if (fetched.error.kind === "not-configured") {
        return {
          status: "not-configured",
          message: "the market listing is not configured: set the market provider to dexscreener",
          updatedAt: cachedAt ?? at,
          items: Object.freeze([]),
        };
      }
      return {
        status: "unavailable",
        message: "the market listing is unavailable",
        updatedAt: cachedAt ?? at,
        items: Object.freeze([]),
      };
    }
    cachedAt = at;
    cachedItems = fetched.value.items;
    return { status: "live", updatedAt: cachedAt, items: enrich(cachedItems) };
  }

  return Object.freeze({ getMarket });
}
