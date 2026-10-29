// Live new-tokens list domain (E-11 follow-up). Pure module: item
// lifecycle, newest-first ordering, caps, queue bound, WETH-side
// liquidity parsing, persistence shape validation and backoff math. No
// I/O, no clock, no randomness.
//
// Token identity reuses the existing quote-side rule
// (`resolveNewToken` in lpFeed.ts): the new token is the side that is
// not a known quote (WETH from `BK_WETH_ADDRESS` plus the pinned
// stables). A TOKEN/USDC pair therefore resolves the non-stable side;
// a pair where both sides are quotes, or neither side is, skips with a
// typed reason instead of guessing. WETH never appears here: it arrives
// from operator configuration and tests use a synthetic fixture.
import {
  V2_MINT_TOPIC0,
  V2_SYNC_TOPIC0,
  V3_MINT_TOPIC0,
} from "./lpFeed.ts";

// Polite poll cadence on the Etherscan free tier (max 3 calls/s, 100k
// calls/day): one logs poll per ~15 s is 5,760 cycles/day. Each cycle
// costs two factory polls plus at most a handful of pair-address polls
// and one latest-block read, so even a busy day stays far under the
// daily cap. The adapter token bucket and the service backoff below
// absorb bursts and 429 answers.
export const LIVE_TOKENS_POLL_INTERVAL_MS = 15_000;
// Fresh-start lookback: the last ~300 blocks (~1 hour at 12 s blocks)
// so the list fills within minutes of the first poll.
export const LIVE_TOKENS_LOOKBACK_BLOCKS = 300;
// Largest block span one cycle asks for (session 18): a far-behind
// cursor catches up in bounded steps of at most this many blocks,
// advancing the cursor after each successful step, instead of asking
// for the whole gap in one call. Sized so one cycle fits the
// per-second budget: one span needs one page per factory poll plus at
// most a handful of pair-address polls (about 0.7 calls/s on average
// at the 15 s cadence, inside the 3/s sustained budget), while an
// 1,800-block gap converges in 18 cycles (~4.5 min). Partial pages
// fetched before a mid-range refusal are kept: the cursor moves to the
// last fully covered block and the next cycle retries the rest.
export const LIVE_TOKENS_MAX_SPAN_PER_CYCLE = 100;
// The visible list keeps the newest 200 items; older entries drop.
export const LIVE_TOKENS_MAX_ITEMS = 200;
// The analysis queue holds at most 50 queued items; the oldest queued
// entry past the bound drops as visibly skipped, never silently.
export const LIVE_TOKENS_MAX_QUEUE = 50;
// Backoff on failing polls: double from 5 s up to 60 s.
export const LIVE_TOKENS_BACKOFF_BASE_MS = 5_000;
export const LIVE_TOKENS_BACKOFF_MAX_MS = 60_000;

export function nextBackoffMs(currentMs: number): number {
  return Math.min(LIVE_TOKENS_BACKOFF_MAX_MS, currentMs * 2);
}

export type LiveTokenState = "queued" | "analyzing" | "done" | "cant-tell" | "skipped" | "error";

export type LiveTokenDex = "Uniswap V2" | "Uniswap V3";

export type LiveTokenRiskBand = "Low" | "Elevated" | "High";

export type LiveTokenItem = {
  readonly chainId: 1;
  readonly tokenAddress: string;
  readonly symbol: string | null;
  readonly name: string | null;
  readonly pairAddress: string;
  readonly dex: LiveTokenDex;
  readonly feeTier?: number | undefined;
  readonly block: number;
  readonly txHash: string;
  readonly logIndex: number;
  readonly createdAt: number;
  // Chain block time of the pair-creation log in milliseconds since the
  // epoch, or null when the source gave no usable stamp. The list age
  // derives from this value only; `createdAt` stays as the first-seen
  // instant for queue and persistence bookkeeping.
  readonly blockTimestampMs: number | null;
  // WETH in the pair from the first Mint/Sync, formatted decimal;
  // null reads as "can't tell" in the UI.
  readonly initialLiquidityWeth: string | null;
  readonly state: LiveTokenState;
  readonly riskBand?: LiveTokenRiskBand | undefined;
  readonly score?: number | undefined;
  readonly reason?: string | undefined;
};

export type LiveTokensDoc = {
  readonly version: 1;
  readonly cursorBlock: number;
  readonly items: readonly LiveTokenItem[];
};

function compareItems(first: LiveTokenItem, second: LiveTokenItem): number {
  if (first.block !== second.block) {
    return second.block - first.block;
  }
  return second.logIndex - first.logIndex;
}

// Inserts or refreshes one pair listing: identity is the pair address,
// so a re-seen pair updates its state without duplicating. The list
// stays newest first (block, then log index) and drops the oldest past
// the cap. Stable keys (pair address) keep the UI from reordering.
// `createdAt` (first seen) is preserved; the chain block time keeps the
// first known value and fills in when a later sighting knows it.
export function upsertLiveToken(
  items: readonly LiveTokenItem[],
  item: LiveTokenItem,
): readonly LiveTokenItem[] {
  const key = item.pairAddress.toLowerCase();
  const merged = items.some((entry) => entry.pairAddress.toLowerCase() === key)
    ? items.map((entry) =>
        entry.pairAddress.toLowerCase() === key
          ? {
              ...item,
              createdAt: entry.createdAt,
              blockTimestampMs: entry.blockTimestampMs ?? item.blockTimestampMs ?? null,
            }
          : entry,
      )
    : [...items, item];
  return Object.freeze(
    merged
      .slice()
      .sort(compareItems)
      .slice(0, LIVE_TOKENS_MAX_ITEMS),
  );
}

// Queue bound: past LIVE_TOKENS_MAX_QUEUE queued entries the oldest
// queued entry (lowest block, then log index) drops to skipped with a
// visible reason instead of vanishing silently.
export function enforceQueueBound(
  items: readonly LiveTokenItem[],
  maxQueued: number,
): readonly LiveTokenItem[] {
  const queued = items.filter((entry) => entry.state === "queued");
  if (queued.length <= maxQueued) {
    return items;
  }
  const oldest = queued
    .slice()
    .sort((first, second) => -compareItems(first, second))[0];
  if (oldest === undefined) {
    return items;
  }
  const key = oldest.pairAddress.toLowerCase();
  return Object.freeze(
    items.map((entry) =>
      entry.pairAddress.toLowerCase() === key
        ? { ...entry, state: "skipped" as const, reason: "queue-full (dropped oldest)" }
        : entry,
    ),
  );
}

// Restart: items left analyzing at shutdown go back to queued so the
// analysis queue picks them up again; every other state survives.
export function requeueInterrupted(items: readonly LiveTokenItem[]): readonly LiveTokenItem[] {
  return Object.freeze(
    items.map((entry) =>
      entry.state === "analyzing" ? { ...entry, state: "queued" as const } : entry,
    ),
  );
}

export function withLiveTokenState(item: LiveTokenItem, patch: Partial<LiveTokenItem>): LiveTokenItem {
  return Object.freeze({ ...item, ...patch });
}

export function ageSeconds(
  blockTimestampMs: number | null | undefined,
  nowMs: number,
): number | null {
  if (
    typeof blockTimestampMs !== "number" ||
    !Number.isSafeInteger(blockTimestampMs) ||
    blockTimestampMs < 0 ||
    typeof nowMs !== "number" ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0
  ) {
    return null;
  }
  return Math.max(0, Math.floor((nowMs - blockTimestampMs) / 1000));
}

// WETH amounts use 18 decimals; up to 4 fraction digits read calmly in
// the list ("1.5", "0.0234"). Trailing noise never renders.
export function formatWethAmount(wei: bigint): string {
  const whole = wei / 1_000_000_000_000_000_000n;
  const fraction = wei % 1_000_000_000_000_000_000n;
  if (fraction === 0n) {
    return whole.toString();
  }
  const digits = fraction.toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
  return digits.length === 0 ? whole.toString() : `${whole.toString()}.${digits}`;
}

function dataWords(data: string): string[] | null {
  if (!/^0x[0-9a-fA-F]*$/.test(data) || (data.length - 2) % 64 !== 0 || data.length <= 2) {
    return null;
  }
  const words: string[] = [];
  for (let offset = 2; offset < data.length; offset += 64) {
    words.push(`0x${data.slice(offset, offset + 64)}`);
  }
  return words;
}

// WETH-side liquidity from the first Mint/Sync log for a pair: V2 Mint
// and Sync carry (amount0, amount1) in the two data words; V3 Mint
// carries (..., amount0, amount1) in the last two of seven words. The
// WETH side is chosen by comparing token0 against the configured WETH.
// Anything else (unknown topic, neither side WETH, malformed data)
// answers null so the caller records "can't tell".
export function wethLiquidityFromLog(
  log: { readonly topic0: string; readonly data: string },
  token0: string,
  token1: string,
  weth: string,
): string | null {
  const topic = log.topic0.toLowerCase();
  const words = dataWords(log.data);
  if (words === null) {
    return null;
  }
  const wethLower = weth.toLowerCase();
  let side: 0 | 1 | null = null;
  if (token0.toLowerCase() === wethLower && token1.toLowerCase() !== wethLower) {
    side = 0;
  } else if (token1.toLowerCase() === wethLower && token0.toLowerCase() !== wethLower) {
    side = 1;
  } else {
    return null;
  }
  let raw: string | null = null;
  if (topic === V2_MINT_TOPIC0.toLowerCase() || topic === V2_SYNC_TOPIC0.toLowerCase()) {
    if (words.length < 2) {
      return null;
    }
    raw = words[side] ?? null;
  } else if (topic === V3_MINT_TOPIC0.toLowerCase()) {
    if (words.length < 7) {
      return null;
    }
    raw = words[5 + side] ?? null;
  } else {
    return null;
  }
  if (raw === null || !/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    return null;
  }
  return formatWethAmount(BigInt(raw));
}

function isHexAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isHexHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const ITEM_STATES: readonly LiveTokenState[] = Object.freeze([
  "queued",
  "analyzing",
  "done",
  "cant-tell",
  "skipped",
  "error",
]);

const ITEM_DEXES: readonly LiveTokenDex[] = Object.freeze(["Uniswap V2", "Uniswap V3"]);

const ITEM_BANDS: readonly LiveTokenRiskBand[] = Object.freeze(["Low", "Elevated", "High"]);

function isLiveTokenItem(value: unknown): value is LiveTokenItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record["chainId"] !== 1 || !isHexAddress(record["tokenAddress"]) || !isHexAddress(record["pairAddress"])) {
    return false;
  }
  if (
    (record["symbol"] !== null && typeof record["symbol"] !== "string") ||
    (record["name"] !== null && typeof record["name"] !== "string")
  ) {
    return false;
  }
  if (typeof record["dex"] !== "string" || !ITEM_DEXES.includes(record["dex"] as LiveTokenDex)) {
    return false;
  }
  const feeTier = record["feeTier"];
  if (feeTier !== undefined && (!isSafeInt(feeTier) || feeTier > 1000000)) {
    return false;
  }
  if (!isSafeInt(record["block"]) || !isHexHash(record["txHash"]) || !isSafeInt(record["logIndex"])) {
    return false;
  }
  if (!isSafeInt(record["createdAt"])) {
    return false;
  }
  const blockStamp = record["blockTimestampMs"];
  if (blockStamp !== undefined && blockStamp !== null && !isSafeInt(blockStamp)) {
    return false;
  }
  if (record["initialLiquidityWeth"] !== null && typeof record["initialLiquidityWeth"] !== "string") {
    return false;
  }
  if (typeof record["state"] !== "string" || !ITEM_STATES.includes(record["state"] as LiveTokenState)) {
    return false;
  }
  const band = record["riskBand"];
  if (band !== undefined && (typeof band !== "string" || !ITEM_BANDS.includes(band as LiveTokenRiskBand))) {
    return false;
  }
  const score = record["score"];
  if (score !== undefined && (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 100)) {
    return false;
  }
  if (record["reason"] !== undefined && typeof record["reason"] !== "string") {
    return false;
  }
  return true;
}

export function parseLiveTokensDoc(raw: unknown): LiveTokensDoc | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (record["version"] !== 1 || !isSafeInt(record["cursorBlock"])) {
    return null;
  }
  const items = record["items"];
  if (!Array.isArray(items) || !items.every(isLiveTokenItem)) {
    return null;
  }
  // Old cached entries without the chain stamp load with an unknown age
  // (null) instead of failing the file, so a restart never loses the list.
  const normalized = (items as LiveTokenItem[]).map((entry) =>
    Object.freeze({
      ...entry,
      blockTimestampMs: (entry as { blockTimestampMs?: number | null }).blockTimestampMs ?? null,
    }),
  );
  return Object.freeze({
    version: 1 as const,
    cursorBlock: record["cursorBlock"] as number,
    items: Object.freeze([...normalized]),
  });
}

export function serializeLiveTokensDoc(doc: LiveTokensDoc): string {
  return JSON.stringify({ version: doc.version, cursorBlock: doc.cursorBlock, items: doc.items });
}
