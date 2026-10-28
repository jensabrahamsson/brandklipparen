// Etherscan API V2 logs adapter behind LpFeedPort (S-087, K-039, K-505,
// A-05). Primary mainnet log source: `module=logs&action=getLogs` with
// chainid 1, one factory address per call over one block range. Driven
// adapter with an injectable GET transport: tests replay recorded
// fixtures and never touch the network. The key travels from the
// environment only (`ETHERSCAN_API_KEY`); without it the factory binds
// the not-configured adapter whose every call answers `not-configured`
// with zero sends (K-505). Free-tier pacing (3 calls per second, 100k
// per day) is enforced with a token bucket and a daily counter; provider
// rate-limit answers trigger backoff with the wait carried in the error.
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import type { SecretString } from "../../ports/config.ts";
import { parseFeedLog } from "./feedLogCodec.ts";
import type {
  FeedCallContext,
  FeedLog,
  FeedPollInput,
  LpFeedError,
  LpFeedPort,
} from "../../ports/lpFeed.ts";
import { FeedPollInput as FeedPollInputCtor } from "../../ports/lpFeed.ts";

export const ETHERSCAN_LOGS_BASE_URL = "https://api.etherscan.io/v2/api";
export const ETHERSCAN_LOGS_CHAIN_ID = 1;

export type EtherscanLogsTransportResponse = {
  readonly status: number;
  readonly bodyText: string;
};

export type EtherscanLogsTransport = (url: string) => Promise<EtherscanLogsTransportResponse>;

async function fetchEtherscanLogsTransport(url: string): Promise<EtherscanLogsTransportResponse> {
  const response = await fetch(url);
  return { status: response.status, bodyText: await response.text() };
}

export type EtherscanLogsAdapterOptions = {
  readonly apiKey: SecretString | undefined;
  readonly baseUrl?: string | undefined;
  readonly callsPerSecond?: number | undefined;
  readonly dailyCap?: number | undefined;
  readonly backoffBaseMs?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly transport?: EtherscanLogsTransport | undefined;
  readonly now?: (() => number) | undefined;
};

export const DEFAULT_ETHERSCAN_CALLS_PER_SECOND = 3;
export const DEFAULT_ETHERSCAN_CALLS_PER_DAY = 100000;

type BucketState = {
  tokens: number;
  lastRefillMs: number;
  day: string;
  dayCount: number;
  backoffUntilMs: number;
  backoffMs: number;
};

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Not-configured adapter (K-505): bound when `ETHERSCAN_API_KEY` is
// unset. Every call answers `not-configured` with zero sends.
export class NotConfiguredEtherscanLogsAdapter implements LpFeedPort {
  async pollLogs(): Promise<Result<readonly FeedLog[], LpFeedError>> {
    return err({ kind: "not-configured", message: "the feed is not configured: set ETHERSCAN_API_KEY" });
  }
}

export class EtherscanLogsAdapter implements LpFeedPort {
  private readonly apiKey: SecretString;
  private readonly baseUrl: string;
  private readonly callsPerSecond: number;
  private readonly dailyCap: number;
  private readonly backoffBaseMs: number;
  private readonly timeoutMs: number;
  private readonly transport: EtherscanLogsTransport;
  private readonly now: () => number;
  private readonly bucket: BucketState;

  constructor(options: EtherscanLogsAdapterOptions & { apiKey: SecretString }) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? ETHERSCAN_LOGS_BASE_URL;
    this.callsPerSecond = options.callsPerSecond ?? DEFAULT_ETHERSCAN_CALLS_PER_SECOND;
    this.dailyCap = options.dailyCap ?? DEFAULT_ETHERSCAN_CALLS_PER_DAY;
    this.backoffBaseMs = options.backoffBaseMs ?? 1000;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.transport = options.transport ?? fetchEtherscanLogsTransport;
    this.now = options.now ?? Date.now;
    const started = this.now();
    this.bucket = {
      tokens: this.callsPerSecond,
      lastRefillMs: started,
      day: utcDay(started),
      dayCount: 0,
      backoffUntilMs: 0,
      backoffMs: this.backoffBaseMs,
    };
  }

  async pollLogs(input: FeedPollInput, ctx: FeedCallContext): Promise<Result<readonly FeedLog[], LpFeedError>> {
    const checked = FeedPollInputCtor.create(input);
    if (!checked.ok) {
      return err({ kind: "invalid-response", message: checked.error.message });
    }
    const at = this.now();
    if (at > ctx.deadlineMs) {
      return err({ kind: "timeout", message: "feed poll exceeded its deadline" });
    }
    this.refill(at);
    if (at < this.bucket.backoffUntilMs) {
      return err({
        kind: "rate-limited",
        message: "feed backs off after a provider rate-limit answer",
        retryAfterMs: this.bucket.backoffUntilMs - at,
      });
    }
    if (this.bucket.tokens < 1) {
      return err({
        kind: "rate-limited",
        message: "feed token bucket is empty",
        retryAfterMs: Math.ceil(1000 / this.callsPerSecond),
      });
    }
    if (this.bucket.dayCount >= this.dailyCap) {
      return err({
        kind: "rate-limited",
        message: "feed daily budget is spent",
        retryAfterMs: 24 * 60 * 60 * 1000,
      });
    }
    this.bucket.tokens -= 1;
    this.bucket.dayCount += 1;
    const url =
      `${this.baseUrl}?chainid=${ETHERSCAN_LOGS_CHAIN_ID}&module=logs&action=getLogs` +
      `&address=${checked.value.factory.toLowerCase()}` +
      `&fromBlock=${checked.value.fromBlock}&toBlock=${checked.value.toBlock}` +
      `&apikey=${encodeURIComponent(this.apiKey.reveal())}`;
    let response: EtherscanLogsTransportResponse;
    try {
      response = await this.withTimeout(url);
    } catch {
      return err({ kind: "unavailable", message: "feed log source is unavailable" });
    }
    if (response.status === 429) {
      return err(this.enterBackoff("feed log source rate limited the request", at));
    }
    let body: unknown;
    try {
      body = JSON.parse(response.bodyText) as unknown;
    } catch {
      return err({ kind: "invalid-response", message: "feed log source gave a non-JSON reply" });
    }
    if (!isRecord(body)) {
      return err({ kind: "invalid-response", message: "feed log source gave a malformed reply" });
    }
    if (body["status"] === "0") {
      const resultText = typeof body["result"] === "string" ? body["result"] : "";
      if (/rate limit/i.test(resultText)) {
        return err(this.enterBackoff("feed log source rate limited the request", at));
      }
      return err({ kind: "invalid-response", message: `feed log source refused the request: ${resultText}` });
    }
    const result = body["result"];
    if (!Array.isArray(result)) {
      return err({ kind: "invalid-response", message: "feed log source gave logs in an unknown shape" });
    }
    const logs: FeedLog[] = [];
    for (const raw of result) {
      const parsed = parseFeedLog(raw);
      if (parsed === null) {
        return err({ kind: "invalid-response", message: "feed log source gave a malformed log" });
      }
      logs.push(parsed);
    }
    this.bucket.backoffMs = this.backoffBaseMs;
    return ok(Object.freeze(logs));
  }

  private refill(at: number): void {
    const today = utcDay(at);
    if (today !== this.bucket.day) {
      this.bucket.day = today;
      this.bucket.dayCount = 0;
    }
    const elapsedMs = Math.max(0, at - this.bucket.lastRefillMs);
    this.bucket.tokens = Math.min(
      this.callsPerSecond,
      this.bucket.tokens + (elapsedMs / 1000) * this.callsPerSecond,
    );
    this.bucket.lastRefillMs = at;
  }

  private enterBackoff(message: string, at: number): LpFeedError {
    const waitMs = this.bucket.backoffMs;
    this.bucket.backoffUntilMs = at + waitMs;
    this.bucket.backoffMs = Math.min(waitMs * 2, 60000);
    return { kind: "rate-limited", message, retryAfterMs: waitMs };
  }

  private async withTimeout(url: string): Promise<EtherscanLogsTransportResponse> {
    const pending = this.transport(url);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const onTimeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("feed poll timed out")), this.timeoutMs);
      });
      return await Promise.race([pending, onTimeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}

// Binds the real adapter when the key is set, and the not-configured
// adapter otherwise. Missing values never fail startup: the feed stays
// idle until the operator configures it.
export function createEtherscanLogsAdapter(options: EtherscanLogsAdapterOptions): LpFeedPort {
  if (options.apiKey === undefined) {
    return new NotConfiguredEtherscanLogsAdapter();
  }
  return new EtherscanLogsAdapter({ ...options, apiKey: options.apiKey });
}
