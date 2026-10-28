// LpFeedPort: new-LP-pair log source on Ethereum mainnet (S-087, S-088,
// K-039, A-05). The port is owned by the core: the application polls one
// factory address over one block range per call and receives raw logs;
// decoding, quote resolution and gating live in the domain. Two adapters
// implement this port: the Etherscan API V2 logs adapter (primary) and
// the JSON-RPC eth_getLogs fallback. Tests inject fake transports with
// recorded fixtures and never reach the network.
import { err, ok } from "../domain/result.ts";
import type { Result } from "../domain/result.ts";

// One raw log as returned by either source, normalized to numbers.
// `blockHash` travels per candidate so reorg handling can mark
// `orphaned` on change (S-090).
export type FeedLog = {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly txHash: string;
  readonly logIndex: number;
};

export type FeedPollInput = {
  readonly factory: string;
  readonly fromBlock: number;
  readonly toBlock: number;
};

export const FeedPollInput = {
  create(input: {
    readonly factory: string;
    readonly fromBlock: number;
    readonly toBlock: number;
  }): Result<FeedPollInput, { kind: "invalid-feed-input"; message: string }> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(input.factory)) {
      return err({ kind: "invalid-feed-input", message: "factory must be a 0x address" });
    }
    if (!Number.isSafeInteger(input.fromBlock) || !Number.isSafeInteger(input.toBlock)) {
      return err({ kind: "invalid-feed-input", message: "block range must hold safe integers" });
    }
    if (input.fromBlock < 0 || input.toBlock < input.fromBlock) {
      return err({ kind: "invalid-feed-input", message: "block range must be ordered and non-negative" });
    }
    return ok(Object.freeze({ ...input }));
  },
};

// Error union per A-15. `not-configured` answers without a key or URL with
// zero sends; `rate-limited` covers the token bucket, the daily budget
// and provider rate-limit answers, and carries the wait before retry.
export type LpFeedError =
  | { kind: "not-configured"; message: string }
  | { kind: "rate-limited"; message: string; retryAfterMs: number }
  | { kind: "timeout"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "invalid-response"; message: string };

// Per-port limits per A-17. Values come from the operational
// configuration; the port only names the fields.
export type LpFeedLimits = {
  readonly timeoutMs: number;
  readonly callsPerSecond: number;
  readonly callsPerDay: number;
  readonly backoffBaseMs: number;
};

export type FeedCallContext = {
  readonly requestId: string;
  readonly deadlineMs: number;
};

export interface LpFeedPort {
  pollLogs(input: FeedPollInput, ctx: FeedCallContext): Promise<Result<readonly FeedLog[], LpFeedError>>;
}
