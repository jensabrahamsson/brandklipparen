// Feed cursor and pending-queue persistence (S-103, K-039, A-05).
// Process-bound adapter: the poller stores the block cursor beside the
// pending queue in one small JSON file whose path comes from the validated
// configuration, and resumes the next poll from it. Writes are atomic
// (temporary file plus rename), so a crash never leaves a half-written
// state behind. Reads validate the shape and fail typed on a corrupt
// file; a missing file loads as null so the first poll starts clean.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import type { PendingCandidate } from "../../domain/lpFeed.ts";

export type PersistedFeedState = {
  readonly version: 1;
  readonly cursorBlock: number;
  readonly pending: readonly PendingCandidate[];
  readonly seenKeys: readonly string[];
  readonly blockHashes: readonly (readonly [string, string])[];
};

export type FeedStateFileError =
  | { kind: "unreadable"; message: string }
  | { kind: "unwritable"; message: string }
  | { kind: "invalid-state"; message: string };

function isHexAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isHexHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPendingCandidate(value: unknown): value is PendingCandidate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as { readonly [field: string]: unknown };
  if (record["chainId"] !== 1) {
    return false;
  }
  if (!isHexAddress(record["tokenAddress"])) {
    return false;
  }
  const pool = record["pool"];
  if (typeof pool !== "object" || pool === null || Array.isArray(pool)) {
    return false;
  }
  const poolRecord = pool as { readonly [field: string]: unknown };
  if (poolRecord["kind"] === "pair") {
    if (!isHexAddress(poolRecord["address"])) {
      return false;
    }
  } else if (poolRecord["kind"] === "poolId") {
    if (typeof poolRecord["id"] !== "string" || (poolRecord["id"] as string).length === 0) {
      return false;
    }
  } else {
    return false;
  }
  if (!isSafeInt(record["blockNumber"]) || !isHexHash(record["blockHash"])) {
    return false;
  }
  if (!isHexHash(record["txHash"]) || !isSafeInt(record["logIndex"])) {
    return false;
  }
  if (typeof record["dex"] !== "string" || (record["dex"] as string).length === 0) {
    return false;
  }
  if (!isSafeInt(record["queuedAtMs"])) {
    return false;
  }
  return true;
}

function parsePersistedState(raw: unknown): PersistedFeedState | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const record = raw as { readonly [field: string]: unknown };
  if (record["version"] !== 1) {
    return null;
  }
  if (!isSafeInt(record["cursorBlock"])) {
    return null;
  }
  const pending = record["pending"];
  if (!Array.isArray(pending) || !pending.every(isPendingCandidate)) {
    return null;
  }
  const seenKeys = record["seenKeys"];
  if (
    !Array.isArray(seenKeys) ||
    !seenKeys.every((key): key is string => typeof key === "string")
  ) {
    return null;
  }
  const blockHashes = record["blockHashes"];
  if (
    !Array.isArray(blockHashes) ||
    !blockHashes.every(
      (entry): entry is readonly [string, string] =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string",
    )
  ) {
    return null;
  }
  return Object.freeze({
    version: 1 as const,
    cursorBlock: record["cursorBlock"] as number,
    pending: Object.freeze([...(pending as PendingCandidate[])]),
    seenKeys: Object.freeze([...(seenKeys as string[])]),
    blockHashes: Object.freeze(
      (blockHashes as [string, string][]).map((entry) =>
        Object.freeze([entry[0], entry[1]] as const),
      ),
    ),
  });
}

// Atomic write of the feed state (S-103): the JSON document lands in a
// temporary sibling first and is renamed over the state path, so readers
// observe either the previous state or the new one, never a fragment.
export function saveFeedState(path: string, state: PersistedFeedState): Result<null, FeedStateFileError> {
  let body: string;
  try {
    body = JSON.stringify({
      version: state.version,
      cursorBlock: state.cursorBlock,
      pending: state.pending,
      seenKeys: state.seenKeys,
      blockHashes: state.blockHashes,
    });
  } catch {
    return err({ kind: "unwritable", message: "the feed state is not serializable" });
  }
  const tmpPath = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmpPath, body, "utf8");
  } catch {
    return err({ kind: "unwritable", message: "the feed state file is not writable" });
  }
  try {
    renameSync(tmpPath, path);
  } catch {
    return err({ kind: "unwritable", message: "the feed state file is not writable" });
  }
  return ok(null);
}

// Load of the feed state (S-103): a missing file is a clean start, while
// unreadable bytes or a shape mismatch fail typed so the operator
// notices instead of silently rescanning or dropping the queue.
export function loadFeedState(path: string): Result<PersistedFeedState | null, FeedStateFileError> {
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch (error: unknown) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return ok(null);
    }
    return err({ kind: "unreadable", message: "the feed state file is not readable" });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body) as unknown;
  } catch {
    return err({ kind: "invalid-state", message: "the feed state file holds no JSON document" });
  }
  const parsed = parsePersistedState(raw);
  if (parsed === null) {
    return err({ kind: "invalid-state", message: "the feed state file holds an unknown shape" });
  }
  return ok(parsed);
}
