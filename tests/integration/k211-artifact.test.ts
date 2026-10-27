// Frozen calibration artifact: retraining bit-identity and tamper
// rejection (K-211, S-019). Written first (red) per A-21; the implementation
// lives in src/domain/artifact.ts (pure freeze) and
// src/adapters/model/fileArtifact.ts (file loading with checksum
// verification). The dataset is the small synthetic placeholder under
// tests/fixtures/artifact with no predictive meaning.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createAppServices } from "../../src/application/analyzeToken.ts";
import type { CapabilityCatalogue } from "../../src/domain/signals.ts";
import { freezeArtifactFile, trainArtifact, verifyArtifactFile } from "../../src/domain/artifact.ts";
import type { Result } from "../../src/domain/result.ts";
import {
  Address,
  BlockNumber,
  IndexVersion,
  ModelVersion,
  RequestId,
  TemplateVersion,
  Timestamp,
} from "../../src/domain/types.ts";
import { FileModelArtifactAdapter } from "../../src/adapters/model/fileArtifact.ts";
import { FakeClockAdapter } from "../fakes/fakeClock.ts";
import { FakeRpcAdapter } from "../fakes/fakeRpc.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const datasetPath = join(repoRoot, "tests", "fixtures", "artifact", "synthetic-dataset-v1.json");
const modelDir = join(repoRoot, "model");
const frozenFile = join(modelDir, "artifact-0.0.0-synthetic.1.json");
const runnerPath = join(here, "..", "helpers", "k211-run-freeze.ts");
const MODEL_VERSION = "0.0.0-synthetic.1";

// Process-spawning tests carry an explicit timeout well above the default
// 5000 ms: CI runners are slower (cold cache, shared CPU) and each child
// process pays the type-stripping startup cost. 30 s matches the k102
// cross-process test and the gate tests in tests/unit/ci-gate.test.ts and
// keeps the check green on slow runners without hiding a hung child.
const CHILD_PROCESS_TIMEOUT_MS = 30_000;

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function mustVersion(): ModelVersion {
  return mustOk(ModelVersion.parse(MODEL_VERSION));
}

function freezeInProcess(datasetJson: string): string {
  const trained = trainArtifact(JSON.parse(datasetJson) as unknown, mustVersion());
  if (!trained.ok) {
    throw new Error(`training failed: ${trained.error.message}`);
  }
  const frozen = freezeArtifactFile(trained.value);
  if (!frozen.ok) {
    throw new Error(`freeze failed: ${frozen.error.message}`);
  }
  return frozen.value;
}

function freezeInChildProcess(): Buffer {
  return execFileSync(process.execPath, ["--experimental-strip-types", runnerPath, datasetPath, MODEL_VERSION], {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

describe("frozen calibration artifact (K-211)", () => {
  test("k211_retraining_reproduces_artifact_bit_identical", () => {
    const datasetJson = readFileSync(datasetPath, "utf8");
    const dataset = JSON.parse(datasetJson) as Record<string, unknown>;

    // Retraining twice in this process from the same dataset and version
    // gives byte-identical output including checksum, even when the input
    // object key order differs (canonical serialization, A-32 point 5).
    const first = freezeInProcess(datasetJson);
    const shuffled = JSON.stringify({
      riskShares: dataset["riskShares"],
      seed: dataset["seed"],
      riskOutcomes: dataset["riskOutcomes"],
      dataVersion: dataset["dataVersion"],
      causeCounts: dataset["causeCounts"],
      severityCounts: dataset["severityCounts"],
    });
    expect(freezeInProcess(shuffled)).toBe(first);

    // The same freeze in two separate processes gives byte-identical
    // output: no clock, randomness, environment or platform float order
    // steers the training (H-13, M-19).
    const childFirst = freezeInChildProcess();
    const childSecond = freezeInChildProcess();
    expect(childSecond.equals(childFirst)).toBe(true);
    expect(childFirst.toString("utf8")).toBe(first);

    // The committed frozen artifact reproduces from the dataset: changing
    // the dataset or the seed requires deliberately regenerating the file
    // with the freeze command, so silent drift turns this test red.
    const committed = readFileSync(frozenFile, "utf8");
    expect(committed).toBe(first);

    // The artifact logs its locked seed and data version (M-19): the
    // logged values match the versioned seed configuration in the dataset.
    const verified = mustOk(verifyArtifactFile(JSON.parse(committed) as unknown));
    expect(verified.dataVersion).toBe(dataset["dataVersion"]);
    expect(verified.seed).toBe(dataset["seed"]);
    expect(verified.artifact.version as string).toBe(MODEL_VERSION);
  }, CHILD_PROCESS_TIMEOUT_MS);

  test("k211_wrong_checksum_rejected_before_analysis", async () => {
    const committed = readFileSync(frozenFile, "utf8");
    const tampered = committed.replace("0.25", "0.26");
    expect(tampered).not.toBe(committed);

    // A changed byte fails verification with the typed checksum-mismatch
    // branch before any analysis runs (H-11, M-17).
    const verified = verifyArtifactFile(JSON.parse(tampered) as unknown);
    expect(verified.ok).toBe(false);
    if (verified.ok) {
      throw new Error("expected a checksum mismatch");
    }
    expect(verified.error.kind).toBe("checksum-mismatch");

    // The same tampered file on disk loads through the port with the typed
    // checksum-mismatch branch, and scoring refuses to run: the service
    // answers a model-artifact error before the risk function ever runs,
    // while the same setup with the intact file assesses normally.
    const scratch = mkdtempSync(join(tmpdir(), "brandklipparen-artifact-"));
    writeFileSync(join(scratch, `artifact-${MODEL_VERSION}.json`), tampered, "utf8");
    const tamperedAdapter = new FileModelArtifactAdapter(scratch);
    const loaded = tamperedAdapter.load(mustVersion());
    expect(loaded.ok).toBe(false);
    if (loaded.ok) {
      throw new Error("expected a checksum mismatch from the file adapter");
    }
    expect(loaded.error.kind).toBe("checksum-mismatch");

    const codes = new Map<string, string>([
      [mustOk(Address.parse("0x0102030405060708090a0b0c0d0e0f1011121314")) as string, "0x600160005506"],
    ]);
    const block = mustOk(BlockNumber.of(24000000));
    const refused = createAppServices({
      rpc: new FakeRpcAdapter(codes, block),
      modelArtifacts: tamperedAdapter,
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    });
    const denied = await refused.analyzeToken({
      address: mustOk(Address.parse("0x0102030405060708090a0b0c0d0e0f1011121314")),
      block,
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustVersion(),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    });
    if (denied.ok) {
      throw new Error("expected scoring to refuse the tampered artifact");
    }
    expect(denied.error.kind).toBe("model-artifact-error");
    if (denied.error.kind !== "model-artifact-error") {
      throw new Error("expected a model artifact error");
    }
    expect(denied.error.error.kind).toBe("checksum-mismatch");

    // Control: the intact frozen file verifies, and scoring runs on the
    // verified artifact with the frozen version and checksum in the
    // envelope (K-102 reproduction fields).
    const intactDir = mkdtempSync(join(tmpdir(), "brandklipparen-artifact-"));
    writeFileSync(join(intactDir, `artifact-${MODEL_VERSION}.json`), committed, "utf8");
    const intactAdapter = new FileModelArtifactAdapter(intactDir);
    const intact = intactAdapter.load(mustVersion());
    if (!intact.ok) {
      throw new Error(`expected the intact artifact to verify: ${intact.error.message}`);
    }
    const allowed = createAppServices({
      rpc: new FakeRpcAdapter(codes, block),
      modelArtifacts: intactAdapter,
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    });
    const assessed = await allowed.analyzeToken({
      address: mustOk(Address.parse("0x0102030405060708090a0b0c0d0e0f1011121314")),
      block,
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustVersion(),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    });
    if (!assessed.ok || assessed.value.kind !== "assessed") {
      throw new Error("expected the intact artifact to score");
    }
    expect(assessed.value.envelope.modelVersion as string).toBe(MODEL_VERSION);
    expect(assessed.value.envelope.artifactChecksum as string).toBe(intact.value.checksum as string);
  });
});
