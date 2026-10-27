// Time-based and cluster-based dataset splits (K-203, K-204, S-018).
// Pure domain module: deterministic three-way splits of the versioned S-017
// dataset into training, calibration and test sets. No I/O, no clock, no
// randomness, no environment access, no platform imports. Split ratios
// arrive as caller parameters (offline placeholders, never model values);
// detection thresholds, weights and limits live solely in the versioned
// model artifact per K-210 and A-20.
import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";
import type { Dataset, DatasetDataPoint } from "./dataset.ts";
import { SkeletonHash } from "./types.ts";

// Caller-supplied split ratios (placeholders from the offline chain, not
// model values): the test share is the remainder after training and
// calibration, so the two given shares must each be positive and sum below
// one.
export type SplitRatios = {
  readonly trainRatio: number;
  readonly calibrationRatio: number;
};

// A custom cluster key for synthetic fixtures or a future clone group id.
// The default key is the skeleton hash derived from the bytecode (K-204:
// equal code hashes and near-duplicates share one skeleton hash).
export type ClusterKeyFn = (point: DatasetDataPoint) => string;

export type SplitError =
  | { kind: "invalid-ratio"; message: string }
  | { kind: "empty-dataset"; message: string }
  | { kind: "insufficient-data"; message: string }
  | { kind: "no-time-boundary"; message: string }
  | { kind: "insufficient-clusters"; message: string };

// The three splits with the clustering or time method that produced them.
// Each split is a Dataset carrying the parent data and label policy
// versions, so the S-019 freeze path consumes any split through the
// existing summarizeForTraining roll-up with no adapter.
export type DatasetSplit = {
  readonly train: Dataset;
  readonly calibration: Dataset;
  readonly test: Dataset;
  readonly method: string;
  readonly methodVersion: string;
};

// Versioned split methods for the evaluation report per K-209.
export const TIME_SPLIT_METHOD = "time-block-v1";
export const CLUSTER_SPLIT_METHOD = "skeleton-hash-v1";
export const SPLIT_METHOD_VERSION = "1.0.0";

function invalidRatio(message: string): Result<never, SplitError> {
  return err({ kind: "invalid-ratio", message });
}

function validateRatios(ratios: SplitRatios): SplitError | null {
  if (
    typeof ratios.trainRatio !== "number" ||
    typeof ratios.calibrationRatio !== "number" ||
    !Number.isFinite(ratios.trainRatio) ||
    !Number.isFinite(ratios.calibrationRatio) ||
    ratios.trainRatio <= 0 ||
    ratios.calibrationRatio <= 0 ||
    ratios.trainRatio + ratios.calibrationRatio >= 1
  ) {
    return {
      kind: "invalid-ratio",
      message: "split ratios must hold a positive train and calibration share summing below one",
    };
  }
  return null;
}

// Default cluster key (K-204): the skeleton hash of the bytecode, so equal
// code hashes and near-duplicates (same opcodes, different PUSH operands)
// share one cluster. Falls back to the code hash when the skeleton hash
// cannot be derived, keeping the key total on validated datapoints.
export function defaultClusterKey(point: DatasetDataPoint): string {
  const skeleton = SkeletonHash.of(point.bytecode);
  if (skeleton.ok) {
    return skeleton.value as string;
  }
  return point.codeHash as string;
}

function comparePoints(left: DatasetDataPoint, right: DatasetDataPoint): number {
  const leftBlock = left.blockNumber as number;
  const rightBlock = right.blockNumber as number;
  if (leftBlock !== rightBlock) {
    return leftBlock < rightBlock ? -1 : 1;
  }
  const leftAddress = left.address as string;
  const rightAddress = right.address as string;
  if (leftAddress !== rightAddress) {
    return leftAddress < rightAddress ? -1 : 1;
  }
  const leftHash = left.codeHash as string;
  const rightHash = right.codeHash as string;
  if (leftHash !== rightHash) {
    return leftHash < rightHash ? -1 : 1;
  }
  return 0;
}

function sortedPoints(points: readonly DatasetDataPoint[]): DatasetDataPoint[] {
  const copy = points.slice();
  copy.sort(comparePoints);
  return copy;
}

function blockAt(sorted: readonly DatasetDataPoint[], index: number): number {
  const point = sorted[index];
  if (point === undefined) {
    throw new Error(`split index out of range: ${index}`);
  }
  return point.blockNumber as number;
}

function subDataset(parent: Dataset, points: readonly DatasetDataPoint[]): Dataset {
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    const block = point.blockNumber as number;
    if (block < from) {
      from = block;
    }
    if (block > to) {
      to = block;
    }
  }
  return {
    dataVersion: parent.dataVersion,
    labelPolicyVersion: parent.labelPolicyVersion,
    blockRange: { from, to },
    datapoints: Object.freeze(points.slice()),
  };
}

function targetCounts(total: number, ratios: SplitRatios): { train: number; calibration: number } {
  return {
    train: Math.floor(total * ratios.trainRatio),
    calibration: Math.floor(total * ratios.calibrationRatio),
  };
}

// Time-based split (K-203): the earliest datapoints train, the latest test,
// and the calibration set sits strictly between them. Cut positions snap
// forward past equal-block runs so no block straddles a boundary; when no
// block boundary yields three non-empty splits the result is the typed
// no-time-boundary error. Whole clusters are NOT kept together here (that
// is the cluster split below); the two evaluations are reported separately
// per K-205 and K-206.
export function splitByTime(dataset: Dataset, ratios: SplitRatios): Result<DatasetSplit, SplitError> {
  const ratioError = validateRatios(ratios);
  if (ratioError !== null) {
    return invalidRatio(ratioError.message);
  }
  const total = dataset.datapoints.length;
  if (total === 0) {
    return err({ kind: "empty-dataset", message: "cannot split a dataset with no datapoints" });
  }
  const targets = targetCounts(total, ratios);
  if (targets.train < 1 || targets.calibration < 1 || total - targets.train - targets.calibration < 1) {
    return err({
      kind: "insufficient-data",
      message: "dataset holds too few datapoints for three non-empty time splits",
    });
  }
  const sorted = sortedPoints(dataset.datapoints);
  let trainEnd = targets.train;
  while (trainEnd <= total - 2 && blockAt(sorted, trainEnd - 1) === blockAt(sorted, trainEnd)) {
    trainEnd += 1;
  }
  if (trainEnd > total - 2 || blockAt(sorted, trainEnd - 1) >= blockAt(sorted, trainEnd)) {
    return err({
      kind: "no-time-boundary",
      message: "no block boundary separates a non-empty training split from the rest",
    });
  }
  let calibrationEnd = trainEnd + targets.calibration;
  while (calibrationEnd <= total - 1 && blockAt(sorted, calibrationEnd - 1) === blockAt(sorted, calibrationEnd)) {
    calibrationEnd += 1;
  }
  if (calibrationEnd > total - 1 || blockAt(sorted, calibrationEnd - 1) >= blockAt(sorted, calibrationEnd)) {
    return err({
      kind: "no-time-boundary",
      message: "no block boundary separates a non-empty test split from training and calibration",
    });
  }
  return ok(
    Object.freeze({
      train: subDataset(dataset, sorted.slice(0, trainEnd)),
      calibration: subDataset(dataset, sorted.slice(trainEnd, calibrationEnd)),
      test: subDataset(dataset, sorted.slice(calibrationEnd)),
      method: TIME_SPLIT_METHOD,
      methodVersion: SPLIT_METHOD_VERSION,
    }),
  );
}

// Cluster-based split (K-204): every cluster (one key, one whole group of
// datapoints) lands entirely in training, calibration or test. Clusters are
// ordered by their earliest block and then by key, and are dealt greedily
// towards the ratio targets without ever tearing a cluster apart, so the
// achieved shares approximate the ratios. No time ordering is promised here
// (that is the time split above); the two evaluations are reported
// separately per K-205 and K-206.
export function splitByCluster(
  dataset: Dataset,
  ratios: SplitRatios,
  clusterKey?: ClusterKeyFn,
): Result<DatasetSplit, SplitError> {
  const ratioError = validateRatios(ratios);
  if (ratioError !== null) {
    return invalidRatio(ratioError.message);
  }
  const total = dataset.datapoints.length;
  if (total === 0) {
    return err({ kind: "empty-dataset", message: "cannot split a dataset with no datapoints" });
  }
  const keyOf = clusterKey ?? defaultClusterKey;
  const groups = new Map<string, DatasetDataPoint[]>();
  for (const point of sortedPoints(dataset.datapoints)) {
    const key = keyOf(point);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [point]);
    } else {
      group.push(point);
    }
  }
  const ordered = Array.from(groups.entries());
  ordered.sort((left, right) => {
    const leftFirst = blockAt(left[1], 0);
    const rightFirst = blockAt(right[1], 0);
    if (leftFirst !== rightFirst) {
      return leftFirst < rightFirst ? -1 : 1;
    }
    return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
  });
  const targets = targetCounts(total, ratios);
  let cursor = 0;
  const trainGroups: DatasetDataPoint[][] = [];
  let trainCount = 0;
  while (cursor < ordered.length) {
    const entry = ordered[cursor];
    if (entry === undefined) {
      break;
    }
    if (trainGroups.length > 0 && trainCount + entry[1].length > targets.train) {
      break;
    }
    trainGroups.push(entry[1]);
    trainCount += entry[1].length;
    cursor += 1;
  }
  const calibrationGroups: DatasetDataPoint[][] = [];
  let calibrationCount = 0;
  while (cursor < ordered.length - 1) {
    const entry = ordered[cursor];
    if (entry === undefined) {
      break;
    }
    if (calibrationGroups.length > 0 && calibrationCount + entry[1].length > targets.calibration) {
      break;
    }
    calibrationGroups.push(entry[1]);
    calibrationCount += entry[1].length;
    cursor += 1;
  }
  // The calibration loop stops one cluster early so the test split keeps at
  // least one whole cluster; reaching the end means fewer than three
  // clusters exist.
  if (trainGroups.length === 0 || calibrationGroups.length === 0 || cursor >= ordered.length) {
    return err({
      kind: "insufficient-clusters",
      message: "dataset holds too few clusters for three non-empty cluster splits",
    });
  }
  const flatten = (groupsToFlatten: readonly DatasetDataPoint[][]): DatasetDataPoint[] => {
    const out: DatasetDataPoint[] = [];
    for (const group of groupsToFlatten) {
      for (const point of group) {
        out.push(point);
      }
    }
    return out;
  };
  const testGroups: DatasetDataPoint[][] = [];
  while (cursor < ordered.length) {
    const entry = ordered[cursor];
    if (entry === undefined) {
      break;
    }
    testGroups.push(entry[1]);
    cursor += 1;
  }
  return ok(
    Object.freeze({
      train: subDataset(dataset, flatten(trainGroups)),
      calibration: subDataset(dataset, flatten(calibrationGroups)),
      test: subDataset(dataset, flatten(testGroups)),
      method: CLUSTER_SPLIT_METHOD,
      methodVersion: SPLIT_METHOD_VERSION,
    }),
  );
}
