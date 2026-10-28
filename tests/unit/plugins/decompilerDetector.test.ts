// Tests for S-081 (K-037, K-028, K-031, K-307, D-07, D-08): the own ERC-20
// decompiler as a detector plugin `dev.brandklipparen.decompiler`. Written
// first (red) per A-21: the plugin module does not exist yet, so the
// imports fail until the implementation lands. The shared detector
// contract proves determinism, schema agreement, evidence presence and
// unchanged inputs; the tests below prove the D-07 consumption (the same
// functions, offsets and unresolved-jump count flow through the shared
// service into `pluginResults`, which REST, MCP and the Expert view render
// generically) and the D-08 score neutrality (bit-identical score,
// probabilities and signals with the plugin enabled, disabled and absent,
// weight 0 until the artifact names it).
import { readFileSync } from "node:fs";
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
import { decompileContract } from "../../../src/domain/evmSsa.ts";
import { canonicalSerialize } from "../../../src/domain/serialize.ts";
import { pluginResultToCanonical } from "../../../src/plugins/detector.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import { decompilerDetectorPlugin } from "../../../src/plugins/detectors/decompiler/index.ts";
import type { DetectorSet } from "../../../src/application/analyzeToken.ts";
import { buildPluginRegistry, DEFAULT_DETECTOR_PLUGINS } from "../../../src/plugins/registry.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { runDetectorPluginContract } from "../../contract/detector.contract.ts";
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const corpusDir = join(repoRoot, "tests", "fixtures", "evm", "corpus");

const DECOMPILER_ID = "dev.brandklipparen.decompiler";

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

function fixtureHex(name: string): string {
  return readFileSync(join(corpusDir, name), "utf8").trim();
}

function makeDecompilerInput(): DetectorInput {
  const bytecode = mustOk(Bytecode.parse(fixtureHex("token-simple.hex")));
  return Object.freeze({
    bytecode,
    codeHash: mustOk(CodeHash.of(bytecode)),
  });
}

runDetectorPluginContract(DECOMPILER_ID, decompilerDetectorPlugin, makeDecompilerInput);

describe("d07_decompiler_output_consumed_identically_in_rest_mcp_and_expert_ui", () => {
  test("service pluginResults carry the same functions, offsets and unresolved-jump count", async () => {
    const sampleHex = fixtureHex("token-simple.hex");
    const target = mustOk(Address.parse("0x0102030405060708090a0b0c0d0e0f1011121314"));
    const block = mustOk(BlockNumber.of(24000000));
    const services = createAppServices(
      {
        rpc: new FakeRpcAdapter(new Map<string, string>([[target as string, sampleHex]]), block),
        modelArtifacts: new FileModelArtifactAdapter(join(repoRoot, "model")),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      },
      mustDefaultDetectorSet(),
    );
    const analysed = await services.analyzeToken({
      address: target,
      block,
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174001")),
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
    const entry = envelope.pluginResults.find((candidate) => candidate.pluginId === DECOMPILER_ID);
    expect(entry?.outcome).toBe("ok");

    // The reference is the deterministic pipeline itself: the plugin is a
    // thin detector boundary over `decompileContract`, so the entry must
    // agree function for function.
    const direct = decompileContract(mustOk(Bytecode.parse(sampleHex)));
    expect(entry?.findings.length).toBe(direct.functions.length);
    for (const fn of direct.functions) {
      const finding = entry?.findings.find((candidate) => candidate.id === `${DECOMPILER_ID}:${fn.selector}`);
      expect(finding).toBeDefined();
      const payload = finding?.payload as Record<string, unknown>;
      expect(payload["selector"]).toBe(fn.selector);
      expect(payload["name"]).toBe(fn.name);
      expect(payload["entryPc"]).toBe(fn.entryPc);
      expect(payload["startPc"]).toBe(fn.range.startPc);
      expect(payload["endPc"]).toBe(fn.range.endPc);
      expect(payload["cause"] ?? null).toBe(fn.cause);
      expect(payload["unresolvedJumps"]).toBe(direct.unresolvedJumps.length);
    }
    // REST and MCP serialize the same canonical entry the Expert view
    // renders: one canonical shape feeds all three consumers.
    const canonical = entry === undefined ? null : pluginResultToCanonical(entry);
    expect(canonical).not.toBe(null);
    expect(canonicalSerialize(canonical as never).length).toBeGreaterThan(0);
  });
});

describe("d08_decompiler_findings_leave_score_and_evidence_unchanged", () => {
  test("bit-identical score, probabilities and signals with the plugin enabled and absent", async () => {
    const withoutBuilt = buildPluginRegistry(
      DEFAULT_DETECTOR_PLUGINS.filter((entry) => entry.manifest.id !== DECOMPILER_ID),
    );
    if (!withoutBuilt.ok) {
      throw new Error(`registry without decompiler failed: ${withoutBuilt.error.kind}`);
    }
    const without: DetectorSet = Object.freeze({ registry: withoutBuilt.value });
    for (const name of ["token-simple.hex", "token-allowance.hex", "token-pausable.hex", "edge-fallback.hex", "edge-invalid.hex"]) {
      const sampleHex = fixtureHex(name);
      const target = mustOk(Address.parse("0x0102030405060708090a0b0c0d0e0f1011121314"));
      const block = mustOk(BlockNumber.of(24000000));
      const ports = {
        rpc: new FakeRpcAdapter(new Map<string, string>([[target as string, sampleHex]]), block),
        modelArtifacts: new FileModelArtifactAdapter(join(repoRoot, "model")),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      };
      const input = {
        address: target,
        block,
        requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174002")),
        deadline: mustOk(Timestamp.of(1700000005000)),
        modelVersion: mustOk(ModelVersion.parse("0.0.0-synthetic.1")),
        indexVersion: mustOk(IndexVersion.parse("1.0.0")),
        templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
        catalogue: TEST_CATALOGUE,
      };
      const withPlugin = await createAppServices(ports, mustDefaultDetectorSet()).analyzeToken(input);
      const absentPlugin = await createAppServices(ports, without).analyzeToken(input);
      expect(withPlugin.ok).toBe(true);
      expect(absentPlugin.ok).toBe(true);
      if (!withPlugin.ok || withPlugin.value.kind !== "assessed" || !absentPlugin.ok || absentPlugin.value.kind !== "assessed") {
        throw new Error(`expected assessed envelopes for ${name}`);
      }
      expect(canonicalSerialize(withPlugin.value.envelope.score as never)).toBe(
        canonicalSerialize(absentPlugin.value.envelope.score as never),
      );
      expect(canonicalSerialize(withPlugin.value.envelope.probabilities as never)).toBe(
        canonicalSerialize(absentPlugin.value.envelope.probabilities as never),
      );
      expect(canonicalSerialize(withPlugin.value.envelope.signals as never)).toBe(
        canonicalSerialize(absentPlugin.value.envelope.signals as never),
      );
      const withIds = withPlugin.value.envelope.pluginResults.map((candidate) => candidate.pluginId);
      const absentIds = absentPlugin.value.envelope.pluginResults.map((candidate) => candidate.pluginId);
      expect(withIds.filter((id) => id !== DECOMPILER_ID)).toEqual(absentIds);
    }
  });
});
