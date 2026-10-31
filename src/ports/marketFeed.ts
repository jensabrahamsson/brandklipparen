// MarketFeedPort: newly listed tokens on Ethereum mainnet from the public
// market listing source (DX-B1). The port is owned by the core: the
// application service refreshes one chain listing per call and receives
// validated items; scoring, signals and evidence stay untouched. Two
// adapters implement this port: the public listing adapter (primary) and
// the not-configured adapter when the provider selection is off. Tests
// inject fake transports with recorded synthetic fixtures and never reach
// the network. Ports import the domain only.
import { err, ok } from "../domain/result.ts";
import type { Result } from "../domain/result.ts";
import { Address } from "../domain/types.ts";

// Supported listing chain. The route serves ethereum only; any other
// chain value fails validation before the service runs.
export const MARKET_CHAIN = "ethereum" as const;
export type MarketChain = typeof MARKET_CHAIN;

// Analysis summary for a token this server already analysed. The service
// attaches it read-only from the injected lookup; a missing entry leaves
// the item without an analysis field, and the service never starts an
// analysis by itself.
export type MarketAnalysisSummary = {
  readonly score: number;
  readonly powersFound: number;
  readonly powersExtended: number;
};

// Read-only lookup over the cache of already-analysed tokens, keyed by
// token address in any hex case. Returns null when the token has no
// recorded analysis. Synchronous and side-effect free by contract: the
// market path must never trigger an analysis.
export type MarketAnalysisLookup = (tokenAddress: string) => MarketAnalysisSummary | null;

// One listed token as served: addresses in full EIP-55 form, money fields
// as USD numbers or null when the source did not report them.
export type MarketTokenItem = {
  readonly tokenAddress: string;
  readonly symbol: string | null;
  readonly name: string | null;
  readonly pairAddress: string;
  readonly dex: string;
  readonly createdAt: number;
  readonly liquidityUsd: number | null;
  readonly volume1hUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly analysis?: MarketAnalysisSummary | undefined;
};

export type MarketStatus = "live" | "unavailable" | "not-configured";

export type MarketSnapshot = {
  readonly status: MarketStatus;
  readonly message?: string | undefined;
  readonly updatedAt: number;
  readonly items: readonly MarketTokenItem[];
};

// Error union per A-15. `not-configured` answers with the provider off
// with zero sends; `rate-limited` covers the token bucket and provider
// rate-limit answers, carrying the wait before retry. The scope tells our
// own budget pacing (`local`) apart from a provider refusal (`provider`).
export type MarketFeedError =
  | { kind: "not-configured"; message: string }
  | { kind: "rate-limited"; message: string; retryAfterMs: number; scope?: "local" | "provider" | undefined }
  | { kind: "timeout"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "invalid-response"; message: string };

export type MarketFeedResult = {
  readonly items: readonly MarketTokenItem[];
};

// Per-port limits per A-17. Values come from the operational
// configuration; the port only names the fields.
export type MarketFeedLimits = {
  readonly timeoutMs: number;
  readonly callsPerSecond: number;
  readonly maxResponseBytes: number;
};

export type MarketCallContext = {
  readonly requestId: string;
  readonly deadlineMs: number;
};

export interface MarketFeedPort {
  fetchNewTokens(
    input: { readonly chain: MarketChain },
    ctx: MarketCallContext,
  ): Promise<Result<MarketFeedResult, MarketFeedError>>;
}

// Served listing reader behind GET /v1/market-new. The application
// service snapshot behind this reader holds the server-side cache, so the
// REST driving adapter reads snapshots through this port only.
export interface MarketNewReader {
  getMarket(chain: string): Promise<MarketSnapshot>;
}

// Validated market item constructor: checksummed addresses, a dated
// listing and finite money fields. Invalid items are rejected with a
// reason, never thrown, so the caller can skip them and keep the rest.
export const MarketTokenItem = {
  create(input: {
    readonly tokenAddress: string;
    readonly symbol: unknown;
    readonly name: unknown;
    readonly pairAddress: string;
    readonly dex: unknown;
    readonly createdAt: unknown;
    readonly liquidityUsd: unknown;
    readonly volume1hUsd: unknown;
    readonly volume24hUsd: unknown;
  }): Result<MarketTokenItem, { kind: "invalid-market-item"; message: string }> {
    const token = Address.parse(input.tokenAddress);
    if (!token.ok) {
      return err({ kind: "invalid-market-item", message: "token address must be a 0x address" });
    }
    const pair = Address.parse(input.pairAddress);
    if (!pair.ok) {
      return err({ kind: "invalid-market-item", message: "pair address must be a 0x address" });
    }
    if (typeof input.dex !== "string" || input.dex.length === 0 || input.dex.length > 64) {
      return err({ kind: "invalid-market-item", message: "dex must be a short non-empty label" });
    }
    if (
      typeof input.createdAt !== "number" ||
      !Number.isSafeInteger(input.createdAt) ||
      input.createdAt < 0
    ) {
      return err({ kind: "invalid-market-item", message: "createdAt must hold milliseconds since the epoch" });
    }
    const symbol =
      typeof input.symbol === "string" && input.symbol.length > 0 && input.symbol.length <= 32
        ? input.symbol
        : null;
    const name =
      typeof input.name === "string" && input.name.length > 0 && input.name.length <= 128
        ? input.name
        : null;
    const money = (
      value: unknown,
    ): Result<number | null, { kind: "invalid-market-item"; message: string }> => {
      if (value === null || value === undefined) {
        return ok(null);
      }
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        return err({ kind: "invalid-market-item", message: "money fields must be finite numbers or null" });
      }
      return ok(value);
    };
    const liquidity = money(input.liquidityUsd);
    if (!liquidity.ok) {
      return err(liquidity.error);
    }
    const volume1h = money(input.volume1hUsd);
    if (!volume1h.ok) {
      return err(volume1h.error);
    }
    const volume24h = money(input.volume24hUsd);
    if (!volume24h.ok) {
      return err(volume24h.error);
    }
    return ok(
      Object.freeze({
        tokenAddress: token.value as string,
        symbol,
        name,
        pairAddress: pair.value as string,
        dex: input.dex,
        createdAt: input.createdAt,
        liquidityUsd: liquidity.value,
        volume1hUsd: volume1h.value,
        volume24hUsd: volume24h.value,
      }),
    );
  },
};
