// Live new-tokens reader port (E-11 follow-up). The application service
// behind this port polls the LP feed, keeps the newest-first list and
// runs the deterministic analysis queue; the REST driving adapter reads
// snapshots through this port only, so the boundary arrow points at the
// application, never at concrete wiring (A-04, A-06). Ports import the
// domain only.
import type { LiveTokenItem } from "../domain/liveTokens.ts";

export type LiveTokensSource = "etherscan" | "rpc" | "none";

// Human label for a listed token: ERC-20 name()/symbol() reads, null
// when the token answers neither. The list renders the address instead.
export type LiveTokensMetadata = {
  readonly symbol: string | null;
  readonly name: string | null;
};

export type LiveTokensStatus = "live" | "not-configured";

// One list row as served: the stored item plus the server-computed age
// in seconds from the chain block time, or null when the block time is
// unknown, so the client never derives time on its own.
export type LiveTokenView = LiveTokenItem & { readonly ageSeconds: number | null };

export type LiveTokensSnapshot = {
  readonly source: LiveTokensSource;
  readonly status: LiveTokensStatus;
  readonly message?: string | undefined;
  readonly updatedAt: number;
  readonly items: readonly LiveTokenView[];
};

export interface LiveTokensReader {
  snapshot(sinceMs?: number | undefined): LiveTokensSnapshot;
}

// Time source and scheduling for the live list's poll loop. The application
// layer may not touch the system clock or timers (A-05), so composition
// injects the system implementation and tests inject their own.
export interface LiveTokensTimers {
  now(): number;
  // Runs task every intervalMs until the returned cancel is called.
  every(intervalMs: number, task: () => void): () => void;
  sleep(ms: number): Promise<void>;
}
