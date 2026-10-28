// Deterministic stratified grouped train/test split for real calibration.
// Pure domain module: groups never straddle the split (one codehash stays
// in one part), labels stratify (each label splits 75/25 by callers), and
// a fixed integer seed drives a Fisher-Yates shuffle so equal inputs give
// bit-identical outputs on every platform (A-32). No I/O, no clock.
export type SplitRow = {
  readonly codehash: string;
  readonly label: string;
};

export type StratifiedSplit<T extends SplitRow> = {
  readonly train: readonly T[];
  readonly test: readonly T[];
};

function seededNext(state: { value: number }): number {
  let value = state.value >>> 0;
  value = (value * 1664525 + 1013904223) >>> 0;
  state.value = value;
  return value / 4294967296;
}

export function splitStratifiedGrouped<T extends SplitRow>(
  rows: readonly T[],
  trainRatio: number,
  seed: number,
): StratifiedSplit<T> {
  if (!(trainRatio > 0 && trainRatio < 1)) {
    throw new Error("train ratio must lie strictly between 0 and 1");
  }
  if (!Number.isInteger(seed) || seed < 0) {
    throw new Error("split seed must be an integer at least 0");
  }
  const byLabel = new Map<string, T[]>();
  for (const row of rows) {
    const group = byLabel.get(row.label);
    if (group === undefined) {
      byLabel.set(row.label, [row]);
    } else {
      group.push(row);
    }
  }
  const train: T[] = [];
  const test: T[] = [];
  const labels = [...byLabel.keys()].sort();
  for (const label of labels) {
    const group = byLabel.get(label) ?? [];
    const ordered = [...group].sort((left, right) => {
      if (left.codehash < right.codehash) {
        return -1;
      }
      if (left.codehash > right.codehash) {
        return 1;
      }
      return 0;
    });
    const state = { value: (seed ^ hashLabel(label)) >>> 0 };
    for (let index = ordered.length - 1; index > 0; index -= 1) {
      const pick = Math.floor(seededNext(state) * (index + 1));
      const current = ordered[index];
      const chosen = ordered[pick];
      if (current !== undefined && chosen !== undefined) {
        ordered[index] = chosen;
        ordered[pick] = current;
      }
    }
    const trainCount = Math.floor(ordered.length * trainRatio);
    train.push(...ordered.slice(0, trainCount));
    test.push(...ordered.slice(trainCount));
  }
  const byCode = (left: T, right: T): number => {
    if (left.codehash < right.codehash) {
      return -1;
    }
    if (left.codehash > right.codehash) {
      return 1;
    }
    if (left.label < right.label) {
      return -1;
    }
    if (left.label > right.label) {
      return 1;
    }
    return 0;
  };
  train.sort(byCode);
  test.sort(byCode);
  return Object.freeze({ train: Object.freeze(train), test: Object.freeze(test) });
}

function hashLabel(label: string): number {
  let hash = 0;
  for (let index = 0; index < label.length; index += 1) {
    hash = (hash * 31 + (label.charCodeAt(index) ?? 0)) >>> 0;
  }
  return hash;
}
