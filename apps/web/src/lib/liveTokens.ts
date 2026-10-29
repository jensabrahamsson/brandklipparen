// Live new-tokens list client (E-11 follow-up): typed fetch over the
// versioned REST API plus calm age formatting. Contract values travel as
// inert JSON text and render as text only.
import { ApiError } from "./api.ts";

export type LiveTokenState = "queued" | "analyzing" | "done" | "cant-tell" | "skipped" | "error";

export type LiveTokenEntry = {
  readonly tokenAddress: string;
  readonly symbol: string | null;
  readonly name: string | null;
  readonly pairAddress: string;
  readonly dex: string;
  readonly feeTier?: number | undefined;
  readonly block: number;
  readonly createdAt: number;
  readonly blockTimestampMs: number | null;
  readonly ageSeconds: number | null;
  readonly initialLiquidityWeth: string | null;
  readonly state: LiveTokenState;
  readonly riskBand?: string | undefined;
  readonly score?: number | undefined;
  readonly reason?: string | undefined;
};

export type LiveTokensSnapshot = {
  readonly source: "etherscan" | "rpc" | "none";
  readonly status: "live" | "not-configured";
  readonly message?: string | undefined;
  readonly updatedAt: number;
  readonly items: readonly LiveTokenEntry[];
};

export type LiveFilter = "All" | "Elevated & high" | "Low";

// Risk filters with honest labels (S-124): the middle filter names both
// bands it includes, so the label can never contradict the badge.
export function filterLiveEntries(items: readonly LiveTokenEntry[], filter: LiveFilter): readonly LiveTokenEntry[] {
  if (filter === "Elevated & high") {
    return items.filter((entry) => entry.riskBand === "High" || entry.riskBand === "Elevated");
  }
  if (filter === "Low") {
    return items.filter((entry) => entry.riskBand === "Low");
  }
  return items;
}

// Count line with correct grammar (S-124): "1 new token", never "1 new tokens".
export function tokenCountLabel(count: number): string {
  return count === 1 ? "1 new token" : `${count} new tokens`;
}

// Quiet liveness note (S-124, S-132): human-scale time since the feed's
// last update, so the line reads plainly instead of ticking up seconds
// forever. The feed counts as stale after two minutes without an update:
// twelve missed 10 s polls and past the app's own 2-minute "new" window,
// so a stuck feed reads as paused instead of merely old.
export const FEED_STALE_AFTER_MS = 120_000;

export function feedAgeSeconds(updatedAt: number, nowMs: number): number {
  return Math.max(0, Math.round((nowMs - updatedAt) / 1000));
}

function humanDuration(totalSeconds: number): string {
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

export function updatedAgoLabel(updatedAt: number, nowMs: number): string {
  const seconds = feedAgeSeconds(updatedAt, nowMs);
  if (seconds < 5) {
    return "Updated just now";
  }
  return `Updated ${humanDuration(seconds)} ago`;
}

export function isFeedStale(updatedAt: number, nowMs: number): boolean {
  return nowMs - updatedAt > FEED_STALE_AFTER_MS;
}

export function feedStatusLabel(updatedAt: number, nowMs: number): string {
  if (isFeedStale(updatedAt, nowMs)) {
    return `Feed paused, last update ${humanDuration(feedAgeSeconds(updatedAt, nowMs))} ago`;
  }
  return updatedAgoLabel(updatedAt, nowMs);
}

// Buffering (S-124): while the reader is scrolled or focused inside the
// list, new rows wait in a buffer instead of pushing the table down. The
// newest poll's unseen entries come first; nothing already shown or
// buffered ever repeats.
export function unseenEntries(
  displayed: readonly LiveTokenEntry[],
  incoming: readonly LiveTokenEntry[],
  buffered: readonly LiveTokenEntry[],
): LiveTokenEntry[] {
  const known = new Set([...displayed, ...buffered].map((entry) => entry.pairAddress));
  const fresh = incoming.filter((entry) => !known.has(entry.pairAddress));
  return [...fresh, ...buffered];
}

export function mergeShown(
  displayed: readonly LiveTokenEntry[],
  buffered: readonly LiveTokenEntry[],
): LiveTokenEntry[] {
  const shown = new Set(displayed.map((entry) => entry.pairAddress));
  return [...buffered.filter((entry) => !shown.has(entry.pairAddress)), ...displayed];
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

export async function fetchLiveTokens(apiKey: string | null): Promise<LiveTokensSnapshot> {
  const headers: Record<string, string> = apiKey === null || apiKey.length === 0 ? {} : { "x-api-key": apiKey };
  const response = await fetch("/v1/live-tokens", { headers });
  if (!response.ok) {
    throw await readError(response, "request-failed");
  }
  return (await response.json()) as LiveTokensSnapshot;
}

// Human age text for the list ("just now", "3 min ago", "2 h ago"):
// whole units only, derived from the feed's own chain timestamp, so the
// column rarely changes width between 10 s polls. An unknown chain age
// reads as a labelled "unknown", never a bare dash that looks like a bug.
export function formatAge(ageSeconds: number | null): string {
  if (ageSeconds === null || !Number.isFinite(ageSeconds)) {
    return "unknown";
  }
  if (ageSeconds < 60) {
    return "just now";
  }
  if (ageSeconds < 3600) {
    return `${Math.floor(ageSeconds / 60)} min ago`;
  }
  if (ageSeconds < 86400) {
    return `${Math.floor(ageSeconds / 3600)} h ago`;
  }
  return `${Math.floor(ageSeconds / 86400)} d ago`;
}

export function shortAddress(address: string): string {
  if (address.length < 12) {
    return address;
  }
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
