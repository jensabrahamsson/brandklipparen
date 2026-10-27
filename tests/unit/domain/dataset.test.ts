// Fresh public on-chain dataset with label policy (K-201, K-202, S-017).
// Written first (red) per A-21; the implementation lives in
// src/domain/dataset.ts and the committed fixture in
// offline/data/dataset-synthetic-v1.json. The fixture is a small synthetic
// placeholder documented as such; production rows arrive through the
// versioned offline calibration chain per A-28 and K-210.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  parseDataset,
  spotCheckDataset,
  summarizeForTraining,
} from "../../../src/domain/dataset.ts";
import type { Result } from "../../../src/domain/result.ts";
import { Address, BlockNumber, Bytecode, CodeHash } from "../../../src/domain/types.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const datasetPath = join(repoRoot, "offline", "data", "dataset-synthetic-v1.json");

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function rawDatapoints(raw: unknown): ReadonlyArray<Record<string, unknown>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("dataset fixture must be a JSON object");
  }
  const points = (raw as Record<string, unknown>)["datapoints"];
  if (!Array.isArray(points)) {
    throw new Error("dataset fixture must carry a datapoints array");
  }
  return points as ReadonlyArray<Record<string, unknown>>;
}

describe("fresh dataset with label policy (K-201, K-202)", () => {
  test("k201_each_datapoint_has_address_bytecode_block_source", () => {
    const raw = JSON.parse(readFileSync(datasetPath, "utf8")) as unknown;
    const points = rawDatapoints(raw);
    expect(points.length).toBeGreaterThan(0);
    // Every raw row carries the four K-201 fields before parsing.
    for (const point of points) {
      expect(typeof point["address"]).toBe("string");
      expect(typeof point["bytecode"]).toBe("string");
      expect(typeof point["blockNumber"]).toBe("number");
      expect(typeof point["source"]).toBe("string");
    }
    const dataset = mustOk(parseDataset(raw));
    // Parsing keeps every row: the committed fixture is fully valid.
    expect(dataset.datapoints.length).toBe(points.length);
    for (const point of dataset.datapoints) {
      // Each field round-trips through its smart constructor, so validity
      // travels in the type after the boundary (A-11).
      expect(mustOk(Address.parse(point.address as string))).toBe(point.address);
      expect(mustOk(BlockNumber.of(point.blockNumber as number))).toBe(point.blockNumber);
      // The parsed bytes re-encode to hex that re-parses to equal bytes.
      const hex = `0x${Array.from(point.bytecode as Uint8Array, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      expect(mustOk(Bytecode.parse(hex)).length).toBe((point.bytecode as Uint8Array).length);
      expect(point.source.length).toBeGreaterThan(0);
      // The code hash is derived from the bytecode, never hand-assigned.
      expect(point.codeHash).toBe(mustOk(CodeHash.of(mustOk(Bytecode.parse(hex)))) as string);
    }
    // The fixture is the training input shape for S-019: label counts roll
    // up to the risk-outcome counts the freeze path consumes.
    const outcomes = summarizeForTraining(dataset);
    const positives =
      outcomes["rug-pull"].positives + outcomes["honeypot"].positives + outcomes["bot-pump"].positives;
    const negatives =
      outcomes["rug-pull"].negatives + outcomes["honeypot"].negatives + outcomes["bot-pump"].negatives;
    expect(positives).toBeGreaterThan(0);
    expect(negatives).toBeGreaterThan(0);
    expect(positives + negatives).toBe(points.length * 3);
  });

  test("k202_label_quality_spot_check_versioned", () => {
    const dataset = mustOk(parseDataset(JSON.parse(readFileSync(datasetPath, "utf8")) as unknown));
    const checked = spotCheckDataset(dataset, dataset.datapoints.length);
    // The spot-check result is versioned with the data version and the
    // label policy version it was checked under (K-202).
    expect(checked.dataVersion).toBe(dataset.dataVersion);
    expect(checked.labelPolicyVersion).toBe(dataset.labelPolicyVersion);
    expect(checked.checked).toBe(dataset.datapoints.length);
    // The committed synthetic fixture is fully policy-clean.
    expect(checked.issues).toBe(0);
    expect(checked.passPercent).toBe(100);
    // The check detects a broken row: a missing rationale is one issue, and
    // the versioned fields still travel with the failing result.
    const broken = {
      ...dataset,
      datapoints: dataset.datapoints.map((point, index) =>
        index === 0 ? { ...point, label: { ...point.label, rationale: "" } } : point,
      ),
    };
    const failing = spotCheckDataset(broken, broken.datapoints.length);
    expect(failing.issues).toBeGreaterThan(0);
    expect(failing.passPercent).toBeLessThan(100);
    expect(failing.dataVersion).toBe(dataset.dataVersion);
    expect(failing.labelPolicyVersion).toBe(dataset.labelPolicyVersion);
  });
});
