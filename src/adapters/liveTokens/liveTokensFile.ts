// Live-tokens list persistence (E-11 follow-up): the small JSON file
// under the git-ignored cache dir (BRANDKLIPPAREN_CACHE_DIR, for
// example `.cache/brandklipparen/live-tokens.json`). Writes are atomic
// (temporary file plus rename) and create the parent directory, so a
// crash never leaves a half-written list behind. Reads validate the
// shape; a missing file loads as null so the first poll starts from the
// trailing blocks. Corrupt files fail typed so the operator notices.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import { parseLiveTokensDoc } from "../../domain/liveTokens.ts";
import type { LiveTokensDoc } from "../../domain/liveTokens.ts";

export type LiveTokensFileError =
  | { kind: "unreadable"; message: string }
  | { kind: "unwritable"; message: string }
  | { kind: "invalid-state"; message: string };

export function saveLiveTokensFile(
  path: string,
  doc: LiveTokensDoc,
): Result<null, LiveTokensFileError> {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    return err({ kind: "unwritable", message: "the live-tokens directory is not writable" });
  }
  let tmpPath = "";
  try {
    tmpPath = `${path}.tmp-${process.pid}`;
    writeFileSync(tmpPath, JSON.stringify({ version: doc.version, cursorBlock: doc.cursorBlock, items: doc.items }), "utf8");
  } catch {
    return err({ kind: "unwritable", message: "the live-tokens file is not writable" });
  }
  try {
    renameSync(tmpPath, path);
  } catch {
    return err({ kind: "unwritable", message: "the live-tokens file is not writable" });
  }
  return ok(null);
}

export function loadLiveTokensFile(path: string): Result<LiveTokensDoc | null, LiveTokensFileError> {
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch (error: unknown) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return ok(null);
    }
    return err({ kind: "unreadable", message: "the live-tokens file is not readable" });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body) as unknown;
  } catch {
    return err({ kind: "invalid-state", message: "the live-tokens file holds no JSON document" });
  }
  const parsed = parseLiveTokensDoc(raw);
  if (parsed === null) {
    return err({ kind: "invalid-state", message: "the live-tokens file holds an unknown shape" });
  }
  return ok(parsed);
}
