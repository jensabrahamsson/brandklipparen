// Coverage truth at the envelope boundary (C-26, F-26): a padded key
// keeps 128 capped evidence instead of failing the plugin, a throwing
// or over-limit scored plugin contributes exactly one
// obfuscated-structure signal, and a wall-clock plugin outcome is
// transient and never cached. Synthetic bytecode only; no network.
import { describe, expect, test } from "vitest";
import { createAppServices } from "../../src/application/analyzeToken.ts";
import type { DetectorSet } from "../../src/application/analyzeToken.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  Bytecode,
  CodeHash,
  IndexVersion,
  ModelVersion,
  RequestId,
  Selector,
  TemplateVersion,
  Timestamp,
} from "../../src/domain/types.ts";
import type { Result } from "../../src/domain/result.ts";
import { Evidence } from "../../src/domain/evidence.ts";
import { parseModelArtifact } from "../../src/domain/risk.ts";
import type { LoadedArtifact } from "../../src/ports/modelArtifact.ts";
import { detectCapabilities } from "../../src/domain/signals.ts";
import type { CapabilityCatalogue } from "../../src/domain/signals.ts";
import { PLUGIN_API_VERSION, PluginManifest } from "../../src/plugins/api.ts";
import type { DetectorManifest } from "../../src/plugins/api.ts";
import {
  createDetectorInput,
  runDetectorPlugin,
} from "../../src/plugins/detector.ts";
import type {
  DetectorExecution,
  DetectorPlugin,
  PluginFinding,
  WorkerDetectorRun,
} from "../../src/plugins/detector.ts";
import {
  buildPluginRegistry,
  DEFAULT_DETECTOR_PLUGINS,
} from "../../src/plugins/registry.ts";
import { capabilityDetectorPlugin } from "../../src/plugins/detectors/capability/index.ts";
import { tokenBytecode } from "../helpers/ownerControlFixtures.ts";
import { FakeCacheAdapter } from "../fakes/fakeCache.ts";
import { FakeClockAdapter } from "../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../fakes/fakeRpc.ts";
import { mustDefaultDetectorSet } from "../helpers/detectorSets.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

const TARGET_RAW = "0x0102030405060708090a0b0c0d0e0f1011121314";
const TARGET = mustOk(Address.parse(TARGET_RAW)) as string;
const BLOCK = 24000000;
const FIRST_SELECTOR = "0xa9059cbb";
// One dispatcher window with a SELFDESTRUCT body: the entry selector is
// the first dispatcher selector.
const SMALL_BYTECODE = "0x8063a9059cbb14600a575bff00";

function placeholderLoadedArtifact(
  version: string,
  pluginWeights: Record<string, number> = {},
): LoadedArtifact {
  const artifact = mustOk(
    parseModelArtifact({
      version,
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
      pluginWeights,
    }),
  );
  return Object.freeze({
    artifact,
    checksum: mustOk(ArtifactChecksum.parse("ab".repeat(32))),
  });
}

function probeManifest(id: string): DetectorManifest {
  const parsed = PluginManifest.parse({
    id,
    version: "1.0.0",
    kind: "detector",
    apiVersion: PLUGIN_API_VERSION,
    displayName: "C-26 coverage probe",
    description: "Synthetic probe for coverage truth.",
    inputs: ["bytecode"],
    docs: "PLUGIN.md",
    outputSchema: Object.freeze({ type: "array" }),
    capabilities: Object.freeze({}),
    limits: Object.freeze({ maxFindings: 8, maxEvidencePerFinding: 128, maxOutputBytes: 32768 }),
  });
  if (!parsed.ok) {
    throw new Error(`probe manifest failed to parse: ${parsed.error.kind}`);
  }
  if (parsed.value.kind !== "detector") {
    throw new Error("probe manifest carries the wrong kind");
  }
  return parsed.value;
}

function analyzeInput(version: string) {
  return {
    address: mustOk(Address.parse(TARGET_RAW)),
    block: mustOk(BlockNumber.of(BLOCK)),
    requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(1700000005000)),
    modelVersion: mustOk(ModelVersion.parse(version)),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
  };
}

function paddedBytecode(): { code: string; selector: string } {
  const body: number[] = [];
  for (let index = 0; index < 200; index += 1) {
    body.push(0x60, 0x00, 0x60, 0x00, 0x55);
  }
  body.push(0xf4, 0x00);
  const bytecode = tokenBytecode([{ selector: "0x12345678", body }]);
  return {
    code: `0x${Buffer.from(bytecode).toString("hex")}`,
    selector: "0x12345678",
  };
}

describe("coverage truth at the envelope (C-26)", () => {
  test("c26_capability_padding_over_128_sites_still_reports", async () => {
    const padded = paddedBytecode();
    const bytecode = mustOk(Bytecode.parse(padded.code));
    const codeHash = mustOk(CodeHash.of(bytecode));
    const input = createDetectorInput(bytecode, codeHash);
    // Plugin level: ok with the storage-write evidence capped at 128,
    // instead of the whole plugin rejected as invalid-output.
    const boundary = runDetectorPlugin(capabilityDetectorPlugin, input);
    expect(boundary.outcome).toBe("ok");
    const stored = capabilityDetectorPlugin.detect(input).find(
      (finding) => (finding.payload as { capability?: string })["capability"] === "storage-write",
    );
    expect(stored?.evidence.length).toBe(128);
    // Domain parity: the legacy sweep caps the same key the same way.
    const swept = detectCapabilities(bytecode, codeHash, TEST_CATALOGUE, {
      kind: "can-change-unknown",
    });
    const sweptStored = swept.find(
      (signal) => signal.kind === "capability" && signal.evidence.length === 128,
    );
    expect(sweptStored).toBeDefined();
    const sweptDelegatecall = swept.find(
      (signal) => signal.kind === "capability" && signal.evidence.length === 1,
    );
    expect(sweptDelegatecall).toBeDefined();
    // Envelope level: the plugin is ok and both the padded key and the
    // lone DELEGATECALL convert to signals.
    const block = mustOk(BlockNumber.of(BLOCK));
    const services = createAppServices(
      {
        rpc: new FakeRpcAdapter(new Map([[TARGET, padded.code]]), block),
        modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact("0.1.0")),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      },
      mustDefaultDetectorSet(),
    );
    const analysed = await services.analyzeToken(analyzeInput("0.1.0"));
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    const envelope = analysed.value.envelope;
    const entry = envelope.pluginResults.find(
      (candidate) => candidate.pluginId === "dev.brandklipparen.capability",
    );
    expect(entry?.outcome).toBe("ok");
    const envelopeStored = entry?.findings.find(
      (finding) => (finding.payload as { capability?: string })["capability"] === "storage-write",
    );
    expect(envelopeStored?.evidence.length).toBe(128);
    const delegatecall = envelope.signals.find(
      (signal) => signal.kind === "capability" && signal.evidence.length === 1,
    );
    expect(delegatecall).toBeDefined();
    expect(delegatecall?.evidence[0]?.selector as string).toBe(padded.selector);
  });

  test("c26_throwing_scored_plugin_yields_hard_to_analyze", async () => {
    const throwId = "dev.brandklipparen.c26-throw-probe";
    const malformedId = "dev.brandklipparen.c26-malformed-probe";
    const throwing: DetectorPlugin = Object.freeze({
      manifest: probeManifest(throwId),
      detect: (): readonly PluginFinding[] => {
        throw new Error("c26 probe throw");
      },
    });
    const malformedManifest = probeManifest(malformedId);
    const malformed: DetectorPlugin = Object.freeze({
      manifest: malformedManifest,
      detect: (): readonly PluginFinding[] => {
        const evidence = Evidence.create({
          selector: mustOk(Selector.parse(FIRST_SELECTOR)),
        });
        if (!evidence.ok) {
          throw new Error("probe evidence failed to build");
        }
        return Object.freeze([
          Object.freeze({
            id: "bogus",
            pluginId: malformedManifest.id,
            title: "C-26 malformed probe",
            evidence: Object.freeze([evidence.value]) as unknown as PluginFinding["evidence"],
            payload: Object.freeze({}),
          }),
        ]);
      },
    });
    const registry = mustOk(buildPluginRegistry([...DEFAULT_DETECTOR_PLUGINS, throwing, malformed]));
    const detectors: DetectorSet = Object.freeze({ registry });
    const block = mustOk(BlockNumber.of(BLOCK));
    const services = createAppServices(
      {
        rpc: new FakeRpcAdapter(new Map([[TARGET, SMALL_BYTECODE]]), block),
        modelArtifacts: new FakeModelArtifactAdapter(
          placeholderLoadedArtifact("0.1.0", { [throwId]: 1, [malformedId]: 1 }),
        ),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      },
      detectors,
    );
    const analysed = await services.analyzeToken(analyzeInput("0.1.0"));
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    const envelope = analysed.value.envelope;
    expect(
      envelope.pluginResults.find((candidate) => candidate.pluginId === throwId)?.outcome,
    ).toBe("threw");
    expect(
      envelope.pluginResults.find((candidate) => candidate.pluginId === malformedId)?.outcome,
    ).toBe("invalid-output");
    // Two failed scored plugins still contribute exactly one
    // deterministic signal, keyed on the first dispatcher selector.
    const failed = envelope.signals.filter(
      (signal) => signal.kind === "hard-to-analyze" && signal.cause === "obfuscated-structure",
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.evidence[0]?.selector as string).toBe(FIRST_SELECTOR);
  });

  test("c26_timeout_plugin_transient", async () => {
    const timeoutId = "dev.brandklipparen.c26-timeout-probe";
    const timeoutPlugin: DetectorPlugin = Object.freeze({
      manifest: probeManifest(timeoutId),
      detect: (): readonly PluginFinding[] => Object.freeze([]),
      modulePath: "c26-timeout-probe",
    });
    const registry = mustOk(buildPluginRegistry([...DEFAULT_DETECTOR_PLUGINS, timeoutPlugin]));
    const execution: DetectorExecution = Object.freeze({
      runInWorker: async (): Promise<WorkerDetectorRun> => ({ kind: "timeout" }),
    });
    const block = mustOk(BlockNumber.of(BLOCK));
    const cache = new FakeCacheAdapter();
    const services = createAppServices(
      {
        rpc: new FakeRpcAdapter(new Map([[TARGET, SMALL_BYTECODE]]), block),
        modelArtifacts: new FakeModelArtifactAdapter(
          placeholderLoadedArtifact("0.1.0", { [timeoutId]: 1 }),
        ),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
        cache,
      },
      Object.freeze({ registry, execution }),
    );
    const analysed = await services.analyzeToken(analyzeInput("0.1.0"));
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    const envelope = analysed.value.envelope;
    expect(
      envelope.pluginResults.find((candidate) => candidate.pluginId === timeoutId)?.outcome,
    ).toBe("timeout");
    // A wall-clock outcome never scores, even for an allowlisted plugin.
    expect(envelope.signals.filter((signal) => signal.kind === "hard-to-analyze")).toEqual([]);
    // And the run never enters the shared cache entry.
    expect(cache.putCalls).toBe(0);
    // Control: the same code without the failing plugin stores once.
    const controlCache = new FakeCacheAdapter();
    const control = createAppServices(
      {
        rpc: new FakeRpcAdapter(new Map([[TARGET, SMALL_BYTECODE]]), block),
        modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact("0.1.0")),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
        cache: controlCache,
      },
      mustDefaultDetectorSet(),
    );
    const controlAnalysed = await control.analyzeToken(analyzeInput("0.1.0"));
    expect(controlAnalysed.ok).toBe(true);
    expect(controlCache.putCalls).toBe(1);
  });
});
