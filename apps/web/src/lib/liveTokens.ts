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

export type LiveFilter = "All" | "Elevated+" | "Low";

// Risk filters with honest labels (S-124): "Elevated+" covers the Elevated
// and High bands, so the label can never contradict the badge.
export function filterLiveEntries(items: readonly LiveTokenEntry[], filter: LiveFilter): readonly LiveTokenEntry[] {
  if (filter === "Elevated+") {
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
    return "Just now";
  }
  return `Updated ${humanDuration(seconds)} ago`;
}

export function isFeedStale(updatedAt: number, nowMs: number): boolean {
  return nowMs - updatedAt > FEED_STALE_AFTER_MS;
}

export function feedStatusLabel(updatedAt: number, nowMs: number): string {
  if (isFeedStale(updatedAt, nowMs)) {
    return `Paused. Updated ${humanDuration(feedAgeSeconds(updatedAt, nowMs))} ago.`;
  }
  return updatedAgoLabel(updatedAt, nowMs);
}

// Engagement (F-13 fix): the reader counts as engaged only while focus
// or hover is inside the section. Scroll position alone never counts:
// both feeds sit below the fold, so `scrollY > 0` kept every shown row
// stuck on "analyzing…" and left the header reading paused while polls
// were succeeding.
export function isSectionEngaged(
  root: { contains(node: Node | null): boolean; matches(selector: string): boolean } | null | undefined,
): boolean {
  if (root === null || root === undefined) {
    return false;
  }
  if (typeof document !== "undefined" && root.contains(document.activeElement)) {
    return true;
  }
  try {
    return root.matches(":hover");
  } catch {
    return false;
  }
}

// Refresh (F-13 fix): merge a poll's updates into the rows the reader
// already sees, matched by pair address, keeping the shown order. Rows
// already on screen therefore keep resolving (analyzing → scored) while
// the reader is engaged; only unseen rows wait in the buffer.
export function refreshShown(
  displayed: readonly LiveTokenEntry[],
  incoming: readonly LiveTokenEntry[],
): LiveTokenEntry[] {
  if (incoming.length === 0) {
    return [...displayed];
  }
  const freshByPair = new Map(incoming.map((entry) => [entry.pairAddress, entry]));
  return displayed.map((entry) => freshByPair.get(entry.pairAddress) ?? entry);
}

export function nextLiveView(
  current: { readonly snapshot: LiveTokensSnapshot; readonly buffered: readonly LiveTokenEntry[] } | null,
  next: LiveTokensSnapshot,
  engaged: boolean,
): { snapshot: LiveTokensSnapshot; buffered: readonly LiveTokenEntry[] } {
  if (current === null || !engaged) {
    return { snapshot: next, buffered: [] };
  }
  const shown = refreshShown(current.snapshot.items, next.items);
  return {
    snapshot: { ...next, items: shown },
    buffered: unseenEntries(shown, next.items, current.buffered),
  };
}

// Buffering (S-124): while the reader is focused inside the list or
// hovering it, new rows wait in a buffer instead of pushing the table
// down. The newest poll's unseen entries come first; nothing already
// shown or buffered ever repeats.
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
  const fallback = new ApiError(fallbackCode, response.status, `Request failed (${response.status}).`);
  return response
    .json()
    .then((body) => {
      const record = body as { code?: unknown; message?: unknown };
      const code = typeof record.code === "string" && record.code.length > 0 ? record.code : fallbackCode;
      const message =
        typeof record.message === "string" && record.message.length > 0
          ? record.message
          : `Request failed (${response.status}).`;
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

// Compact age (DX-1 feed rows, W-7 contract facts): "12m ago", "3h ago",
// "2d ago". Whole units from the feed's own chain timestamp, so the feed
// column rarely changes width between polls and the facts value stays on
// one line. Unknown stays a labelled "unknown".
export function formatAgeCompact(ageSeconds: number | null): string {
  if (ageSeconds === null || !Number.isFinite(ageSeconds)) {
    return "unknown";
  }
  if (ageSeconds < 60) {
    return "just now";
  }
  if (ageSeconds < 3600) {
    return `${Math.floor(ageSeconds / 60)}m ago`;
  }
  if (ageSeconds < 86400) {
    return `${Math.floor(ageSeconds / 3600)}h ago`;
  }
  return `${Math.floor(ageSeconds / 86400)}d ago`;
}

export function shortAddress(address: string): string {
  if (address.length < 12) {
    return address;
  }
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
