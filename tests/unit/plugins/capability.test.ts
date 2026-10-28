// Tests for S-043 (K-029 proposed): the capability detector as the first
// detector plugin `dev.brandklipparen.capability`. Written first (red) per
// A-21: the plugin module does not exist yet, so the import fails until the
// implementation lands. The shared detector contract proves determinism,
// schema agreement, evidence presence and unchanged inputs; the tests below
// prove registry membership and the service wiring that replaces the legacy
// direct detectCapabilities call in analyzeToken.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { FileModelArtifactAdapter } from "../../../src/adapters/model/fileArtifact.ts";
import { createAppServices } from "../../../src/application/analyzeToken.ts";
import {
  Address,
  BlockNumber,
  Bytecode,
  CodeHash,
  IndexVersion,
  ModelVersion,
  RequestId,
  TemplateVersion,
  Timestamp,
} from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import type { CapabilityCatalogue } from "../../../src/domain/signals.ts";
import { capabilityDetectorPlugin } from "../../../src/plugins/detectors/capability/index.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import {
  buildPluginRegistry,
  DEFAULT_DETECTOR_PLUGINS,
} from "../../../src/plugins/registry.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
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

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

// Small hand-assembled dispatcher with a SELFDESTRUCT opcode: one selector
// with derivable opcode offsets, so the plugin must report findings.
const DISPATCHER_WITH_SELFDESTRUCT = "0x8063a9059cbb14600a575bff00";

function makeInput(): DetectorInput {
  const bytecode = mustOk(Bytecode.parse(DISPATCHER_WITH_SELFDESTRUCT));
  return Object.freeze({ bytecode, codeHash: mustOk(CodeHash.of(bytecode)) });
}

runDetectorPluginContract(
  "dev.brandklipparen.capability",
  capabilityDetectorPlugin,
  makeInput,
);

describe("capability detector plugin", () => {
  test("manifest carries the namespaced id and detector kind", () => {
    expect(capabilityDetectorPlugin.manifest.id).toBe("dev.brandklipparen.capability");
    expect(capabilityDetectorPlugin.manifest.kind).toBe("detector");
    expect(capabilityDetectorPlugin.manifest.inputs).toEqual(["bytecode"]);
  });

  test("default registry holds the capability plugin and stays frozen", () => {
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
    expect(Object.isFrozen(built.value)).toBe(true);
  });

  test("bytecode without selectors yields no findings", () => {
    const bytecode = mustOk(Bytecode.parse("0x6001600055"));
    const input: DetectorInput = Object.freeze({
      bytecode,
      codeHash: mustOk(CodeHash.of(bytecode)),
    });
    expect(capabilityDetectorPlugin.detect(input)).toEqual([]);
  });

  test("evidence names the function holding the opcode, not the first selector", () => {
    // Same layout as the domain attribution test: 0x06fdde03 routes to PC
    // 48 with no storage use, 0xa9059cbb routes to PC 64, and the only
    // SSTORE sits at PC 69 inside the 0xa9059cbb body. The finding must
    // cite 0xa9059cbb.
    const body = [
      0x80, 0x63, 0x06, 0xfd, 0xde, 0x03, 0x14, 0x61, 0x00, 0x30, 0x57,
      0x80, 0x63, 0xa9, 0x05, 0x9c, 0xbb, 0x14, 0x61, 0x00, 0x40, 0x57,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x5b,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00,
      0x5b,
      0x60, 0x00, 0x60, 0x00, 0x55, 0x00,
    ];
    const bytecode = mustOk(
      Bytecode.parse(`0x${body.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`),
    );
    const input: DetectorInput = Object.freeze({
      bytecode,
      codeHash: mustOk(CodeHash.of(bytecode)),
    });
    const findings = capabilityDetectorPlugin.detect(input);
    expect(findings).toHaveLength(1);
    const evidence = findings[0]?.evidence;
    expect(evidence?.length).toBe(1);
    expect(evidence?.[0]?.selector as string).toBe("0xa9059cbb");
    expect(evidence?.[0]?.offset as number).toBe(69);
  });

  test("analyzeToken runs detection through the registry and records pluginResults", async () => {
    const target = mustOk(Address.parse("0x0102030405060708090a0b0c0d0e0f1011121314"));
    const block = mustOk(BlockNumber.of(24000000));
    const services = createAppServices({
      rpc: new FakeRpcAdapter(
        new Map<string, string>([[target as string, DISPATCHER_WITH_SELFDESTRUCT]]),
        block,
      ),
      modelArtifacts: new FileModelArtifactAdapter(join(repoRoot, "model")),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
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
    expect(envelope.pluginResults.length).toBe(4);
    const entry = envelope.pluginResults[0];
    expect(entry?.pluginId).toBe("dev.brandklipparen.capability");
    expect(entry?.outcome).toBe("ok");
    const capabilities = envelope.signals.filter((signal) => signal.kind === "capability");
    expect(entry?.findings.length).toBe(capabilities.length);
    expect(capabilities.length).toBeGreaterThan(0);
  });
});
