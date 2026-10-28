// Shared boundary codec for feed logs (S-087, S-088, K-039, A-16).
// Both log sources (Etherscan API V2 and JSON-RPC eth_getLogs) return
// the same log shape; this module validates it once. Block numbers and
// log indexes arrive as hex or decimal strings depending on the source,
// so both spellings parse; anything else is a malformed log.
import type { FeedLog } from "../../ports/lpFeed.ts";

export function parseBlockField(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) {
    return raw;
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

export function parseFeedLog(raw: unknown): FeedLog | null {
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
  return {
    address: address.toLowerCase(),
    topics: (topics as string[]).map((topic) => topic.toLowerCase()),
    data: data.toLowerCase(),
    blockNumber: block,
    blockHash: (blockHash as string).toLowerCase(),
    txHash: (transactionHash as string).toLowerCase(),
    logIndex: index,
  };
}
