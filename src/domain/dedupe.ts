// Dedupe helpers for real calibration (codehash grouping).
// Pure domain module: exact-duplicate codehash handling for the labeled
// calibration set. Proxies use their implementation bytecode for the
// hash, so a proxy row groups with its logic contract. No I/O, no clock,
// no randomness.
export type DedupeRow = {
  readonly codehash: string;
  readonly label: string;
  readonly labelBasis?: string | undefined;
  readonly labelNote?: string | undefined;
  readonly labelSource?: string | undefined;
};

function strengthOf(row: DedupeRow): number {
  if (row.label === "unknown") {
    return 0;
  }
  if ((row.labelSource ?? "").includes("Do not rug on me labeled_list.csv")) {
    return 1;
  }
  if (row.labelBasis === "token-list") {
    return 2;
  }
  let base = 3;
  if (row.labelBasis === "incident-report") {
    base = 4;
  }
  if ((row.labelNote ?? "").includes("Corroborated by")) {
    base = 5;
  }
  return base;
}

export type DedupeResult<T extends DedupeRow> = {
  readonly kept: readonly T[];
  readonly droppedHoldoutOverlap: number;
  readonly droppedDuplicates: number;
};

export function dedupeCalibration<T extends DedupeRow>(
  rows: readonly T[],
  holdoutHashes: ReadonlySet<string>,
): DedupeResult<T> {
  const afterHoldout: T[] = [];
  let droppedHoldoutOverlap = 0;
  for (const row of rows) {
    if (holdoutHashes.has(row.codehash.toLowerCase())) {
      droppedHoldoutOverlap += 1;
      continue;
    }
    afterHoldout.push(row);
  }
  const byHash = new Map<string, T[]>();
  for (const row of afterHoldout) {
    const key = row.codehash.toLowerCase();
    const group = byHash.get(key);
    if (group === undefined) {
      byHash.set(key, [row]);
    } else {
      group.push(row);
    }
  }
  const kept: T[] = [];
  let droppedDuplicates = 0;
  for (const group of byHash.values()) {
    if (group.length === 1) {
      const only = group[0];
      if (only !== undefined) {
        kept.push(only);
      }
      continue;
    }
    const ordered = [...group].sort((left, right) => strengthOf(right) - strengthOf(left));
    const winner = ordered[0];
    if (winner !== undefined) {
      kept.push(winner);
    }
    droppedDuplicates += group.length - 1;
  }
  kept.sort((left, right) => {
    if (left.codehash < right.codehash) {
      return -1;
    }
    if (left.codehash > right.codehash) {
      return 1;
    }
    return 0;
  });
  return Object.freeze({
    kept: Object.freeze(kept),
    droppedHoldoutOverlap,
    droppedDuplicates,
  });
}
