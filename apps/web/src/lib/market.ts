// DexScreener market listing client (DX-1): typed fetch over the
// versioned REST API plus display mapping. Contract values travel as
// inert JSON text and render as text only. The scanner is mainnet-only,
// so items from any other chain are dropped here as well as server-side;
// money fields the source did not report stay null and render as the
// honest "can't tell", never a bare dash. Volume reads 1 h for young
// pairs and 24 h once a pair is a day old (24 h volume is meaningless
// for a 12-minute-old pair).
import { ApiError } from "./api.ts";

export type MarketStatus = "live" | "unavailable" | "not-configured";

export type MarketAnalysisSummary = {
  readonly score: number;
  readonly powersFound: number;
  readonly powersExtended: number;
};

export type MarketItem = {
  readonly tokenAddress: string;
  readonly symbol: string | null;
  readonly name: string | null;
  readonly pairAddress: string;
  readonly dex: string;
  readonly createdAt: number;
  readonly liquidityUsd: number | null;
  readonly volume1hUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly priceChange24hPct: number | null;
  readonly analysis?: MarketAnalysisSummary | undefined;
};

export type MarketSnapshot = {
  readonly status: Exclude<MarketStatus, "unavailable">;
  readonly updatedAt: number;
  readonly items: readonly MarketItem[];
};

// One day in milliseconds: the age at which a row switches from 1 h to
// 24 h volume (DX-1 §A3.2).
export const MARKET_VOLUME_SWITCH_MS = 24 * 60 * 60 * 1000;

// The market header counts as stale after five minutes without a
// successful refresh (DX-1 §A3.1), mirroring the on-chain feed's honesty:
// a stuck feed reads as stale instead of merely old.
export const MARKET_STALE_AFTER_MS = 5 * 60 * 1000;

export function marketAgeSeconds(createdAt: number, nowMs: number): number | null {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0 || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    return null;
  }
  return Math.max(0, Math.floor((nowMs - createdAt) / 1000));
}

function marketHumanDuration(totalSeconds: number): string {
  if (totalSeconds < 60) {
    return `${totalSeconds} s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} h`;
  }
  return `${Math.floor(hours / 24)} d`;
}

export function marketStatusLabel(updatedAt: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - updatedAt) / 1000));
  if (nowMs - updatedAt > MARKET_STALE_AFTER_MS) {
    return `Stale · updated ${marketHumanDuration(seconds)} ago`;
  }
  if (seconds < 5) {
    return "Updated just now";
  }
  return `Updated ${marketHumanDuration(seconds)} ago`;
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function isFiniteMoney(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function moneyOrNull(value: unknown): number | null {
  return isFiniteMoney(value) ? value : null;
}

function textOrNull(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
}

function analysisOrUndefined(value: unknown): MarketAnalysisSummary | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const { score, powersFound, powersExtended } = record;
  if (
    typeof score !== "number" ||
    !Number.isInteger(score) ||
    score < 0 ||
    score > 100 ||
    typeof powersFound !== "number" ||
    !Number.isInteger(powersFound) ||
    powersFound < 0 ||
    typeof powersExtended !== "number" ||
    !Number.isInteger(powersExtended) ||
    powersExtended < 0
  ) {
    return undefined;
  }
  return { score, powersFound, powersExtended };
}

// One raw listing record to a validated item, or null when it cannot be
// shown honestly. Records naming another chain are dropped: the scanner
// reads mainnet only. The DexScreener pair record carries no address
// checksum proof, so shape is validated but case is preserved as sent.
export function parseMarketItem(raw: unknown): MarketItem | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  // Only ethereum rows are shown; a present non-ethereum chain id drops
  // the item. Absent chain ids (older servers) stay, since /v1/market-new
  // already serves ethereum only.
  if (record["chainId"] !== undefined && record["chainId"] !== "ethereum") {
    return null;
  }
  const tokenAddress = record["tokenAddress"];
  const pairAddress = record["pairAddress"];
  const dex = record["dex"];
  const createdAt = record["createdAt"];
  if (
    typeof tokenAddress !== "string" ||
    !ADDRESS_PATTERN.test(tokenAddress) ||
    typeof pairAddress !== "string" ||
    !ADDRESS_PATTERN.test(pairAddress) ||
    typeof dex !== "string" ||
    dex.length === 0 ||
    dex.length > 64 ||
    typeof createdAt !== "number" ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0
  ) {
    return null;
  }
  return {
    tokenAddress,
    symbol: textOrNull(record["symbol"], 32),
    name: textOrNull(record["name"], 128),
    pairAddress,
    dex,
    createdAt,
    liquidityUsd: moneyOrNull(record["liquidityUsd"]),
    volume1hUsd: moneyOrNull(record["volume1hUsd"]),
    volume24hUsd: moneyOrNull(record["volume24hUsd"]),
    priceChange24hPct:
      typeof record["priceChange24hPct"] === "number" && Number.isFinite(record["priceChange24hPct"])
        ? record["priceChange24hPct"]
        : null,
    ...(analysisOrUndefined(record["analysis"]) === undefined
      ? {}
      : { analysis: analysisOrUndefined(record["analysis"]) as MarketAnalysisSummary }),
  };
}

export function parseMarketSnapshot(body: unknown): MarketSnapshot | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const updatedAt = record["updatedAt"];
  const items = record["items"];
  if (
    typeof updatedAt !== "number" ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt < 0 ||
    !Array.isArray(items)
  ) {
    return null;
  }
  const parsed: MarketItem[] = [];
  for (const raw of items) {
    const item = parseMarketItem(raw);
    if (item !== null) {
      parsed.push(item);
    }
  }
  // Newest listing first, stable within equal timestamps.
  parsed.sort((left, right) => right.createdAt - left.createdAt);
  return { status: "live", updatedAt, items: Object.freeze(parsed) };
}

function readError(response: Response, fallbackCode: string): Promise<ApiError> {
  const fallback = new ApiError(fallbackCode, response.status, `Request failed with status ${response.status}.`);
  return response
    .json()
    .then((body) => {
      const record = body as { code?: unknown; message?: unknown };
      const code = typeof record.code === "string" && record.code.length > 0 ? record.code : fallbackCode;
      const message =
        typeof record.message === "string" && record.message.length > 0
          ? record.message
          : `Request failed with status ${response.status}.`;
      return new ApiError(code, response.status, message);
    })
    .catch(() => fallback);
}

export async function fetchMarketNew(apiKey: string | null): Promise<MarketSnapshot> {
  const headers: Record<string, string> = apiKey === null || apiKey.length === 0 ? {} : { "x-api-key": apiKey };
  const response = await fetch("/v1/market-new?chain=ethereum", { headers });
  if (!response.ok) {
    const failure = await readError(response, "request-failed");
    if (failure.code === "market-not-configured" || response.status === 501) {
      return { status: "not-configured", updatedAt: Date.now(), items: Object.freeze([]) };
    }
    throw failure;
  }
  const parsed = parseMarketSnapshot(await response.json());
  if (parsed === null) {
    throw new ApiError("request-failed", 200, "The market listing answered in an unknown shape.");
  }
  return parsed;
}

// Display mapping. Null money stays null so the row can say "can't
// tell"; the caller never formats a missing value as zero.

// Compact USD ("$48.2k", "$1.1M"): one fraction digit, whole units only
// past a thousand. Small values keep two decimals; null stays null.
export function formatUsdCompact(value: number | null): string | null {
  if (value === null) {
    return null;
  }
  if (value >= 1_000_000_000) {
    const whole = Math.floor(value / 100_000_000) / 10;
    return `$${whole}B`;
  }
  if (value >= 1_000_000) {
    const whole = Math.floor(value / 100_000) / 10;
    return `$${whole}M`;
  }
  if (value >= 1000) {
    const whole = Math.floor(value / 100) / 10;
    return `$${whole}k`;
  }
  if (value >= 100) {
    return `$${Math.floor(value)}`;
  }
  return `$${Math.floor(value * 100) / 100}`;
}

// Signed 24 h move ("+3.2%", "-1.0%"); null stays null.
export function formatPriceChange(pct: number | null): string | null {
  if (pct === null) {
    return null;
  }
  const rounded = Math.round(pct * 10) / 10;
  return `${rounded >= 0 ? "+" : ""}${rounded}%`;
}

// Volume selection (DX-1 §A3.2): 1 h volume while the pair is young, 24 h
// once it is a day old. The label always names the window it shows.
export function marketVolumeFor(
  item: Pick<MarketItem, "createdAt" | "volume1hUsd" | "volume24hUsd">,
  nowMs: number,
): { readonly label: "Vol 1h" | "Vol 24h"; readonly value: number | null } {
  if (item.createdAt > 0 && nowMs - item.createdAt >= MARKET_VOLUME_SWITCH_MS) {
    return { label: "Vol 24h", value: item.volume24hUsd };
  }
  return { label: "Vol 1h", value: item.volume1hUsd };
}

// Owner-power chip state (DX-1 §A3.2): the server attaches an analysis
// summary for tokens this server already analysed; otherwise the chip
// follows the session's recent results (a visit counts as analysed) and
// finally reads unscanned.
export type MarketChip =
  | { readonly kind: "powers"; readonly found: number; readonly extended: number }
  | { readonly kind: "none" }
  | { readonly kind: "recent"; readonly score: number; readonly word: string }
  | { readonly kind: "unscanned" };

export type RecentAnalysis = {
  readonly score: number;
  readonly word: string;
};

export function marketChip(
  item: Pick<MarketItem, "tokenAddress" | "analysis">,
  recentByToken: ReadonlyMap<string, RecentAnalysis>,
): MarketChip {
  const analysis = item.analysis;
  if (analysis !== undefined) {
    if (analysis.powersFound > 0 || analysis.powersExtended > 0) {
      return { kind: "powers", found: analysis.powersFound, extended: analysis.powersExtended };
    }
    return { kind: "none" };
  }
  const recent = recentByToken.get(item.tokenAddress.toLowerCase());
  if (recent !== undefined) {
    return { kind: "recent", score: recent.score, word: recent.word };
  }
  return { kind: "unscanned" };
}

// Count line with correct grammar: "1 new token", never "1 new tokens".
export function marketCountLabel(count: number): string {
  return count === 1 ? "1 new token" : `${count} new tokens`;
}

// Tab and header counts name both the shown rows and the listing total
// ("25 of 200"), so the total stays in the label while paging (W-12).
export function marketShownLabel(shown: number, total: number): string {
  if (total <= shown) {
    return marketCountLabel(total);
  }
  return `${shown} of ${total} new tokens`;
}

// Refresh (F-13 fix): merge a poll's updates into the rows the reader
// already sees, matched by token address, keeping the shown order. Rows
// already on screen therefore keep resolving while the reader is
// engaged; only unseen rows wait in the buffer.
export function refreshMarketShown(
  displayed: readonly MarketItem[],
  incoming: readonly MarketItem[],
): MarketItem[] {
  if (incoming.length === 0) {
    return [...displayed];
  }
  const freshByToken = new Map(incoming.map((entry) => [entry.tokenAddress.toLowerCase(), entry]));
  return displayed.map((entry) => freshByToken.get(entry.tokenAddress.toLowerCase()) ?? entry);
}

export function nextMarketView(
  current: { readonly snapshot: MarketSnapshot; readonly buffered: readonly MarketItem[] } | null,
  next: MarketSnapshot,
  engaged: boolean,
): { snapshot: MarketSnapshot; buffered: readonly MarketItem[] } {
  if (current === null || !engaged) {
    return { snapshot: next, buffered: [] };
  }
  const shown = refreshMarketShown(current.snapshot.items, next.items);
  return {
    snapshot: { ...next, items: shown },
    buffered: unseenMarketItems(shown, next.items, current.buffered),
  };
}

// Buffering (same calm contract as the on-chain list): while the reader
// is focused inside the list or hovering it, new rows wait behind a
// "3 new · Show" pill instead of pushing the rows down.
export function unseenMarketItems(
  displayed: readonly MarketItem[],
  incoming: readonly MarketItem[],
  buffered: readonly MarketItem[],
): MarketItem[] {
  const known = new Set(
    [...displayed, ...buffered].map((entry) => entry.tokenAddress.toLowerCase()),
  );
  const fresh = incoming.filter((entry) => !known.has(entry.tokenAddress.toLowerCase()));
  return [...fresh, ...buffered];
}

export function mergeMarketShown(displayed: readonly MarketItem[], buffered: readonly MarketItem[]): MarketItem[] {
  const shown = new Set(displayed.map((entry) => entry.tokenAddress.toLowerCase()));
  return [...buffered.filter((entry) => !shown.has(entry.tokenAddress.toLowerCase())), ...displayed];
}
