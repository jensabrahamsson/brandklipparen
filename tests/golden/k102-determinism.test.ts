// K-102 golden and cross-process determinism tests (S-003).
// Golden fixtures under tests/fixtures/golden carry synthetic made-up
// inputs only and frozen expected bytes; tests read them and never
// regenerate them. The child-process runner lives in tests/helpers.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createAppServices } from "../../src/application/analyzeToken.ts";
import type { Result } from "../../src/domain/result.ts";
import { parseModelArtifact } from "../../src/domain/risk.ts";
import { canonicalSerialize } from "../../src/domain/serialize.ts";
import type { CapabilityCatalogue } from "../../src/domain/signals.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  IndexVersion,
  ModelVersion,
  RequestId,
  TemplateVersion,
  Timestamp,
} from "../../src/domain/types.ts";
import type { LoadedArtifact } from "../../src/ports/modelArtifact.ts";
import { FakeClockAdapter } from "../fakes/fakeClock.ts";
import { FakeDecompilerAdapter } from "../fakes/fakeDecompiler.ts";
import type { DecompilerContractScenario } from "../contract/decompiler.contract.ts";
import { FakeModelArtifactAdapter } from "../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../fakes/fakeRpc.ts";
import { mustDefaultDetectorSet } from "../helpers/detectorSets.ts";
import {
  goldenDir,
  listGoldenInputs,
  readGoldenExpected,
  readGoldenInput,
} from "../helpers/k102-fixtures.ts";

const here = dirname(fileURLToPath(import.meta.url));
const runnerPath = join(here, "..", "helpers", "k102-run-canonical.ts");

// Process-spawning tests carry an explicit timeout well above the default
// 5000 ms: CI runners are slower (cold cache, shared CPU) and each fixture
// spawns two child processes here, so the total grows with the fixture
// count. 30 s matches the gate tests in tests/unit/ci-gate.test.ts and
// keeps the check green on slow runners without hiding a hung child.
const CHILD_PROCESS_TIMEOUT_MS = 30_000;

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function runCoreInChildProcess(inputName: string): Buffer {
  return execFileSync(
    process.execPath,
    ["--experimental-strip-types", runnerPath, join(goldenDir, inputName)],
    { encoding: "buffer", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 },
  );
}

describe("k102 deterministic core", () => {
  test("k102_decompiler_timeout_does_not_change_score", async () => {
    // A-07/K-102: wall-clock decompiler failures (timeout) must not change
    // probabilities or score. The timeout finding stays in pluginResults,
    // but the same bytecode analyses to byte-identical probabilities and
    // score as the successful decompilation.
    const artifact = mustOk(
      parseModelArtifact({
        version: "0.1.0",
        severityWeights: { low: 0.2, medium: 0.5, high: 1.0 },
        causeWeights: {
          timeout: 0.4,
          "resource-limit": 0.4,
          "decompiler-error": 0.6,
          "obfuscated-structure": 0.6,
        },
        biases: { "rug-pull": 0.0, honeypot: 0.0, "bot-pump": 0.0 },
        calibration: {
          "rug-pull": { slope: 1.0, intercept: 0.0 },
          honeypot: { slope: 1.0, intercept: 0.0 },
          "bot-pump": { slope: 1.0, intercept: 0.0 },
        },
        scoreWeights: { "rug-pull": 1.0, honeypot: 1.0, "bot-pump": 1.0 },
      }),
    );
    const loaded: LoadedArtifact = Object.freeze({
      artifact,
      checksum: mustOk(ArtifactChecksum.parse("ab".repeat(32))),
    });
    const catalogue: CapabilityCatalogue = Object.freeze({
      selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
      delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
      call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
      "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
    });
    const target = mustOk(Address.parse("0x0102030405060708090a0b0c0d0e0f1011121314"));
    const block = mustOk(BlockNumber.of(24000000));
    const bytecodeHex = "0x8063a9059cbb1461005b57ff";
    const analyseWith = async (scenario: DecompilerContractScenario) => {
      const services = createAppServices(
        {
          rpc: new FakeRpcAdapter(new Map([[target as string, bytecodeHex]]), block),
          modelArtifacts: new FakeModelArtifactAdapter(loaded),
          clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
          decompiler: new FakeDecompilerAdapter({ scenario }),
        },
        mustDefaultDetectorSet(),
      );
      return services.analyzeToken({
        address: target,
        block,
        requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
        deadline: mustOk(Timestamp.of(1700000005000)),
        modelVersion: mustOk(ModelVersion.parse("0.1.0")),
        indexVersion: mustOk(IndexVersion.parse("1.0.0")),
        templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
        catalogue,
      });
    };
    const timedOut = await analyseWith("timeout");
    const succeeded = await analyseWith("success");
    expect(timedOut.ok).toBe(true);
    expect(succeeded.ok).toBe(true);
    if (!timedOut.ok || timedOut.value.kind !== "assessed" || !succeeded.ok || succeeded.value.kind !== "assessed") {
      throw new Error("expected assessed envelopes for both decompiler outcomes");
    }
    expect(timedOut.value.envelope.probabilities).toEqual(succeeded.value.envelope.probabilities);
    expect(timedOut.value.envelope.score).toBe(succeeded.value.envelope.score);
  });

  test("k102_golden_fixtures_bit_identical", () => {
    const inputs = listGoldenInputs();
    expect(inputs.length).toBeGreaterThan(0);
    for (const name of inputs) {
      const actual = Buffer.from(canonicalSerialize(readGoldenInput(name)), "utf8");
      expect(actual.equals(readGoldenExpected(name)), `fixture ${name} differs`).toBe(true);
    }
  });

  test("k102_two_runs_across_processes_bit_identical", () => {
    const inputs = listGoldenInputs();
    expect(inputs.length).toBeGreaterThan(0);
    for (const name of inputs) {
      const first = runCoreInChildProcess(name);
      const second = runCoreInChildProcess(name);
      expect(first.equals(second), `fixture ${name} differs across processes`).toBe(true);
      expect(first.equals(readGoldenExpected(name)), `fixture ${name} differs`).toBe(true);
    }
  }, CHILD_PROCESS_TIMEOUT_MS);
});
