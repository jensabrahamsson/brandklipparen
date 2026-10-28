// Tests for S-044 (K-029 proposed, K-017, K-008): clone-match and
// hard-to-analyze detector plugins `dev.brandklipparen.clone-match` and
// `dev.brandklipparen.hard-to-analyze`. Written first (red) per A-21: the
// plugin modules do not exist yet, so the imports fail until the
// implementation lands. The shared detector contract proves determinism,
// schema agreement, evidence presence and unchanged inputs; the tests below
// prove registry membership and the service wiring that replaces the direct
// `cloneMatchSignal` call and the inline fallback-signal construction in
// analyzeToken. Scores, probabilities and signal content stay identical to
// the legacy path; `pluginResults` only gains the two new additive entries.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { FileModelArtifactAdapter } from "../../../src/adapters/model/fileArtifact.ts";
import { CloneIndexAdapter } from "../../../src/adapters/clones/cloneIndex.ts";
import { createAppServices } from "../../../src/application/analyzeToken.ts";
import type { CloneHit } from "../../../src/domain/clones.ts";
import {
  Address,
  BlockNumber,
  Bytecode,
  CloneGroupId,
  CodeHash,
  IndexVersion,
  ModelVersion,
  Probability,
  RequestId,
  TemplateVersion,
  Timestamp,
} from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import type { CapabilityCatalogue, Signal } from "../../../src/domain/signals.ts";
import type { CloneMapping } from "../../../src/domain/clones.ts";
import { cloneMatchDetectorPlugin } from "../../../src/plugins/detectors/clone-match/index.ts";
import { hardToAnalyzeDetectorPlugin } from "../../../src/plugins/detectors/hard-to-analyze/index.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import {
  buildPluginRegistry,
  DEFAULT_DETECTOR_PLUGINS,
} from "../../../src/plugins/registry.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeCloneIndexAdapter } from "../../fakes/fakeCloneIndex.ts";
import { FakeDecompilerAdapter } from "../../fakes/fakeDecompiler.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { runDetectorPluginContract } from "../../contract/detector.contract.ts";
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

const TEST_CLONE_MAPPING: CloneMapping = Object.freeze({
  risk: "honeypot",
  direction: "raises",
  severity: "high",
});

// Dispatcher with one paired selector, matching the k017 fixture table hit.
const TEMPLATE_A_CODE = "0x8063a9059cbb14600a575bff00";
const MISS_CODE = "0x8063deadbeef14600a575b00";
const SELECTORLESS_CODE = "0x6001600055";
const TARGET = "0x0102030405060708090a0b0c0d0e0f1011121314";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function mustBytecode(raw: string): DetectorInput["bytecode"] {
  return mustOk(Bytecode.parse(raw));
}

function testHit(): CloneHit {
  return Object.freeze({
    similarity: mustOk(Probability.of(1)),
    group: mustOk(CloneGroupId.parse("trap-fixed-fee")),
    priorCount: 3,
  });
}

function makeCloneMatchInput(): DetectorInput {
  const bytecode = mustBytecode(TEMPLATE_A_CODE);
  return Object.freeze({
    bytecode,
    codeHash: mustOk(CodeHash.of(bytecode)),
    cloneMatch: testHit(),
    decompilerCause: null,
  });
}

function makeHardToAnalyzeInput(): DetectorInput {
  const bytecode = mustBytecode(TEMPLATE_A_CODE);
  return Object.freeze({
    bytecode,
    codeHash: mustOk(CodeHash.of(bytecode)),
    cloneMatch: null,
    decompilerCause: "timeout",
  });
}

runDetectorPluginContract(
  "dev.brandklipparen.clone-match",
  cloneMatchDetectorPlugin,
  makeCloneMatchInput,
);

runDetectorPluginContract(
  "dev.brandklipparen.hard-to-analyze",
  hardToAnalyzeDetectorPlugin,
  makeHardToAnalyzeInput,
);

function mustCloneIndex(): CloneIndexAdapter {
  const table = JSON.parse(
    readFileSync(join(repoRoot, "tests", "fixtures", "clones", "trap-templates.json"), "utf8"),
  ) as unknown;
  const created = CloneIndexAdapter.create(table);
  if (!created.ok) {
    throw new Error(`expected the fixture table to load: ${created.error.message}`);
  }
  return created.value;
}

function cloneSignals(signals: readonly Signal[]): Extract<Signal, { kind: "clone-match" }>[] {
  return signals.filter(
    (signal): signal is Extract<Signal, { kind: "clone-match" }> => signal.kind === "clone-match",
  );
}

function hardSignals(signals: readonly Signal[]): Extract<Signal, { kind: "hard-to-analyze" }>[] {
  return signals.filter(
    (signal): signal is Extract<Signal, { kind: "hard-to-analyze" }> =>
      signal.kind === "hard-to-analyze",
  );
}

describe("clone-match and hard-to-analyze detector plugins", () => {
  test("manifests carry the namespaced ids and detector kind", () => {
    expect(cloneMatchDetectorPlugin.manifest.id).toBe("dev.brandklipparen.clone-match");
    expect(cloneMatchDetectorPlugin.manifest.kind).toBe("detector");
    expect(cloneMatchDetectorPlugin.manifest.inputs).toEqual(["bytecode", "cloneMatch"]);
    expect(hardToAnalyzeDetectorPlugin.manifest.id).toBe("dev.brandklipparen.hard-to-analyze");
    expect(hardToAnalyzeDetectorPlugin.manifest.kind).toBe("detector");
    expect(hardToAnalyzeDetectorPlugin.manifest.inputs).toEqual(["bytecode", "decompilerCause"]);
  });

  test("default registry holds all four first-party detectors", () => {
    const built = buildPluginRegistry(DEFAULT_DETECTOR_PLUGINS);
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }
    expect(built.value.entries.map((entry) => entry.manifest.id)).toEqual([
      "dev.brandklipparen.capability",
      "dev.brandklipparen.clone-match",
      "dev.brandklipparen.decompiler",
      "dev.brandklipparen.hard-to-analyze",
    ]);
  });

  test("clone-match without a hit yields no findings", () => {
    const bytecode = mustBytecode(TEMPLATE_A_CODE);
    const input: DetectorInput = Object.freeze({
      bytecode,
      codeHash: mustOk(CodeHash.of(bytecode)),
      cloneMatch: null,
      decompilerCause: null,
    });
    expect(cloneMatchDetectorPlugin.detect(input)).toEqual([]);
  });

  test("hard-to-analyze without a cause yields no findings", () => {
    const bytecode = mustBytecode(TEMPLATE_A_CODE);
    const input: DetectorInput = Object.freeze({
      bytecode,
      codeHash: mustOk(CodeHash.of(bytecode)),
      cloneMatch: null,
      decompilerCause: null,
    });
    expect(hardToAnalyzeDetectorPlugin.detect(input)).toEqual([]);
  });

  test("k017 clone hit passes through the registry path with group and count", async () => {
    const target = mustOk(Address.parse(TARGET));
    const block = mustOk(BlockNumber.of(24000000));
    const services = createAppServices({
      rpc: new FakeRpcAdapter(new Map<string, string>([[target as string, TEMPLATE_A_CODE]]), block),
      modelArtifacts: new FileModelArtifactAdapter(join(repoRoot, "model")),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      cloneIndex: mustCloneIndex(),
    },
  mustDefaultDetectorSet());
    const analysed = await services.analyzeToken({
      address: target,
      block,
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustOk(ModelVersion.parse("0.0.0-synthetic.1")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
      cloneMapping: TEST_CLONE_MAPPING,
    });
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    const envelope = analysed.value.envelope;
    const clones = cloneSignals(envelope.signals);
    expect(clones.length).toBe(1);
    const hit = clones[0];
    if (hit === undefined) {
      throw new Error("expected a clone-match signal");
    }
    expect(hit.similarity as number).toBe(1);
    expect(hit.group as string).toBe("trap-fixed-fee");
    expect(hit.priorCount).toBe(3);
    expect(hit.evidence.length).toBeGreaterThan(0);
    const entry = envelope.pluginResults.find(
      (result) => result.pluginId === "dev.brandklipparen.clone-match",
    );
    expect(entry?.outcome).toBe("ok");
    expect(entry?.findings.length).toBe(1);
    expect(entry?.findings[0]?.payload).toEqual({
      similarity: 1,
      group: "trap-fixed-fee",
      priorCount: 3,
    });
  });

  test("clone miss yields no clone signal and an empty ok entry", async () => {
    const target = mustOk(Address.parse(TARGET));
    const block = mustOk(BlockNumber.of(24000000));
    const services = createAppServices({
      rpc: new FakeRpcAdapter(new Map<string, string>([[target as string, MISS_CODE]]), block),
      modelArtifacts: new FileModelArtifactAdapter(join(repoRoot, "model")),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      cloneIndex: mustCloneIndex(),
    },
  mustDefaultDetectorSet());
    const analysed = await services.analyzeToken({
      address: target,
      block,
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustOk(ModelVersion.parse("0.0.0-synthetic.1")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
      cloneMapping: TEST_CLONE_MAPPING,
    });
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    expect(cloneSignals(analysed.value.envelope.signals)).toEqual([]);
    const entry = analysed.value.envelope.pluginResults.find(
      (result) => result.pluginId === "dev.brandklipparen.clone-match",
    );
    expect(entry?.outcome).toBe("ok");
    expect(entry?.findings).toEqual([]);
  });

  test("clone port error leaves the analysis standing without a clone signal", async () => {
    const target = mustOk(Address.parse(TARGET));
    const block = mustOk(BlockNumber.of(24000000));
    const version = mustOk(IndexVersion.parse("1.0.0"));
    const services = createAppServices({
      rpc: new FakeRpcAdapter(new Map<string, string>([[target as string, TEMPLATE_A_CODE]]), block),
      modelArtifacts: new FileModelArtifactAdapter(join(repoRoot, "model")),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      cloneIndex: new FakeCloneIndexAdapter(version, new Map(), {
        kind: "index-unavailable",
        message: "fake index is down",
      }),
    },
  mustDefaultDetectorSet());
    const analysed = await services.analyzeToken({
      address: target,
      block,
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustOk(ModelVersion.parse("0.0.0-synthetic.1")),
      indexVersion: version,
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
      cloneMapping: TEST_CLONE_MAPPING,
    });
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    expect(cloneSignals(analysed.value.envelope.signals)).toEqual([]);
  });

  test("k008 decompiler timeout passes through the registry path", async () => {
    const target = mustOk(Address.parse(TARGET));
    const block = mustOk(BlockNumber.of(24000000));
    const services = createAppServices({
      rpc: new FakeRpcAdapter(new Map<string, string>([[target as string, TEMPLATE_A_CODE]]), block),
      modelArtifacts: new FileModelArtifactAdapter(join(repoRoot, "model")),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      decompiler: new FakeDecompilerAdapter({ scenario: "timeout" }),
    },
  mustDefaultDetectorSet());
    const analysed = await services.analyzeToken({
      address: target,
      block,
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustOk(ModelVersion.parse("0.0.0-synthetic.1")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    });
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    const envelope = analysed.value.envelope;
    const fallback = hardSignals(envelope.signals);
    expect(fallback.length).toBe(1);
    expect(fallback[0]?.cause).toBe("timeout");
    expect((fallback[0]?.evidence.length ?? 0)).toBeGreaterThan(0);
    const entry = envelope.pluginResults.find(
      (result) => result.pluginId === "dev.brandklipparen.hard-to-analyze",
    );
    expect(entry?.outcome).toBe("ok");
    expect(entry?.findings.length).toBe(1);
    expect(entry?.findings[0]?.payload).toEqual({ cause: "timeout" });
    expect(Number.isInteger(envelope.score as number)).toBe(true);
  });

  test("successful decompilation yields no hard-to-analyze signal", async () => {
    const target = mustOk(Address.parse(TARGET));
    const block = mustOk(BlockNumber.of(24000000));
    const services = createAppServices({
      rpc: new FakeRpcAdapter(new Map<string, string>([[target as string, TEMPLATE_A_CODE]]), block),
      modelArtifacts: new FileModelArtifactAdapter(join(repoRoot, "model")),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      decompiler: new FakeDecompilerAdapter({ scenario: "success" }),
    },
  mustDefaultDetectorSet());
    const analysed = await services.analyzeToken({
      address: target,
      block,
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustOk(ModelVersion.parse("0.0.0-synthetic.1")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    });
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    expect(hardSignals(analysed.value.envelope.signals)).toEqual([]);
    const entry = analysed.value.envelope.pluginResults.find(
      (result) => result.pluginId === "dev.brandklipparen.hard-to-analyze",
    );
    expect(entry?.outcome).toBe("ok");
    expect(entry?.findings).toEqual([]);
  });

  test("timeout on selector-less bytecode stands without a hard-to-analyze signal", async () => {
    const target = mustOk(Address.parse(TARGET));
    const block = mustOk(BlockNumber.of(24000000));
    const services = createAppServices({
      rpc: new FakeRpcAdapter(
        new Map<string, string>([[target as string, SELECTORLESS_CODE]]),
        block,
      ),
      modelArtifacts: new FileModelArtifactAdapter(join(repoRoot, "model")),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      decompiler: new FakeDecompilerAdapter({ scenario: "timeout" }),
    },
  mustDefaultDetectorSet());
    const analysed = await services.analyzeToken({
      address: target,
      block,
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustOk(ModelVersion.parse("0.0.0-synthetic.1")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    });
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    expect(hardSignals(analysed.value.envelope.signals)).toEqual([]);
  });
});
