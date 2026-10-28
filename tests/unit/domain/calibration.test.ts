// Tests for S-115 calibration readiness: per-row labelBasis weighting and
// the calibration-tokens shape converter. Written first (red) per A-21:
// the domain carries no basis weights and no calibration-rows shape until
// this story lands. Every row below is synthetic (0x0102-style addresses,
// hand-assembled bytecode): no real token data anywhere.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  BASIS_WEIGHT_DEFAULTS,
  expandByBasisWeight,
  parseBasisWeights,
  parseDataset,
  summarizeForTraining,
} from "../../../src/domain/dataset.ts";
import { CodeHash } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import { calibrationRowsToDataset } from "../../../src/domain/calibrationRows.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

const BYTECODE = "0x6001600055";

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: "0x0102030405060708090a0b0c0d0e0f1011121314",
    symbol: "SYN",
    name: "Synthetic",
    label: "legit",
    labelSource: "synthetic",
    block: 23100001,
    bytecode: BYTECODE,
    ...overrides,
  };
}

describe("s115 calibration basis weights", () => {
  test("documented defaults order curated rows above incident reports above listings", () => {
    expect(BASIS_WEIGHT_DEFAULTS).toEqual({ dataset: 3, "incident-report": 2, "token-list": 1 });
  });

  test("partial overrides fill from the defaults and bad weights fail", () => {
    expect(mustOk(parseBasisWeights({ dataset: 5 }))).toEqual({
      dataset: 5,
      "incident-report": 2,
      "token-list": 1,
    });
    expect(parseBasisWeights({ dataset: 0 }).ok).toBe(false);
    expect(parseBasisWeights({ dataset: 1.5 }).ok).toBe(false);
    expect(parseBasisWeights({ unknown: 1 }).ok).toBe(false);
  });

  test("expansion replicates rows by their basis weight in order", () => {
    const dataset = mustOk(
      parseDataset({
        dataVersion: "synthetic-basis-v1",
        labelPolicyVersion: "1.0.0",
        blockRange: { from: 23100001, to: 23100002 },
        datapoints: [
          {
            address: "0x0102030405060708090a0b0c0d0e0f1011121314",
            bytecode: BYTECODE,
            blockNumber: 23100001,
            source: "synthetic",
            label: { "rug-pull": "negative", honeypot: "negative", "bot-pump": "negative", rationale: "synthetic" },
          },
          {
            address: "0x0202030405060708090a0b0c0d0e0f1011121314",
            bytecode: BYTECODE,
            blockNumber: 23100002,
            source: "synthetic",
            label: { "rug-pull": "positive", honeypot: "negative", "bot-pump": "negative", rationale: "synthetic" },
            labelBasis: "token-list",
          },
        ],
      }),
    );
    const expanded = expandByBasisWeight(dataset.datapoints, undefined);
    expect(expanded.map((point) => (point.address as string).toLowerCase())).toEqual([
      "0x0102030405060708090a0b0c0d0e0f1011121314",
      "0x0102030405060708090a0b0c0d0e0f1011121314",
      "0x0102030405060708090a0b0c0d0e0f1011121314",
      "0x0202030405060708090a0b0c0d0e0f1011121314",
    ]);
  });
});

describe("s115 calibration rows converter", () => {
  test("label strings map to per-risk labels with rationale from the source", () => {
    const dataset = mustOk(
      calibrationRowsToDataset(
        [
          row({ address: "0x0102030405060708090a0b0c0d0e0f1011121314", label: "legit" }),
          row({ address: "0x0202030405060708090a0b0c0d0e0f1011121314", label: "rug", labelBasis: "incident-report" }),
          row({ address: "0x0302030405060708090a0b0c0d0e0f1011121314", label: "honeypot", labelBasis: "token-list" }),
          row({ address: "0x0402030405060708090a0b0c0d0e0f1011121314", label: "scam", labelNote: "synthetic exit scam" }),
        ],
        "calibration-test-v1",
      ),
    );
    expect(dataset.dataVersion).toBe("calibration-test-v1");
    expect(dataset.blockRange).toEqual({ from: 23100001, to: 23100001 });
    expect(dataset.datapoints.map((point) => point.label["rug-pull"])).toEqual([
      "negative",
      "positive",
      "negative",
      "positive",
    ]);
    expect(dataset.datapoints.map((point) => point.label["honeypot"])).toEqual([
      "negative",
      "negative",
      "positive",
      "negative",
    ]);
    expect(dataset.datapoints.map((point) => point.labelBasis ?? "dataset")).toEqual([
      "dataset",
      "incident-report",
      "token-list",
      "dataset",
    ]);
    expect(dataset.datapoints[3]?.label.rationale).toBe("synthetic exit scam");
    const codeHash = mustOk(CodeHash.of(dataset.datapoints[0]?.bytecode as never));
    expect(dataset.datapoints[0]?.codeHash as string).toBe(codeHash as string);
  });

  test("unknown labels and unknown bases fail with a typed error", () => {
    expect(calibrationRowsToDataset([row({ label: "moon" })], "calibration-test-v1").ok).toBe(false);
    expect(calibrationRowsToDataset([row({ labelBasis: "rumor" })], "calibration-test-v1").ok).toBe(false);
    expect(calibrationRowsToDataset([], "calibration-test-v1").ok).toBe(false);
  });

  test("committed fixture converts and expands with default weights", () => {
    const raw = JSON.parse(
      readFileSync(join(repoRoot, "tests", "fixtures", "calibration", "synthetic-calibration-rows-v1.json"), "utf8"),
    ) as unknown;
    const dataset = mustOk(calibrationRowsToDataset(raw, "calibration-fixture-v1"));
    expect(dataset.datapoints).toHaveLength(4);
    const expanded = expandByBasisWeight(dataset.datapoints, undefined);
    expect(expanded).toHaveLength(8);
    const outcomes = summarizeForTraining({ ...dataset, datapoints: expanded });
    expect(outcomes["rug-pull"]).toEqual({ positives: 4, negatives: 4 });
    expect(outcomes["honeypot"]).toEqual({ positives: 1, negatives: 7 });
    expect(outcomes["bot-pump"]).toEqual({ positives: 0, negatives: 8 });
    expect(dataset.labelPolicyVersion).toBe("0.1.0-provisional");
  });
});
