// Market listing application service (DX-B1, W-13). Holds the server-side
// listing buffer behind MarketNewReader and enriches each item with the
// analysis summary for tokens this server already analysed. The service
// never starts an analysis: enrichment reads solely through the injected
// lookup, and a missing entry leaves the item without an analysis field.
// Scoring, signals and evidence stay untouched.
//
// W-13 rolling buffer: DexScreener's profile/boost feeds usually carry
// ~0-1 Ethereum tokens per refresh, so the service keeps a rolling 24 h
// buffer of Ethereum entries instead of serving one thin refresh. Each
// getMarket refreshes at most about once a minute (the injected clock
// decides; the cache survives requests in between), merges the fresh
// items deduped by token, drops entries older than 24 h and caps the
// buffer at a bounded size, newest first. A failed refresh still serves
// the buffered list as live, so the list fills over time instead of
// blinking out.
import { MARKET_CHAIN } from "../ports/marketFeed.ts";
import type {
  MarketAnalysisLookup,
  MarketFeedPort,
  MarketNewReader,
  MarketSnapshot,
  MarketTokenItem,
} from "../ports/marketFeed.ts";

// Minimum server-side listing cadence: a refresh younger than this is
// served from the buffer, so bursts of callers share one provider answer.
export const MARKET_CACHE_TTL_MS = 30000;
// The rolling buffer refreshes at most about once a minute, matching the
// provider's per-minute budget (W-13).
export const MARKET_REFRESH_MS = 60000;
// The buffer holds one rolling day of Ethereum entries (W-13).
export const MARKET_BUFFER_TTL_MS = 24 * 60 * 60 * 1000;
// Bounded buffer size: the newest entries win (W-13).
export const MARKET_BUFFER_MAX_ITEMS = 200;

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

type BufferedEntry = {
  readonly item: MarketTokenItem;
  // First instant the service held this token, for future buffer ageing.
  readonly firstSeenAt: number;
};

export function createMarketService(options: MarketServiceOptions): MarketService {
  const feed = options.feed;
  const readAnalysis = options.readAnalysis;
  const now = options.now;
  const ttl =
    options.cacheTtlMs !== undefined &&
    Number.isSafeInteger(options.cacheTtlMs) &&
    options.cacheTtlMs > MARKET_REFRESH_MS
      ? options.cacheTtlMs
      : MARKET_REFRESH_MS;

  // Rolling 24 h buffer of Ethereum entries, keyed by lowercase token.
  const buffer = new Map<string, BufferedEntry>();
  let lastRefreshAt: number | null = null;
  let lastAttemptAt: number | null = null;

  function bufferItems(): readonly MarketTokenItem[] {
    return Object.freeze(
      [...buffer.values()]
        .map((entry) => entry.item)
        .sort((left, right) => right.createdAt - left.createdAt),
    );
  }

  function merge(items: readonly MarketTokenItem[], at: number): void {
    for (const item of items) {
      const key = item.tokenAddress.toLowerCase();
      const held = buffer.get(key);
      // A re-seen token refreshes its market data but keeps its first-seen
      // instant, so the buffer ages entries by listing, not by refresh.
      buffer.set(key, held === undefined ? { item, firstSeenAt: at } : { item, firstSeenAt: held.firstSeenAt });
    }
    const cutoff = at - MARKET_BUFFER_TTL_MS;
    for (const [key, entry] of buffer) {
      if (entry.item.createdAt < cutoff) {
        buffer.delete(key);
      }
    }
    if (buffer.size > MARKET_BUFFER_MAX_ITEMS) {
      const newest = [...buffer.entries()].sort(
        ([, left], [, right]) => right.item.createdAt - left.item.createdAt,
      );
      buffer.clear();
      for (const [key, entry] of newest.slice(0, MARKET_BUFFER_MAX_ITEMS)) {
        buffer.set(key, entry);
      }
    }
  }

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
        updatedAt: lastRefreshAt ?? at,
        items: Object.freeze([]),
      };
    }
    // The buffer survives requests: a fresh buffer serves with zero
    // provider calls until the refresh cadence elapses.
    if (lastAttemptAt !== null && at - lastAttemptAt < ttl) {
      return { status: "live", updatedAt: lastRefreshAt ?? at, items: enrich(bufferItems()) };
    }
    lastAttemptAt = at;
    let fetched;
    try {
      fetched = await feed.fetchNewTokens(
        { chain: MARKET_CHAIN },
        { requestId: `market-${at}`, deadlineMs: at + 30000 },
      );
    } catch {
      return serveOrUnavailable(at);
    }
    if (!fetched.ok) {
      if (fetched.error.kind === "not-configured") {
        return {
          status: "not-configured",
          message: "the market listing is not configured: set the market provider to dexscreener",
          updatedAt: lastRefreshAt ?? at,
          items: Object.freeze([]),
        };
      }
      return serveOrUnavailable(at);
    }
    lastRefreshAt = at;
    merge(fetched.value.items, at);
    return { status: "live", updatedAt: lastRefreshAt, items: enrich(bufferItems()) };
  }

  // A failed refresh keeps serving the buffered list as live while the
  // buffer holds entries; only an empty buffer answers unavailable.
  function serveOrUnavailable(at: number): MarketSnapshot {
    if (buffer.size > 0) {
      return { status: "live", updatedAt: lastRefreshAt ?? at, items: enrich(bufferItems()) };
    }
    return {
      status: "unavailable",
      message: "the market listing is unavailable",
      updatedAt: lastRefreshAt ?? at,
      items: Object.freeze([]),
    };
  }

  return Object.freeze({ getMarket });
}
