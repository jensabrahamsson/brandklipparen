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

// Quiet liveness note (S-124): whole seconds since the last successful
// poll, so the column rarely changes width between 10 s polls.
export function updatedAgoLabel(updatedAt: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - updatedAt) / 1000));
  return `Updated ${seconds} s ago`;
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

// Calm age text for the list ("45s", "2m", "1h", "3d"): whole units
// only, so the column rarely changes width between 10 s polls. An
// unknown chain age renders as "-".
export function formatAge(ageSeconds: number | null): string {
  if (ageSeconds === null || !Number.isFinite(ageSeconds)) {
    return "-";
  }
  if (ageSeconds < 60) {
    return `${Math.max(0, Math.floor(ageSeconds))}s`;
  }
  if (ageSeconds < 3600) {
    return `${Math.floor(ageSeconds / 60)}m`;
  }
  if (ageSeconds < 86400) {
    return `${Math.floor(ageSeconds / 3600)}h`;
  }
  return `${Math.floor(ageSeconds / 86400)}d`;
}

export function shortAddress(address: string): string {
  if (address.length < 12) {
    return address;
  }
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
