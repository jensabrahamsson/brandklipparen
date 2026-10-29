// Shared boundary codec for feed logs (S-087, S-088, K-039, A-16).
// Both log sources (Etherscan API V2 and JSON-RPC eth_getLogs) return
// the same log shape; this module validates it once. Block numbers and
// log indexes arrive as hex or decimal strings depending on the source,
// so both spellings parse; anything else is a malformed log. The chain
// block time travels as Etherscan `timeStamp` (hex seconds) or RPC
// `blockTimestamp` (hex seconds); a missing or unusable stamp keeps the
// log with a null block time, never a fabricated value.
import type { FeedLog } from "../../ports/lpFeed.ts";

export function parseBlockField(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) {
    return raw;
  }
  // A bare `0x` word carries no digits and reads as zero (S-110), so an
  // empty quantity never turns a whole poll away.
  if (raw === "0x" || raw === "0X") {
    return 0;
  }
  if (typeof raw === "string" && raw.length > 0) {
    const parsed = raw.startsWith("0x") || raw.startsWith("0X") ? parseInt(raw, 16) : parseInt(raw, 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Small clock skew for the future check: a stamp a couple of minutes
// past the local clock may be clock drift; anything further is not the
// chain time for this log.
export const FEED_LOG_TIMESTAMP_SKEW_MS = 120_000;
// Lower bound for a usable chain stamp (seconds since the epoch): stamps
// at or below this predate any mainnet block and read as unknown.
export const FEED_LOG_MIN_TIMESTAMP_SEC = 1_000_000_000;

// Strict chain-stamp parse: hex seconds only, bounded, not in the future
// beyond the small skew. Any other spelling, an out-of-range value, or a
// future stamp answers null so the caller keeps an honest unknown age.
export function parseBlockTimestampMs(raw: unknown, nowMs: number): number | null {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]+$/.test(raw)) {
    return null;
  }
  const seconds = parseInt(raw, 16);
  if (!Number.isSafeInteger(seconds) || seconds < FEED_LOG_MIN_TIMESTAMP_SEC) {
    return null;
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    return null;
  }
  const upperSec = Math.floor((nowMs + FEED_LOG_TIMESTAMP_SKEW_MS) / 1000);
  if (seconds > upperSec) {
    return null;
  }
  const ms = seconds * 1000;
  if (!Number.isSafeInteger(ms) || ms < 0) {
    return null;
  }
  return ms;
}

export function parseFeedLog(raw: unknown, nowMs: number = Date.now()): FeedLog | null {
  if (!isRecord(raw)) {
    return null;
  }
  const { address, topics, data, blockNumber, blockHash, transactionHash, logIndex } = raw;
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return null;
  }
  if (!Array.isArray(topics) || topics.length === 0 || !topics.every((topic) => typeof topic === "string")) {
    return null;
  }
  if (typeof data !== "string" || !data.startsWith("0x")) {
    return null;
  }
  const block = parseBlockField(blockNumber);
  const index = parseBlockField(logIndex);
  if (block === null || index === null) {
    return null;
  }
  if (typeof blockHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(blockHash)) {
    return null;
  }
  if (typeof transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
    return null;
  }
  const stampRaw = raw["timeStamp"] ?? raw["blockTimestamp"] ?? raw["timestamp"] ?? null;
  const blockTimestampMs = stampRaw === null ? null : parseBlockTimestampMs(stampRaw, nowMs);
  return {
    address: address.toLowerCase(),
    topics: (topics as string[]).map((topic) => topic.toLowerCase()),
    data: data.toLowerCase(),
    blockNumber: block,
    blockHash: (blockHash as string).toLowerCase(),
    txHash: (transactionHash as string).toLowerCase(),
    logIndex: index,
    blockTimestampMs,
  };
}
