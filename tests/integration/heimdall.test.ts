// Deepening through the extdecomp worker adapter (S-011, K-008, K-501).
// A decompilation failure yields the hard-to-analyze signal with evidence
// while scoring still runs on the frozen placeholder artifact; a
// pathological worker run stays isolated to its own analysis.
// Process-spawning tests carry an explicit timeout well above the default
// 5000 ms: CI runners are slower (cold cache, shared CPU) and process
// startup alone can take seconds there. 30 s keeps the suite green on slow
// runners without hiding a hung child process (the adapter's own shorter
// timeout still bounds every run).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { extdecompAdapter } from "../../src/adapters/extdecomp/extdecompAdapter.ts";
import { createAppServices } from "../../src/application/analyzeToken.ts";
import type { Result } from "../../src/domain/result.ts";
import { parseModelArtifact } from "../../src/domain/risk.ts";
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
import type { CapabilityCatalogue, Signal } from "../../src/domain/signals.ts";
import type { LoadedArtifact } from "../../src/ports/modelArtifact.ts";
import { FakeClockAdapter } from "../fakes/fakeClock.ts";
import { FakeDecompilerAdapter } from "../fakes/fakeDecompiler.ts";
import { FakeModelArtifactAdapter } from "../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../fakes/fakeRpc.ts";
import { mustDefaultDetectorSet } from "../helpers/detectorSets.ts";

const PROCESS_TIMEOUT_MS = 30000;

const workerPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "extdecomp",
  "fake-worker.mjs",
);

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

// Frozen placeholder artifact for tests only: small synthetic numbers with
// no predictive meaning. Production values arrive through the versioned
// model artifact per K-210; the deepening only reads the frozen value.
function placeholderLoadedArtifact(): LoadedArtifact {
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
  return Object.freeze({
    artifact,
    checksum: mustOk(ArtifactChecksum.parse("ab".repeat(32))),
  });
}

// Placeholder catalogue for tests only: the risk, direction and severity
// mapping steers scoring, so production passes the versioned artifact
// mapping per K-210 and A-20.
const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

const TARGET = "0x0a0b0c0d0e0f1011121314151617181920212223";
const DISPATCHER_BYTECODE = "0x8063a9059cbb1461005b57ff";

function hardToAnalyzeSignals(signals: readonly Signal[]): Extract<Signal, { kind: "hard-to-analyze" }>[] {
  return signals.filter((signal): signal is Extract<Signal, { kind: "hard-to-analyze" }> => signal.kind === "hard-to-analyze");
}

describe("extdecomp deepening in the application service (K-008, K-501)", () => {
  test(
    "k008_timeout_skips_hard_to_analyze_signal_and_reports_in_plugin_results",
    async () => {
      const target = mustOk(Address.parse(TARGET));
      const block = mustOk(BlockNumber.of(24000000));
      const services = createAppServices({
        rpc: new FakeRpcAdapter(new Map([[target as string, DISPATCHER_BYTECODE]]), block),
        modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact()),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
        decompiler: new extdecompAdapter({
          binaryPath: process.execPath,
          binaryArgs: [workerPath, "--mode=hang"],
          timeoutMs: 1000,
          maxOutputBytes: 65536,
          maxMemoryMb: 512,
        }),
      },
  mustDefaultDetectorSet());
      // A decompilation timeout is a domain outcome, not an analysis
      // failure: the call resolves to an assessed envelope. The wall-clock
      // cause never reaches the score (A-07, K-102): no hard-to-analyze
      // signal is emitted, while the finding stays in pluginResults.
      const analysed = await services.analyzeToken({
        address: target,
        block,
        requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
        deadline: mustOk(Timestamp.of(4102444800000)),
        modelVersion: mustOk(ModelVersion.parse("0.1.0")),
        indexVersion: mustOk(IndexVersion.parse("1.0.0")),
        templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
        catalogue: TEST_CATALOGUE,
      });
      expect(analysed.ok).toBe(true);
      if (!analysed.ok || analysed.value.kind !== "assessed") {
        throw new Error("expected an assessed envelope after a decompilation timeout");
      }
      const envelope = analysed.value.envelope;
      expect(hardToAnalyzeSignals(envelope.signals)).toEqual([]);
      const hardEntry = envelope.pluginResults.find(
        (entry) => entry.pluginId === "dev.brandklipparen.hard-to-analyze",
      );
      expect(hardEntry?.outcome).toBe("ok");
      expect(
        hardEntry?.findings.map((finding) => (finding.payload as { cause?: unknown }).cause),
      ).toEqual(["timeout"]);
      // Scoring still runs on the frozen artifact: probabilities and an
      // integer score travel with the standing fast-path response.
      expect(envelope.probabilities["rug-pull"] as number).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(envelope.score as number)).toBe(true);
    },
    PROCESS_TIMEOUT_MS,
  );

  test(
    "k501_pathological_input_isolates_to_its_analysis",
    async () => {
      const target = mustOk(Address.parse(TARGET));
      const block = mustOk(BlockNumber.of(24000000));
      const codes = new Map([[target as string, DISPATCHER_BYTECODE]]);
      const hanging = new extdecompAdapter({
        binaryPath: process.execPath,
        binaryArgs: [workerPath, "--mode=hang"],
        timeoutMs: 1000,
        maxOutputBytes: 65536,
        maxMemoryMb: 512,
      });
      const working = new extdecompAdapter({
        binaryPath: process.execPath,
        binaryArgs: [workerPath, "--mode=success"],
        timeoutMs: 15000,
        maxOutputBytes: 65536,
        maxMemoryMb: 512,
      });
      const crashing = new extdecompAdapter({
        binaryPath: process.execPath,
        binaryArgs: [workerPath, "--mode=crash"],
        timeoutMs: 15000,
        maxOutputBytes: 65536,
        maxMemoryMb: 512,
      });
      const input = {
        address: target,
        block,
        requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
        deadline: mustOk(Timestamp.of(4102444800000)),
        modelVersion: mustOk(ModelVersion.parse("0.1.0")),
        indexVersion: mustOk(IndexVersion.parse("1.0.0")),
        templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
        catalogue: TEST_CATALOGUE,
      } as const;
      const hangingServices = createAppServices({
        rpc: new FakeRpcAdapter(codes, block),
        modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact()),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
        decompiler: hanging,
      },
  mustDefaultDetectorSet());
      const workingServices = createAppServices({
        rpc: new FakeRpcAdapter(codes, block),
        modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact()),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
        decompiler: working,
      },
  mustDefaultDetectorSet());
      const crashingServices = createAppServices({
        rpc: new FakeRpcAdapter(codes, block),
        modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact()),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
        decompiler: crashing,
      },
  mustDefaultDetectorSet());
      // The hanging run and the healthy run overlap: each worker is its
      // own process, so the hang stays inside its own analysis.
      const [hangingResult, workingResult] = await Promise.all([
        hangingServices.analyzeToken({ ...input }),
        workingServices.analyzeToken({ ...input }),
      ]);
      expect(hangingResult.ok && hangingResult.value.kind === "assessed").toBe(true);
      expect(workingResult.ok && workingResult.value.kind === "assessed").toBe(true);
      if (
        !hangingResult.ok ||
        hangingResult.value.kind !== "assessed" ||
        !workingResult.ok ||
        workingResult.value.kind !== "assessed"
      ) {
        throw new Error("expected both parallel analyses to resolve");
      }
      // The hanging run emits no wall-clock signal (A-07, K-102): the
      // timeout finding stays in pluginResults only.
      expect(hardToAnalyzeSignals(hangingResult.value.envelope.signals)).toEqual([]);
      const hangingEntry = hangingResult.value.envelope.pluginResults.find(
        (entry) => entry.pluginId === "dev.brandklipparen.hard-to-analyze",
      );
      expect(
        hangingEntry?.findings.map((finding) => (finding.payload as { cause?: unknown }).cause),
      ).toEqual(["timeout"]);
      expect(hardToAnalyzeSignals(workingResult.value.envelope.signals)).toEqual([]);
      // A crashing worker degrades the same way, and a following analysis
      // with a healthy worker still deepens normally.
      const crashingResult = await crashingServices.analyzeToken({ ...input });
      expect(crashingResult.ok && crashingResult.value.kind === "assessed").toBe(true);
      if (!crashingResult.ok || crashingResult.value.kind !== "assessed") {
        throw new Error("expected the crashing analysis to resolve");
      }
      expect(
        hardToAnalyzeSignals(crashingResult.value.envelope.signals).map((signal) => signal.cause),
      ).toEqual(["decompiler-error"]);
      const followingResult = await workingServices.analyzeToken({ ...input });
      expect(followingResult.ok && followingResult.value.kind === "assessed").toBe(true);
      if (!followingResult.ok || followingResult.value.kind !== "assessed") {
        throw new Error("expected the following analysis to resolve");
      }
      expect(hardToAnalyzeSignals(followingResult.value.envelope.signals)).toEqual([]);
      const snippets = followingResult.value.envelope.signals.flatMap((signal) =>
        signal.evidence.map((entry) => entry.snippet?.text ?? ""),
      );
      expect(snippets.some((text) => text.length > 0)).toBe(true);
    },
    PROCESS_TIMEOUT_MS,
  );

  test(
    "k008_fake_timeout_skips_signal_without_spawn",
    async () => {
      const target = mustOk(Address.parse(TARGET));
      const block = mustOk(BlockNumber.of(24000000));
      const fake = new FakeDecompilerAdapter({ scenario: "timeout" });
      const services = createAppServices({
        rpc: new FakeRpcAdapter(new Map([[target as string, DISPATCHER_BYTECODE]]), block),
        modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact()),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
        decompiler: fake,
      },
  mustDefaultDetectorSet());
      const analysed = await services.analyzeToken({
        address: target,
        block,
        requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
        deadline: mustOk(Timestamp.of(4102444800000)),
        modelVersion: mustOk(ModelVersion.parse("0.1.0")),
        indexVersion: mustOk(IndexVersion.parse("1.0.0")),
        templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
        catalogue: TEST_CATALOGUE,
      });
      expect(analysed.ok).toBe(true);
      if (!analysed.ok || analysed.value.kind !== "assessed") {
        throw new Error("expected an assessed envelope after a fake decompilation timeout");
      }
      expect(hardToAnalyzeSignals(analysed.value.envelope.signals)).toEqual([]);
      const hardEntry = analysed.value.envelope.pluginResults.find(
        (entry) => entry.pluginId === "dev.brandklipparen.hard-to-analyze",
      );
      expect(
        hardEntry?.findings.map((finding) => (finding.payload as { cause?: unknown }).cause),
      ).toEqual(["timeout"]);
      expect(fake.callCount).toBe(1);
    },
    PROCESS_TIMEOUT_MS,
  );
});
