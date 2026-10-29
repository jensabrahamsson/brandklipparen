// Snapshot-to-calibration join and ablation helpers (session B).
// Application service: joins calibration and holdout rows to the
// externally supplied point-in-time snapshot by token id (lowercase
// address), builds the versioned numeric feature matrix, and carries the
// deterministic rank-AUC used for the era-confounder diagnostic and the
// leakage checks. No I/O, no clock, no network: the adapter loads the
// file, the domain validates and maps it, the script fits the heads.
import { checkSnapshotOffsets, indexSnapshotById, snapshotFeaturesOf } from "../domain/onchain/snapshot.ts";
import type { OffsetViolation, SnapshotFile } from "../domain/onchain/snapshot.ts";

export type OnchainJoinInput = {
  readonly address: string;
};

export type OnchainJoinResult = {
  // One versioned feature vector per input row in input order; rows
  // without a snapshot match map to the all-zero neutral vector, so
  // coverage is explicit instead of silently dropped. Every entry is 0
  // when its source is missing: with no indicator columns a missing
  // feature contributes exactly zero to a linear head.
  readonly matrix: readonly (readonly number[])[];
  // Deploy block per input row in input order (null when the row has no
  // snapshot match or the snapshot leaves it unknown): the era
  // diagnostic reads this alone, and it is never a model feature.
  readonly deployBlocks: readonly (number | null)[];
  // Snapshot block per input row in input order (null when the row has no
  // snapshot match or the snapshot section is unavailable): the second
  // era diagnostic, also never a model feature.
  readonly snapshotBlocks: readonly (number | null)[];
  readonly matched: number;
  readonly missing: number;
  readonly duplicateSnapshots: number;
  readonly unmatchedSnapshots: number;
  readonly invalidRows: number;
  readonly violations: readonly OffsetViolation[];
};

// Join by lowercase address. Rows are never dropped: an unmatched
// calibration row keeps its label with a fully missing (all-zero) feature
// vector, and the counts report the coverage honestly.
export function joinOnchainSnapshot(
  rows: readonly OnchainJoinInput[],
  file: SnapshotFile,
): OnchainJoinResult {
  const { byId, duplicates } = indexSnapshotById(file);
  const matrix: (readonly number[])[] = [];
  const deployBlocks: (number | null)[] = [];
  const snapshotBlocks: (number | null)[] = [];
  const seen = new Set<string>();
  let matched = 0;
  for (const row of rows) {
    const key = row.address.toLowerCase();
    const snapshot = byId.get(key) ?? null;
    if (snapshot === null) {
      matrix.push(snapshotFeaturesOf(null));
      deployBlocks.push(null);
      snapshotBlocks.push(null);
      continue;
    }
    matched += 1;
    seen.add(key);
    matrix.push(snapshotFeaturesOf(snapshot));
    deployBlocks.push(snapshot.deployBlock);
    snapshotBlocks.push(snapshot.snapshot.status === "ok" ? snapshot.snapshot.snapshotBlock : null);
  }
  const { violations } = checkSnapshotOffsets(file);
  return {
    matrix: Object.freeze(matrix),
    deployBlocks: Object.freeze(deployBlocks),
    snapshotBlocks: Object.freeze(snapshotBlocks),
    matched,
    missing: rows.length - matched,
    duplicateSnapshots: duplicates,
    unmatchedSnapshots: file.rows.length - seen.size,
    invalidRows: file.invalidRows.length,
    violations,
  };
}

// Deterministic rank AUC for one score vector against 0/1 labels: the
// probability that a random positive outranks a random negative, with
// ties at half credit. A side with no rows scores 0.5. Pure ranking, so
// monotone transforms (like the log liquidity conversion) leave it
// unchanged, and block-number scale never matters for the era check.
export function rankAUC(scores: readonly number[], labels: readonly (0 | 1)[]): number {
  const paired = scores.map((score, index) => ({ score, label: labels[index] ?? 0 }));
  paired.sort((left, right) => left.score - right.score);
  let positives = 0;
  for (const entry of paired) {
    positives += entry.label;
  }
  const negatives = paired.length - positives;
  if (positives === 0 || negatives === 0) {
    return 0.5;
  }
  let rankSum = 0;
  let cursor = 0;
  while (cursor < paired.length) {
    const value = paired[cursor]?.score ?? 0;
    let end = cursor + 1;
    while (end < paired.length && (paired[end]?.score ?? 0) === value) {
      end += 1;
    }
    const meanRank = (cursor + 1 + end) / 2;
    for (let index = cursor; index < end; index += 1) {
      if ((paired[index]?.label ?? 0) === 1) {
        rankSum += meanRank;
      }
    }
    cursor = end;
  }
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}
