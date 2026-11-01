// JSON-RPC eth_getLogs fallback adapter behind LpFeedPort (S-088,
// K-039). Optional fallback behind the same port: one factory address
// per call over one block range via `eth_getLogs`. Driven adapter with
// an injectable POST transport: tests replay recorded fixtures and never
// touch the network. Without the configured RPC URL the factory binds
// the not-configured adapter whose every call answers `not-configured`
// with zero sends. Chain block times missing from the logs resolve with
// one `eth_getBlockByNumber(block, false)` per distinct block over the
// same RPC transport (bounded, cached per block); a failed lookup keeps
// the log with an honest unknown (null) block time, never a guess.
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import type { SecretString } from "../../ports/config.ts";
import type {
  FeedCallContext,
  FeedLog,
  FeedPollInput,
  FeedPollResult,
  LpFeedError,
  LpFeedPort,
} from "../../ports/lpFeed.ts";
import { FeedPollInput as FeedPollInputCtor } from "../../ports/lpFeed.ts";
import { parseBlockTimestampMs, parseFeedLog } from "./feedLogCodec.ts";
import { safeFetchText } from "../http/safeFetch.ts";

export type RpcLogsTransportResponse = {
  readonly status: number;
  readonly bodyText: string;
};

export type RpcLogsTransport = (url: string, body: string) => Promise<RpcLogsTransportResponse>;

async function fetchRpcLogsTransport(url: string, body: string): Promise<RpcLogsTransportResponse> {
  return safeFetchText(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    timeoutMs: DEFAULT_RPC_LOGS_FETCH_TIMEOUT_MS,
    maxBytes: DEFAULT_RPC_LOGS_FETCH_MAX_RESPONSE_BYTES,
  });
}

export type RpcLogsAdapterOptions = {
  readonly url: SecretString | undefined;
  readonly timeoutMs?: number | undefined;
  readonly transport?: RpcLogsTransport | undefined;
  readonly now?: (() => number) | undefined;
  // Block span per page: public endpoints cap eth_getLogs ranges, so a
  // wide range fans out to one request per chunk and merges in order.
  // Pages fetched before a mid-range refusal are kept with the covered
  // block, like the primary adapter.
  readonly maxBlocksPerPage?: number | undefined;
};

// Conservative page span for the fallback (session 18): small enough to
// stay under typical public-endpoint range caps, large enough that the
// bounded per-cycle span of the live service needs at most two pages.
export const DEFAULT_RPC_LOGS_MAX_BLOCKS_PER_PAGE = 50;
// Default fetch envelope for the production transport (C-24, F-28): the
// bounded fetch refuses redirects, times out slow bodies and caps the
// streamed reply, so a hostile log endpoint cannot hang or OOM the feed.
export const DEFAULT_RPC_LOGS_FETCH_TIMEOUT_MS = 10000;
export const DEFAULT_RPC_LOGS_FETCH_MAX_RESPONSE_BYTES = 8388608;

// Timestamp lookups per poll stay bounded: one call per distinct block
// missing a stamp, at most this many blocks per poll; the rest keep a
// null (unknown) block time. Resolved stamps stay cached per block.
export const MAX_BLOCK_TIMESTAMP_LOOKUPS_PER_POLL = 100;
const BLOCK_TIMESTAMP_CACHE_MAX = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toQuantity(block: number): string {
  return `0x${block.toString(16)}`;
}

// Not-configured adapter: bound when the fallback RPC URL is unset.
export class NotConfiguredRpcLogsAdapter implements LpFeedPort {
  async pollLogs(): Promise<Result<FeedPollResult, LpFeedError>> {
    return err({ kind: "not-configured", message: "the feed fallback is not configured: set the feed RPC URL" });
  }
}

export class RpcLogsAdapter implements LpFeedPort {
  private readonly url: SecretString;
  private readonly timeoutMs: number;
  private readonly transport: RpcLogsTransport;
  private readonly now: () => number;
  private readonly maxBlocksPerPage: number;
  private readonly blockTimestampCache = new Map<number, number>();

  constructor(options: RpcLogsAdapterOptions & { url: SecretString }) {
    this.url = options.url;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.transport = options.transport ?? fetchRpcLogsTransport;
    this.now = options.now ?? Date.now;
    const pageSize = options.maxBlocksPerPage ?? DEFAULT_RPC_LOGS_MAX_BLOCKS_PER_PAGE;
    this.maxBlocksPerPage =
      Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : DEFAULT_RPC_LOGS_MAX_BLOCKS_PER_PAGE;
  }

  // Block chunks for one range (session 18): contiguous, ordered and
  // covering the whole range, mirroring the primary adapter.
  private pageRange(fromBlock: number, toBlock: number): Array<{ from: number; to: number }> {
    const pages: Array<{ from: number; to: number }> = [];
    let cursor = fromBlock;
    while (cursor <= toBlock) {
      const end = Math.min(toBlock, cursor + this.maxBlocksPerPage - 1);
      pages.push({ from: cursor, to: end });
      cursor = end + 1;
    }
    return pages;
  }

  async pollLogs(input: FeedPollInput, ctx: FeedCallContext): Promise<Result<FeedPollResult, LpFeedError>> {
    const checked = FeedPollInputCtor.create(input);
    if (!checked.ok) {
      return err({ kind: "invalid-response", message: checked.error.message });
    }
    const merged: FeedLog[] = [];
    let coveredToBlock = checked.value.fromBlock - 1;
    for (const page of this.pageRange(checked.value.fromBlock, checked.value.toBlock)) {
      const paged = await this.pollPage(checked.value.factory, page.from, page.to, ctx);
      if (!paged.ok) {
        if (merged.length === 0) {
          return err(paged.error);
        }
        const filled = await this.fillMissingTimestamps(merged, ctx);
        return ok(Object.freeze({ logs: Object.freeze(filled), coveredToBlock }));
      }
      merged.push(...paged.value);
      coveredToBlock = page.to;
    }
    const filled = await this.fillMissingTimestamps(merged, ctx);
    return ok(Object.freeze({ logs: Object.freeze(filled), coveredToBlock }));
  }

  private async pollPage(
    factory: string,
    fromBlock: number,
    toBlock: number,
    ctx: FeedCallContext,
  ): Promise<Result<readonly FeedLog[], LpFeedError>> {
    if (this.now() > ctx.deadlineMs) {
      return err({ kind: "timeout", message: "feed poll exceeded its deadline" });
    }
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getLogs",
      params: [
        {
          address: factory.toLowerCase(),
          fromBlock: toQuantity(fromBlock),
          toBlock: toQuantity(toBlock),
        },
      ],
    });
    let response: RpcLogsTransportResponse;
    try {
      response = await this.withTimeout(this.url.reveal(), body);
    } catch {
      return err({ kind: "unavailable", message: "feed fallback log source is unavailable" });
    }
    if (response.status === 429) {
      return err({
        kind: "rate-limited",
        message: "feed fallback rate limited the request",
        retryAfterMs: 1000,
        scope: "provider",
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.bodyText) as unknown;
    } catch {
      return err({ kind: "invalid-response", message: "feed fallback gave a non-JSON reply" });
    }
    if (!isRecord(parsed) || !Array.isArray(parsed["result"])) {
      return err({ kind: "invalid-response", message: "feed fallback gave logs in an unknown shape" });
    }
    const at = this.now();
    const logs: FeedLog[] = [];
    for (const raw of parsed["result"] as unknown[]) {
      const log = parseFeedLog(raw, at);
      if (log === null) {
        return err({ kind: "invalid-response", message: "feed fallback gave a malformed log" });
      }
      logs.push(log);
    }
    return ok(Object.freeze(logs));
  }

  // Fills logs missing a chain stamp with one eth_getBlockByNumber call
  // per distinct block over the same RPC transport. Bounded per poll and
  // cached per block; any failure keeps null, never a fabricated value.
  private async fillMissingTimestamps(logs: readonly FeedLog[], ctx: FeedCallContext): Promise<FeedLog[]> {
    const missing = [
      ...new Set(logs.filter((log) => (log.blockTimestampMs ?? null) === null).map((log) => log.blockNumber)),
    ];
    if (missing.length === 0) {
      return [...logs];
    }
    const bounded = missing.slice(0, MAX_BLOCK_TIMESTAMP_LOOKUPS_PER_POLL);
    const resolved = new Map<number, number | null>();
    for (const block of bounded) {
      const cached = this.blockTimestampCache.get(block);
      if (cached !== undefined) {
        resolved.set(block, cached);
        continue;
      }
      if (this.now() > ctx.deadlineMs) {
        break;
      }
      const fetched = await this.fetchBlockTimestampMs(block);
      if (fetched !== null) {
        this.rememberBlockTimestamp(block, fetched);
        resolved.set(block, fetched);
      }
    }
    return logs.map((log) => {
      if ((log.blockTimestampMs ?? null) !== null) {
        return log;
      }
      const found = resolved.get(log.blockNumber) ?? null;
      if (found === null) {
        return log;
      }
      return { ...log, blockTimestampMs: found };
    });
  }

  private rememberBlockTimestamp(block: number, ms: number): void {
    if (this.blockTimestampCache.size >= BLOCK_TIMESTAMP_CACHE_MAX) {
      const oldest = this.blockTimestampCache.keys().next();
      if (!oldest.done) {
        this.blockTimestampCache.delete(oldest.value);
      }
    }
    this.blockTimestampCache.set(block, ms);
  }

  private async fetchBlockTimestampMs(block: number): Promise<number | null> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBlockByNumber",
      params: [toQuantity(block), false],
    });
    let response: RpcLogsTransportResponse;
    try {
      response = await this.withTimeout(this.url.reveal(), body);
    } catch {
      return null;
    }
    if (response.status !== 200) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.bodyText) as unknown;
    } catch {
      return null;
    }
    if (!isRecord(parsed) || !isRecord(parsed["result"])) {
      return null;
    }
    return parseBlockTimestampMs(parsed["result"]["timestamp"], this.now());
  }

  private async withTimeout(url: string, body: string): Promise<RpcLogsTransportResponse> {
    const pending = this.transport(url, body);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const onTimeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("feed fallback timed out")), this.timeoutMs);
      });
      return await Promise.race([pending, onTimeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}

// Binds the fallback adapter when the URL is set, and the
// not-configured adapter otherwise.
export function createRpcLogsAdapter(options: RpcLogsAdapterOptions): LpFeedPort {
  if (options.url === undefined) {
    return new NotConfiguredRpcLogsAdapter();
  }
  return new RpcLogsAdapter({ ...options, url: options.url });
}
