// DexScreener market listing adapter behind MarketFeedPort (DX-B1).
// Driven adapter with an injectable GET transport: tests replay recorded
// synthetic fixtures and never touch the network. The public listing API
// needs no key. Reads run in three steps: the latest token profiles and
// the latest boosted tokens filtered to chainId "ethereum", then pair
// details per token batched into as few token-pairs calls as the endpoint
// allows. Invalid items are skipped with a count, never thrown, so one
// malformed listing cannot fail the refresh. The token bucket stays
// within the published per-minute budget; provider 429 answers trigger
// backoff with the wait carried in the error.
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import { MarketTokenItem } from "../../ports/marketFeed.ts";
import type {
  MarketCallContext,
  MarketFeedError,
  MarketFeedResult,
  MarketTokenItem as MarketTokenItemType,
} from "../../ports/marketFeed.ts";
import type { MarketFeedPort } from "../../ports/marketFeed.ts";
import { safeFetchText } from "../http/safeFetch.ts";

// Allowlisted outbound host (K-503, M-07): every request target derives
// from this pinned base URL plus validated path segments. A configured
// override must resolve to the same host, and each call re-checks the
// host before any transport runs, so crafted input can never steer a
// request off the allowlisted host.
export const DEXSCREENER_HOST = "api.dexscreener.com";
export const DEXSCREENER_BASE_URL = "https://api.dexscreener.com";

export type DexscreenerTransportResponse = {
  readonly status: number;
  readonly bodyText: string;
};

export type DexscreenerTransport = (url: string) => Promise<DexscreenerTransportResponse>;

async function fetchDexscreenerTransport(url: string): Promise<DexscreenerTransportResponse> {
  return safeFetchText(url, {
    timeoutMs: DEFAULT_DEXSCREENER_TIMEOUT_MS,
    maxBytes: DEFAULT_DEXSCREENER_MAX_RESPONSE_BYTES,
  });
}

export type DexscreenerAdapterOptions = {
  readonly baseUrl?: string | undefined;
  readonly callsPerSecond?: number | undefined;
  readonly burst?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
  readonly maxTokensPerRefresh?: number | undefined;
  readonly transport?: DexscreenerTransport | undefined;
  readonly now?: (() => number) | undefined;
};

// Sustained one call per second, well within the published per-minute
// budget; the server-side cache keeps refreshes far below even this.
// The burst covers one full refresh (profiles, boosts and one pair
// batch) without pacing its own calls.
export const DEFAULT_DEXSCREENER_CALLS_PER_SECOND = 1;
export const DEFAULT_DEXSCREENER_BURST = 5;
export const DEFAULT_DEXSCREENER_TIMEOUT_MS = 10000;
export const DEFAULT_DEXSCREENER_MAX_RESPONSE_BYTES = 1048576;
// The token-pairs endpoint accepts a comma-separated batch of token
// addresses; the refresh batches within this bound. Discovery itself is
// capped at the same count so one refresh stays at three calls.
export const DEXSCREENER_PAIR_BATCH_SIZE = 30;
export const DEFAULT_DEXSCREENER_MAX_TOKENS = 30;

type BucketState = {
  tokens: number;
  lastRefillMs: number;
  backoffUntilMs: number;
  backoffMs: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("dexscreener base URL must be an https URL on the allowlisted host");
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== DEXSCREENER_HOST) {
    throw new Error("dexscreener base URL must be an https URL on the allowlisted host");
  }
}

// Not-configured adapter: bound when the market provider selection is
// off. Every call answers `not-configured` with zero sends.
export class NotConfiguredMarketFeedAdapter implements MarketFeedPort {
  async fetchNewTokens(): Promise<Result<MarketFeedResult, MarketFeedError>> {
    return err({
      kind: "not-configured",
      message: "the market listing is not configured: set the market provider to dexscreener",
    });
  }
}

export class DexscreenerMarketFeedAdapter implements MarketFeedPort {
  private readonly baseUrl: string;
  private readonly callsPerSecond: number;
  private readonly burst: number;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxTokens: number;
  private readonly transport: DexscreenerTransport;
  private readonly now: () => number;
  private readonly bucket: BucketState;
  private readonly backoffBaseMs = 1000;

  // Listings skipped as invalid across refreshes on this adapter.
  private skippedItems = 0;

  constructor(options: DexscreenerAdapterOptions = {}) {
    const baseUrl = options.baseUrl ?? DEXSCREENER_BASE_URL;
    checkBaseUrl(baseUrl);
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    const rate = options.callsPerSecond ?? DEFAULT_DEXSCREENER_CALLS_PER_SECOND;
    this.callsPerSecond = Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_DEXSCREENER_CALLS_PER_SECOND;
    const burst = options.burst ?? DEFAULT_DEXSCREENER_BURST;
    this.burst = Number.isSafeInteger(burst) && burst > 0 ? burst : DEFAULT_DEXSCREENER_BURST;
    const timeout = options.timeoutMs ?? DEFAULT_DEXSCREENER_TIMEOUT_MS;
    this.timeoutMs = Number.isSafeInteger(timeout) && timeout > 0 ? timeout : DEFAULT_DEXSCREENER_TIMEOUT_MS;
    const cap = options.maxResponseBytes ?? DEFAULT_DEXSCREENER_MAX_RESPONSE_BYTES;
    this.maxResponseBytes =
      Number.isSafeInteger(cap) && cap > 0 ? cap : DEFAULT_DEXSCREENER_MAX_RESPONSE_BYTES;
    const maxTokens = options.maxTokensPerRefresh ?? DEFAULT_DEXSCREENER_MAX_TOKENS;
    this.maxTokens =
      Number.isSafeInteger(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_DEXSCREENER_MAX_TOKENS;
    this.transport = options.transport ?? fetchDexscreenerTransport;
    this.now = options.now ?? Date.now;
    const started = this.now();
    this.bucket = {
      tokens: this.burst,
      lastRefillMs: started,
      backoffUntilMs: 0,
      backoffMs: this.backoffBaseMs,
    };
  }

  // Invalid listings skipped across refreshes on this adapter.
  skippedItemCount(): number {
    return this.skippedItems;
  }

  async fetchNewTokens(
    input: { readonly chain: "ethereum" },
    ctx: MarketCallContext,
  ): Promise<Result<MarketFeedResult, MarketFeedError>> {
    if (input.chain !== "ethereum") {
      return err({ kind: "invalid-response", message: "the market listing serves ethereum only" });
    }
    const discovered = await this.discoverTokens(ctx);
    if (!discovered.ok) {
      return err(discovered.error);
    }
    if (discovered.value.length === 0) {
      return ok(Object.freeze({ items: Object.freeze([]) }));
    }
    const pairs = await this.fetchPairs(discovered.value, ctx);
    if (!pairs.ok) {
      return err(pairs.error);
    }
    return ok(Object.freeze({ items: Object.freeze(pairs.value) }));
  }

  // Discovery: latest profiles plus latest boosts, ethereum only, in
  // discovery order, deduplicated and capped so the refresh stays at a
  // bounded call count.
  private async discoverTokens(ctx: MarketCallContext): Promise<Result<readonly string[], MarketFeedError>> {
    const profiles = await this.getJson(`${this.baseUrl}/token-profiles/latest/v1`, ctx);
    if (!profiles.ok) {
      return err(profiles.error);
    }
    const boosts = await this.getJson(`${this.baseUrl}/token-boosts/latest/v1`, ctx);
    if (!boosts.ok) {
      return err(boosts.error);
    }
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const entry of [...profiles.value, ...boosts.value]) {
      if (!isRecord(entry)) {
        this.skippedItems += 1;
        continue;
      }
      if (entry["chainId"] !== "ethereum") {
        continue;
      }
      const raw = entry["tokenAddress"];
      if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(raw)) {
        this.skippedItems += 1;
        continue;
      }
      const key = raw.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      ordered.push(raw);
      if (ordered.length >= this.maxTokens) {
        break;
      }
    }
    return ok(Object.freeze(ordered));
  }

  private async fetchPairs(
    tokens: readonly string[],
    ctx: MarketCallContext,
  ): Promise<Result<readonly MarketTokenItemType[], MarketFeedError>> {
    const items: MarketTokenItemType[] = [];
    for (let start = 0; start < tokens.length; start += DEXSCREENER_PAIR_BATCH_SIZE) {
      const batch = tokens.slice(start, start + DEXSCREENER_PAIR_BATCH_SIZE);
      const url = `${this.baseUrl}/token-pairs/v1/ethereum/${batch.map((token) => token.toLowerCase()).join(",")}`;
      const fetched = await this.getJson(url, ctx);
      if (!fetched.ok) {
        return err(fetched.error);
      }
      const wanted = new Set(batch.map((token) => token.toLowerCase()));
      for (const raw of fetched.value) {
        const item = this.readPair(raw, wanted);
        if (item === null) {
          this.skippedItems += 1;
          continue;
        }
        items.push(item);
      }
    }
    // One row per token: the newest listing wins, so the feed reads as
    // newly listed first. Stable within equal timestamps.
    const newest = new Map<string, MarketTokenItemType>();
    for (const item of items) {
      const key = item.tokenAddress.toLowerCase();
      const held = newest.get(key);
      if (held === undefined || item.createdAt > held.createdAt) {
        newest.set(key, item);
      }
    }
    const deduped = [...newest.values()].sort((left, right) => right.createdAt - left.createdAt);
    return ok(Object.freeze(deduped));
  }

  // One pair record to one validated item, or null when the record is
  // unusable. The token side (base or quote) matching the discovered
  // address lends the symbol and name.
  private readPair(raw: unknown, wanted: ReadonlySet<string>): MarketTokenItemType | null {
    if (!isRecord(raw)) {
      return null;
    }
    if (raw["chainId"] !== "ethereum") {
      return null;
    }
    const pairAddress = raw["pairAddress"];
    if (typeof pairAddress !== "string") {
      return null;
    }
    const dex = raw["dexId"];
    const createdAt = raw["pairCreatedAt"];
    const base = isRecord(raw["baseToken"]) ? raw["baseToken"] : null;
    const quote = isRecord(raw["quoteToken"]) ? raw["quoteToken"] : null;
    const baseAddress = typeof base?.["address"] === "string" ? (base["address"] as string) : null;
    const quoteAddress = typeof quote?.["address"] === "string" ? (quote["address"] as string) : null;
    const side =
      baseAddress !== null && wanted.has(baseAddress.toLowerCase())
        ? base
        : quoteAddress !== null && wanted.has(quoteAddress.toLowerCase())
          ? quote
          : null;
    if (side === null) {
      return null;
    }
    const tokenAddress = typeof side["address"] === "string" ? (side["address"] as string) : null;
    if (tokenAddress === null) {
      return null;
    }
    const liquidity = isRecord(raw["liquidity"]) ? raw["liquidity"]["usd"] : null;
    const volume = isRecord(raw["volume"]) ? raw["volume"] : null;
    const priceChange = isRecord(raw["priceChange"]) ? raw["priceChange"] : null;
    const built = MarketTokenItem.create({
      tokenAddress,
      symbol: side["symbol"] ?? null,
      name: side["name"] ?? null,
      pairAddress,
      dex: typeof dex === "string" ? dex : "",
      createdAt: typeof createdAt === "number" ? createdAt : Number.NaN,
      liquidityUsd: liquidity === undefined ? null : liquidity,
      volume1hUsd: volume !== null && volume["h1"] !== undefined ? volume["h1"] : null,
      volume24hUsd: volume !== null && volume["h24"] !== undefined ? volume["h24"] : null,
      priceChange24hPct:
        priceChange !== null && priceChange["h24"] !== undefined ? priceChange["h24"] : null,
    });
    if (!built.ok) {
      return null;
    }
    return built.value;
  }

  // One GET round trip with the token bucket, the deadline, the response
  // size cap and the allowlist host re-check. Returns the top-level array
  // entries; a non-array top level is an invalid response, never a crash.
  private async getJson(url: string, ctx: MarketCallContext): Promise<Result<readonly unknown[], MarketFeedError>> {
    const allowed = this.allowlistedUrl(url);
    if (allowed === null) {
      return err({ kind: "unavailable", message: "the market listing target is not allowlisted" });
    }
    const at = this.now();
    if (at > ctx.deadlineMs) {
      return err({ kind: "timeout", message: "market listing exceeded its deadline" });
    }
    this.refill(at);
    if (at < this.bucket.backoffUntilMs) {
      return err({
        kind: "rate-limited",
        message: "market listing backs off after a provider rate-limit answer",
        retryAfterMs: this.bucket.backoffUntilMs - at,
        scope: "provider",
      });
    }
    if (this.bucket.tokens < 1) {
      return err({
        kind: "rate-limited",
        message: "market listing token bucket is empty",
        retryAfterMs: Math.ceil(1000 / this.callsPerSecond),
        scope: "local",
      });
    }
    this.bucket.tokens -= 1;
    let response: DexscreenerTransportResponse;
    try {
      response = await this.withTimeout(allowed);
    } catch {
      return err({ kind: "unavailable", message: "market listing source is unavailable" });
    }
    if (response.status === 429) {
      return err(this.enterBackoff("market listing source rate limited the request", at));
    }
    if (new TextEncoder().encode(response.bodyText).length > this.maxResponseBytes) {
      return err({ kind: "invalid-response", message: "market listing source gave an oversize reply" });
    }
    let body: unknown;
    try {
      body = JSON.parse(response.bodyText) as unknown;
    } catch {
      return err({ kind: "invalid-response", message: "market listing source gave a non-JSON reply" });
    }
    if (!Array.isArray(body)) {
      return err({ kind: "invalid-response", message: "market listing source gave an unknown shape" });
    }
    this.bucket.backoffMs = this.backoffBaseMs;
    return ok(Object.freeze(body.slice()));
  }

  // Defence in depth (K-503): the request target is re-derived from the
  // allowlisted host on every call, so a crafted value can never steer
  // the transport off host. Null means no transport runs.
  private allowlistedUrl(url: string): string | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== DEXSCREENER_HOST) {
      return null;
    }
    return url;
  }

  private refill(at: number): void {
    const elapsedMs = Math.max(0, at - this.bucket.lastRefillMs);
    this.bucket.tokens = Math.min(
      this.burst,
      this.bucket.tokens + (elapsedMs / 1000) * this.callsPerSecond,
    );
    this.bucket.lastRefillMs = at;
  }

  private enterBackoff(message: string, at: number): MarketFeedError {
    const waitMs = this.bucket.backoffMs;
    this.bucket.backoffUntilMs = at + waitMs;
    this.bucket.backoffMs = Math.min(waitMs * 2, 60000);
    return { kind: "rate-limited", message, retryAfterMs: waitMs, scope: "provider" };
  }

  private async withTimeout(url: string): Promise<DexscreenerTransportResponse> {
    const pending = this.transport(url);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const onTimeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("market listing timed out")), this.timeoutMs);
      });
      return await Promise.race([pending, onTimeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}

// Binds the listing adapter for the dexscreener selection, and the
// not-configured adapter for off. Missing values never fail startup: the
// listing stays idle until the operator selects it.
export function createMarketFeedAdapter(
  provider: "dexscreener" | "off" | undefined,
  options: DexscreenerAdapterOptions = {},
): DexscreenerMarketFeedAdapter | NotConfiguredMarketFeedAdapter {
  if (provider === undefined || provider === "off") {
    return new NotConfiguredMarketFeedAdapter();
  }
  return new DexscreenerMarketFeedAdapter(options);
}
