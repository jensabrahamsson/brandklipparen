// Training-snapshot file loader (session B).
// Driven adapter: reads the externally supplied point-in-time snapshot
// file from an operator path outside the repo, parses its JSON, and
// validates it through the shared domain schema. A missing or unreadable
// file, invalid JSON, or a schema breach is a typed error the calibration
// runner turns into a loud failure, never a silent fallback.
import { readFileSync } from "node:fs";
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import { parseSnapshotFile } from "../../domain/onchain/snapshot.ts";
import type { SnapshotFile } from "../../domain/onchain/snapshot.ts";

export type SnapshotLoadError =
  | { kind: "read-error"; message: string }
  | { kind: "json-error"; message: string }
  | { kind: "schema-error"; message: string };

// The path travels as the operator-given value and never enters the repo;
// only the message (never file contents) reaches the caller.
export function loadOnchainSnapshotFile(path: string): Result<SnapshotFile, SnapshotLoadError> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return err({ kind: "read-error", message: `cannot read onchain snapshot file at ${path}` });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return err({ kind: "json-error", message: `onchain snapshot file at ${path} is not valid JSON` });
  }
  const validated = parseSnapshotFile(parsed);
  if (!validated.ok) {
    return err({ kind: "schema-error", message: `onchain snapshot file at ${path}: ${validated.error.message}` });
  }
  return ok(validated.value);
}
