// Time-based and cluster-based dataset splits (K-203, K-204, S-018).
// Written first (red) per A-21; the implementation lives in
// src/domain/splits.ts. Fixtures below are synthetic rows built from the
// S-017 smart constructors: invented addresses, bytecodes and blocks with
// no link to a real contract and no predictive meaning.
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import {
  defaultClusterKey,
  splitByCluster,
  splitByTime,
} from "../../../src/domain/splits.ts";
import type {
  DatasetSplit,
  SplitError,
  SplitRatios,
} from "../../../src/domain/splits.ts";
import { summarizeForTraining } from "../../../src/domain/dataset.ts";
import type {
  Dataset,
  DatasetDataPoint,
} from "../../../src/domain/dataset.ts";
import type { Result } from "../../../src/domain/result.ts";
import {
  Address,
  BlockNumber,
  Bytecode,
  CodeHash,
  SkeletonHash,
} from "../../../src/domain/types.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function mustSplit(result: Result<DatasetSplit, SplitError>): DatasetSplit {
  if (!result.ok) {
    throw new Error(`expected split, got ${result.error.kind}: ${result.error.message}`);
  }
  return result.value;
}

// Near-duplicate pair: different code hashes, one skeleton hash (only the
// PUSH operand differs, and operands are masked in the skeleton hash).
const BYTECODE_A1 = "0x6001600055";
const BYTECODE_A2 = "0x6002600055";
const BYTECODE_B1 = "0x600160005501";
const BYTECODE_B2 = "0x600260005502";
const BYTECODE_C1 = "0x600160005503";
const BYTECODE_C2 = "0x600260005503";

const ADDRESSES = [
  "0x0102030405060708090a0b0c0d0e0f1011121314",
  "0x0102030405060708090a0b0c0d0e0f1011121315",
  "0x0102030405060708090a0b0c0d0e0f1011121316",
  "0x0102030405060708090a0b0c0d0e0f1011121317",
  "0x0102030405060708090a0b0c0d0e0f1011121318",
  "0x0102030405060708090a0b0c0d0e0f1011121319",
  "0x0102030405060708090a0b0c0d0e0f101112131a",
  "0x0102030405060708090a0b0c0d0e0f101112131b",
] as const;

function makePoint(address: string, bytecodeHex: string, block: number): DatasetDataPoint {
  const bytecode = mustOk(Bytecode.parse(bytecodeHex));
  return {
    address: mustOk(Address.parse(address)),
    bytecode,
    blockNumber: mustOk(BlockNumber.of(block)),
    source: "synthetic-test",
    codeHash: mustOk(CodeHash.of(bytecode)),
    label: {
      "rug-pull": "negative",
      honeypot: "negative",
      "bot-pump": "negative",
      rationale: "no-capability-found",
    },
  };
}

function makeDataset(rows: ReadonlyArray<{ address: string; bytecode: string; block: number }>): Dataset {
  const datapoints = rows.map((row) => makePoint(row.address, row.bytecode, row.block));
  const blocks = datapoints.map((point) => point.blockNumber as number);
  return {
    dataVersion: "test-v1",
    labelPolicyVersion: "1.0.0",
    blockRange: { from: Math.min(...blocks), to: Math.max(...blocks) },
    datapoints: Object.freeze(datapoints),
  };
}

function blocksOf(split: Dataset): number[] {
  return split.datapoints.map((point) => point.blockNumber as number);
}

function clusterKeysOf(split: Dataset): Set<string> {
  return new Set(split.datapoints.map((point) => defaultClusterKey(point)));
}

const RATIOS: SplitRatios = { trainRatio: 0.5, calibrationRatio: 0.25 };

describe("time-based and cluster-based splits (K-203, K-204)", () => {
  test("k203_test_split_strictly_after_training_split", () => {
    const dataset = makeDataset([
      { address: ADDRESSES[0] as string, bytecode: BYTECODE_A1, block: 23100001 },
      { address: ADDRESSES[1] as string, bytecode: BYTECODE_B1, block: 23100002 },
      { address: ADDRESSES[2] as string, bytecode: BYTECODE_C1, block: 23100003 },
      { address: ADDRESSES[3] as string, bytecode: BYTECODE_A2, block: 23100004 },
      { address: ADDRESSES[4] as string, bytecode: BYTECODE_B2, block: 23100005 },
      { address: ADDRESSES[5] as string, bytecode: BYTECODE_C2, block: 23100006 },
    ]);
    const split = mustSplit(splitByTime(dataset, RATIOS));
    expect(split.train.datapoints.length).toBeGreaterThan(0);
    expect(split.calibration.datapoints.length).toBeGreaterThan(0);
    expect(split.test.datapoints.length).toBeGreaterThan(0);
    // Every test datapoint is strictly after every training datapoint.
    const trainMax = Math.max(...blocksOf(split.train));
    const testMin = Math.min(...blocksOf(split.test));
    expect(testMin).toBeGreaterThan(trainMax);
    // The calibration split sits strictly between training and test.
    const calibrationBlocks = blocksOf(split.calibration);
    expect(Math.min(...calibrationBlocks)).toBeGreaterThan(trainMax);
    expect(Math.max(...calibrationBlocks)).toBeLessThan(testMin);
    // The split carries the versioned inputs for the S-019 freeze path.
    expect(split.train.dataVersion).toBe(dataset.dataVersion);
    expect(split.train.labelPolicyVersion).toBe(dataset.labelPolicyVersion);
  });

  test("k204_no_cluster_spans_splits", () => {
    // Clone clusters deliberately interleave in time: cluster A sits at the
    // oldest and newest blocks, so a pure time cut would tear it apart.
    const dataset = makeDataset([
      { address: ADDRESSES[0] as string, bytecode: BYTECODE_A1, block: 23100001 },
      { address: ADDRESSES[1] as string, bytecode: BYTECODE_B1, block: 23100002 },
      { address: ADDRESSES[2] as string, bytecode: BYTECODE_B2, block: 23100003 },
      { address: ADDRESSES[3] as string, bytecode: BYTECODE_C1, block: 23100004 },
      { address: ADDRESSES[4] as string, bytecode: BYTECODE_A2, block: 23100005 },
      { address: ADDRESSES[5] as string, bytecode: BYTECODE_C2, block: 23100006 },
    ]);
    // Sanity: the fixture really holds near-duplicates (same skeleton,
    // different code hash) inside one cluster.
    const a1 = mustOk(SkeletonHash.of(mustOk(Bytecode.parse(BYTECODE_A1))));
    const a2 = mustOk(SkeletonHash.of(mustOk(Bytecode.parse(BYTECODE_A2))));
    expect(a1 as string).toBe(a2 as string);
    expect(BYTECODE_A1).not.toBe(BYTECODE_A2);

    const split = mustSplit(splitByCluster(dataset, { trainRatio: 0.34, calibrationRatio: 0.33 }));
    expect(split.train.datapoints.length).toBeGreaterThan(0);
    expect(split.calibration.datapoints.length).toBeGreaterThan(0);
    expect(split.test.datapoints.length).toBeGreaterThan(0);
    const trainKeys = clusterKeysOf(split.train);
    const calibrationKeys = clusterKeysOf(split.calibration);
    const testKeys = clusterKeysOf(split.test);
    for (const key of trainKeys) {
      expect(calibrationKeys.has(key)).toBe(false);
      expect(testKeys.has(key)).toBe(false);
    }
    for (const key of calibrationKeys) {
      expect(testKeys.has(key)).toBe(false);
    }
    // No datapoint is lost or duplicated across the three splits.
    const total =
      split.train.datapoints.length +
      split.calibration.datapoints.length +
      split.test.datapoints.length;
    expect(total).toBe(dataset.datapoints.length);
  });

  test("k203_time_split_rejects_empty_dataset_with_typed_error", () => {
    const dataset: Dataset = {
      dataVersion: "test-v1",
      labelPolicyVersion: "1.0.0",
      blockRange: { from: 0, to: 0 },
      datapoints: Object.freeze([]),
    };
    const timeResult = splitByTime(dataset, RATIOS);
    expect(timeResult.ok).toBe(false);
    if (timeResult.ok) {
      throw new Error("expected a typed empty-dataset error");
    }
    expect(timeResult.error.kind).toBe("empty-dataset");
    const clusterResult = splitByCluster(dataset, RATIOS);
    expect(clusterResult.ok).toBe(false);
    if (clusterResult.ok) {
      throw new Error("expected a typed empty-dataset error");
    }
    expect(clusterResult.error.kind).toBe("empty-dataset");
  });

  test("k204_cluster_split_rejects_single_cluster_with_typed_error", () => {
    // One skeleton cluster across several blocks: nothing to separate.
    const dataset = makeDataset([
      { address: ADDRESSES[0] as string, bytecode: BYTECODE_A1, block: 23100001 },
      { address: ADDRESSES[1] as string, bytecode: BYTECODE_A2, block: 23100002 },
      { address: ADDRESSES[2] as string, bytecode: BYTECODE_A1, block: 23100003 },
    ]);
    const result = splitByCluster(dataset, RATIOS);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected a typed insufficient-clusters error");
    }
    expect(result.error.kind).toBe("insufficient-clusters");
  });

  test("k203_time_split_rejects_single_block_with_typed_error", () => {
    // Every datapoint shares one block: enough rows for three splits, but
    // no strictly-later test split exists.
    const dataset = makeDataset([
      { address: ADDRESSES[0] as string, bytecode: BYTECODE_A1, block: 23100001 },
      { address: ADDRESSES[1] as string, bytecode: BYTECODE_B1, block: 23100001 },
      { address: ADDRESSES[2] as string, bytecode: BYTECODE_C1, block: 23100001 },
      { address: ADDRESSES[3] as string, bytecode: BYTECODE_A2, block: 23100001 },
      { address: ADDRESSES[4] as string, bytecode: BYTECODE_B2, block: 23100001 },
      { address: ADDRESSES[5] as string, bytecode: BYTECODE_C2, block: 23100001 },
    ]);
    const result = splitByTime(dataset, RATIOS);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected a typed no-time-boundary error");
    }
    expect(result.error.kind).toBe("no-time-boundary");
  });

  test("k203_split_rejects_invalid_ratios_with_typed_error", () => {
    const dataset = makeDataset([
      { address: ADDRESSES[0] as string, bytecode: BYTECODE_A1, block: 23100001 },
      { address: ADDRESSES[1] as string, bytecode: BYTECODE_B1, block: 23100002 },
      { address: ADDRESSES[2] as string, bytecode: BYTECODE_C1, block: 23100003 },
    ]);
    const badRatios: readonly SplitRatios[] = [
      { trainRatio: 0, calibrationRatio: 0.25 },
      { trainRatio: 0.5, calibrationRatio: 0 },
      { trainRatio: 0.6, calibrationRatio: 0.4 },
      { trainRatio: Number.NaN, calibrationRatio: 0.25 },
    ];
    for (const ratios of badRatios) {
      for (const result of [splitByTime(dataset, ratios), splitByCluster(dataset, ratios)]) {
        expect(result.ok).toBe(false);
        if (result.ok) {
          throw new Error("expected a typed invalid-ratio error");
        }
        expect(result.error.kind).toBe("invalid-ratio");
      }
    }
  });

  test("k203_time_split_leaves_input_unchanged_and_is_deterministic", () => {
    const dataset = makeDataset([
      { address: ADDRESSES[0] as string, bytecode: BYTECODE_A1, block: 23100001 },
      { address: ADDRESSES[1] as string, bytecode: BYTECODE_B1, block: 23100002 },
      { address: ADDRESSES[2] as string, bytecode: BYTECODE_C1, block: 23100003 },
      { address: ADDRESSES[3] as string, bytecode: BYTECODE_A2, block: 23100004 },
      { address: ADDRESSES[4] as string, bytecode: BYTECODE_B2, block: 23100005 },
      { address: ADDRESSES[5] as string, bytecode: BYTECODE_C2, block: 23100006 },
    ]);
    const before = JSON.stringify(dataset);
    const first = mustSplit(splitByTime(dataset, RATIOS));
    const second = mustSplit(splitByTime(dataset, RATIOS));
    expect(JSON.stringify(dataset)).toBe(before);
    expect(second).toEqual(first);
  });

  test("k204_train_split_feeds_s019_freeze_input_shape", () => {
    const dataset = makeDataset([
      { address: ADDRESSES[0] as string, bytecode: BYTECODE_A1, block: 23100001 },
      { address: ADDRESSES[1] as string, bytecode: BYTECODE_B1, block: 23100002 },
      { address: ADDRESSES[2] as string, bytecode: BYTECODE_C1, block: 23100003 },
      { address: ADDRESSES[3] as string, bytecode: BYTECODE_A2, block: 23100004 },
      { address: ADDRESSES[4] as string, bytecode: BYTECODE_B2, block: 23100005 },
      { address: ADDRESSES[5] as string, bytecode: BYTECODE_C2, block: 23100006 },
    ]);
    // The train split is a Dataset, so the S-019 freeze path consumes it
    // through the existing summarizeForTraining roll-up with no adapter.
    const timeSplit = mustSplit(splitByTime(dataset, RATIOS));
    const timeOutcomes = summarizeForTraining(timeSplit.train);
    const timePositives =
      timeOutcomes["rug-pull"].positives +
      timeOutcomes.honeypot.positives +
      timeOutcomes["bot-pump"].positives;
    const timeNegatives =
      timeOutcomes["rug-pull"].negatives +
      timeOutcomes.honeypot.negatives +
      timeOutcomes["bot-pump"].negatives;
    expect(timePositives + timeNegatives).toBe(timeSplit.train.datapoints.length * 3);

    const clusterSplit = mustSplit(
      splitByCluster(dataset, { trainRatio: 0.34, calibrationRatio: 0.33 }),
    );
    const clusterOutcomes = summarizeForTraining(clusterSplit.train);
    const clusterTotal =
      clusterOutcomes["rug-pull"].positives +
      clusterOutcomes["rug-pull"].negatives +
      clusterOutcomes.honeypot.positives +
      clusterOutcomes.honeypot.negatives +
      clusterOutcomes["bot-pump"].positives +
      clusterOutcomes["bot-pump"].negatives;
    expect(clusterTotal).toBe(clusterSplit.train.datapoints.length * 3);
  });
});

const BYTECODE_CHOICES = [BYTECODE_A1, BYTECODE_A2, BYTECODE_B1, BYTECODE_B2, BYTECODE_C1] as const;

describe("split properties (K-203, K-204)", () => {
  test("time_split_either_fails_typed_or_orders_test_strictly_after_train", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            code: fc.constantFrom(...BYTECODE_CHOICES),
            block: fc.integer({ min: 23100001, max: 23100004 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (rows) => {
          const dataset = makeDataset(
            rows.map((row, index) => ({
              address: `0x${index.toString(16).padStart(40, "0")}`,
              bytecode: row.code,
              block: row.block,
            })),
          );
          const before = JSON.stringify(dataset);
          const result = splitByTime(dataset, RATIOS);
          expect(JSON.stringify(dataset)).toBe(before);
          if (!result.ok) {
            expect([
              "invalid-ratio",
              "empty-dataset",
              "insufficient-data",
              "no-time-boundary",
            ]).toContain(result.error.kind);
            return;
          }
          const trainMax = Math.max(...blocksOf(result.value.train));
          const testMin = Math.min(...blocksOf(result.value.test));
          expect(testMin).toBeGreaterThan(trainMax);
          const total =
            result.value.train.datapoints.length +
            result.value.calibration.datapoints.length +
            result.value.test.datapoints.length;
          expect(total).toBe(dataset.datapoints.length);
        },
      ),
      { numRuns: 30 },
    );
  });

  test("cluster_split_either_fails_typed_or_keeps_every_cluster_whole", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...BYTECODE_CHOICES), { minLength: 1, maxLength: 8 }),
        (codes) => {
          const dataset = makeDataset(
            codes.map((code, index) => ({
              address: `0x${index.toString(16).padStart(40, "0")}`,
              bytecode: code,
              block: 23100001 + (index % 4),
            })),
          );
          const result = splitByCluster(dataset, RATIOS);
          if (!result.ok) {
            expect(["invalid-ratio", "empty-dataset", "insufficient-clusters"]).toContain(
              result.error.kind,
            );
            return;
          }
          const trainKeys = clusterKeysOf(result.value.train);
          const calibrationKeys = clusterKeysOf(result.value.calibration);
          const testKeys = clusterKeysOf(result.value.test);
          for (const key of trainKeys) {
            expect(calibrationKeys.has(key)).toBe(false);
            expect(testKeys.has(key)).toBe(false);
          }
          for (const key of calibrationKeys) {
            expect(testKeys.has(key)).toBe(false);
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
