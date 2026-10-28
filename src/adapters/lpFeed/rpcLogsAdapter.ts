// JSON-RPC eth_getLogs fallback adapter behind LpFeedPort (S-088,
// K-039). Optional fallback behind the same port: one factory address
// per call over one block range via `eth_getLogs`. Driven adapter with
// an injectable POST transport: tests replay recorded fixtures and never
// touch the network. Without the configured RPC URL the factory binds
// the not-configured adapter whose every call answers `not-configured`
// with zero sends.
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import type { SecretString } from "../../ports/config.ts";
import type {
  FeedCallContext,
  FeedLog,
  FeedPollInput,
  LpFeedError,
  LpFeedPort,
} from "../../ports/lpFeed.ts";
import { FeedPollInput as FeedPollInputCtor } from "../../ports/lpFeed.ts";
import { parseFeedLog } from "./feedLogCodec.ts";

export type RpcLogsTransportResponse = {
  readonly status: number;
  readonly bodyText: string;
};

export type RpcLogsTransport = (url: string, body: string) => Promise<RpcLogsTransportResponse>;

async function fetchRpcLogsTransport(url: string, body: string): Promise<RpcLogsTransportResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return { status: response.status, bodyText: await response.text() };
}

export type RpcLogsAdapterOptions = {
  readonly url: SecretString | undefined;
  readonly timeoutMs?: number | undefined;
  readonly transport?: RpcLogsTransport | undefined;
  readonly now?: (() => number) | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toQuantity(block: number): string {
  return `0x${block.toString(16)}`;
}

// Not-configured adapter: bound when the fallback RPC URL is unset.
export class NotConfiguredRpcLogsAdapter implements LpFeedPort {
  async pollLogs(): Promise<Result<readonly FeedLog[], LpFeedError>> {
    return err({ kind: "not-configured", message: "the feed fallback is not configured: set the feed RPC URL" });
  }
}

export class RpcLogsAdapter implements LpFeedPort {
  private readonly url: SecretString;
  private readonly timeoutMs: number;
  private readonly transport: RpcLogsTransport;
  private readonly now: () => number;

  constructor(options: RpcLogsAdapterOptions & { url: SecretString }) {
    this.url = options.url;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.transport = options.transport ?? fetchRpcLogsTransport;
    this.now = options.now ?? Date.now;
  }

  async pollLogs(input: FeedPollInput, ctx: FeedCallContext): Promise<Result<readonly FeedLog[], LpFeedError>> {
    const checked = FeedPollInputCtor.create(input);
    if (!checked.ok) {
      return err({ kind: "invalid-response", message: checked.error.message });
    }
    if (this.now() > ctx.deadlineMs) {
      return err({ kind: "timeout", message: "feed poll exceeded its deadline" });
    }
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getLogs",
      params: [
        {
          address: checked.value.factory.toLowerCase(),
          fromBlock: toQuantity(checked.value.fromBlock),
          toBlock: toQuantity(checked.value.toBlock),
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
      return err({ kind: "rate-limited", message: "feed fallback rate limited the request", retryAfterMs: 1000 });
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
    const logs: FeedLog[] = [];
    for (const raw of parsed["result"] as unknown[]) {
      const log = parseFeedLog(raw);
      if (log === null) {
        return err({ kind: "invalid-response", message: "feed fallback gave a malformed log" });
      }
      logs.push(log);
    }
    return ok(Object.freeze(logs));
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
