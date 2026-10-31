// Tests for P-11 [fact]: extended fact findings never convert to signals.
// The packed-pause and shared-blacklist fixtures prove extended facts in
// the default detector run, while a detector set with the two detectors
// silenced proves the baseline. The artifact names both plugins in its
// feature catalogue, so any conversion would move signals, score and
// probabilities; the envelopes must agree exactly. All ports are in-memory
// fakes; no network happens in this test.
import { describe, expect, test } from "vitest";
import { parseModelArtifact } from "../../../src/domain/risk.ts";
import type { Result } from "../../../src/domain/result.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  IndexVersion,
  ModelVersion,
  RequestId,
  TemplateVersion,
  Timestamp,
} from "../../../src/domain/types.ts";
import type { CapabilityCatalogue } from "../../../src/domain/signals.ts";
import { createAppServices } from "../../../src/application/analyzeToken.ts";
import type { DetectorSet } from "../../../src/application/analyzeToken.ts";
import { buildPluginRegistry } from "../../../src/plugins/registry.ts";
import type { DetectorPlugin } from "../../../src/plugins/detector.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";
import { packedPauseToken, sharedBlacklistTokenHex } from "../../helpers/ownerControlFixtures.ts";
import { syntheticAddress } from "../../helpers/syntheticAddresses.ts";

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

// Calibrated artifact naming both extended detectors: a `fact` payload
// finding would convert here if the conversion read anything but the
// `feature` key, so the equality below is not vacuous.
function factArtifact(): FakeModelArtifactAdapter {
  const artifact = mustOk(
    parseModelArtifact({
      version: "0.1.0-fact.test",
      severityWeights: { low: 0.2, medium: 0.5, high: 1.0 },
      causeWeights: { timeout: 0.4, "resource-limit": 0.4, "decompiler-error": 0.6, "obfuscated-structure": 0.6 },
      biases: { "rug-pull": 0.0, honeypot: 0.0, "bot-pump": 0.0 },
      calibration: {
        "rug-pull": { slope: 1.0, intercept: 0.0 },
        honeypot: { slope: 1.0, intercept: 0.0 },
        "bot-pump": { slope: 1.0, intercept: 0.0 },
      },
      scoreWeights: { "rug-pull": 1.0, honeypot: 1.0, "bot-pump": 1.0 },
      pluginWeights: { "dev.brandklipparen.pause": 0.9, "dev.brandklipparen.blacklist": 0.9 },
      pluginFeatureCatalogue: {
        "dev.brandklipparen.pause": { risk: "honeypot", direction: "raises", severity: "high" },
        "dev.brandklipparen.blacklist": { risk: "honeypot", direction: "raises", severity: "high" },
      },
    }),
  );
  return new FakeModelArtifactAdapter(
    Object.freeze({ artifact, checksum: mustOk(ArtifactChecksum.parse("ef".repeat(32))) }),
  );
}

// Baseline detector set: the default entries with the pause and blacklist
// detectors silenced, so the run carries no plugin output from them.
function silentFactDetectorSet(): DetectorSet {
  const entries: DetectorPlugin[] = mustDefaultDetectorSet().registry.entries.map((entry) =>
    entry.manifest.id === "dev.brandklipparen.pause" || entry.manifest.id === "dev.brandklipparen.blacklist"
      ? Object.freeze({ ...entry, detect: () => Object.freeze([]) })
      : entry,
  );
  const built = buildPluginRegistry(entries);
  if (!built.ok) {
    throw new Error(`silent detector set failed to build: ${built.error.kind}`);
  }
  return Object.freeze({ registry: built.value });
}

async function analyze(bytecodeHex: string, detectors: DetectorSet) {
  const target = mustOk(Address.parse(syntheticAddress(1)));
  const block = mustOk(BlockNumber.of(24000000));
  const services = createAppServices(
    {
      rpc: new FakeRpcAdapter(new Map<string, string>([[target as string, bytecodeHex]]), block),
      modelArtifacts: factArtifact(),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
    detectors,
  );
  const analysed = await services.analyzeToken({
    address: target,
    block,
    requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(1700000005000)),
    modelVersion: mustOk(ModelVersion.parse("0.1.0-fact.test")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
  });
  if (!analysed.ok || analysed.value.kind !== "assessed") {
    throw new Error("expected an assessed envelope");
  }
  return analysed.value.envelope;
}

describe("extended fact findings never convert to signals (P-11)", () => {
  test("packed pause fact leaves score, probabilities, signals and explanation bit-identical", async () => {
    const bytecodeHex = `0x${Buffer.from(packedPauseToken()).toString("hex")}`;
    const full = await analyze(bytecodeHex, mustDefaultDetectorSet());
    const pause = full.pluginResults.find((entry) => entry.pluginId === "dev.brandklipparen.pause");
    expect(pause?.outcome).toBe("ok");
    expect(pause?.findings).toHaveLength(1);
    expect(pause?.findings[0]?.payload).toEqual({ fact: "pause", slot: 0, mode: "pause", proof: "extended" });
    const silent = await analyze(bytecodeHex, silentFactDetectorSet());
    expect(silent.signals).toEqual(full.signals);
    expect(silent.probabilities).toEqual(full.probabilities);
    expect(silent.score).toBe(full.score);
    expect(silent.explanation).toEqual(full.explanation);
  });

  test("shared blacklist fact leaves score, probabilities, signals and explanation bit-identical", async () => {
    const bytecodeHex = sharedBlacklistTokenHex();
    const full = await analyze(bytecodeHex, mustDefaultDetectorSet());
    const blacklist = full.pluginResults.find(
      (entry) => entry.pluginId === "dev.brandklipparen.blacklist",
    );
    expect(blacklist?.outcome).toBe("ok");
    expect(blacklist?.findings).toHaveLength(1);
    expect(blacklist?.findings[0]?.payload).toEqual({ fact: "blacklist", proof: "extended" });
    const silent = await analyze(bytecodeHex, silentFactDetectorSet());
    expect(silent.signals).toEqual(full.signals);
    expect(silent.probabilities).toEqual(full.probabilities);
    expect(silent.score).toBe(full.score);
    expect(silent.explanation).toEqual(full.explanation);
  });
});
