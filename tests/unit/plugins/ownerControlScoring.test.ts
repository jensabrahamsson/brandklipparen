// Tests for S-115 (K-011, K-210): owner-control findings enter the score
// through the artifact feature catalogue. Written first (red) per A-21:
// with the catalogue the mint finding converts to a scored capability
// signal and the score moves, while the synthetic artifact without the
// catalogue converts nothing and the score stays at the bias baseline.
import { describe, expect, test } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import type { CapabilityCatalogue, Signal } from "../../../src/domain/signals.ts";
import { createAppServices } from "../../../src/application/analyzeToken.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { FileModelArtifactAdapter } from "../../../src/adapters/model/fileArtifact.ts";
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";
import {
  ADD,
  CALLDATALOAD,
  KECCAK,
  SLOAD,
  SSTORE,
  STOP,
  ownerGuard,
  push1,
  sstoreConstSlot,
  tokenBytecode,
} from "../../helpers/ownerControlFixtures.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

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

const MINT = "0x40c10f19";
const TRANSFER = "0xa9059cbb";

function mintTokenHex(): string {
  const bytecode = tokenBytecode([
    {
      selector: MINT,
      body: [
        ...ownerGuard(0, 200),
        CALLDATALOAD,
        ...push1(1),
        SLOAD,
        ADD,
        ...sstoreConstSlot(1, []),
        CALLDATALOAD,
        ...push1(2),
        KECCAK,
        SSTORE,
        STOP,
      ],
    },
    {
      selector: TRANSFER,
      body: [CALLDATALOAD, ...push1(1), SLOAD, ADD, ...sstoreConstSlot(2, [CALLDATALOAD]), STOP],
    },
  ]);
  return `0x${Buffer.from(bytecode).toString("hex")}`;
}

function priorArtifact(): FakeModelArtifactAdapter {
  const artifact = mustOk(
    parseModelArtifact({
      version: "0.1.0-prior.test",
      severityWeights: { low: 0.2, medium: 0.5, high: 1.0 },
      causeWeights: { timeout: 0.4, "resource-limit": 0.4, "decompiler-error": 0.6, "obfuscated-structure": 0.6 },
      biases: { "rug-pull": 0.0, honeypot: 0.0, "bot-pump": 0.0 },
      calibration: {
        "rug-pull": { slope: 1.0, intercept: 0.0 },
        honeypot: { slope: 1.0, intercept: 0.0 },
        "bot-pump": { slope: 1.0, intercept: 0.0 },
      },
      scoreWeights: { "rug-pull": 1.0, honeypot: 1.0, "bot-pump": 1.0 },
      pluginWeights: { "dev.brandklipparen.mint": 0.9 },
      pluginFeatureCatalogue: {
        "dev.brandklipparen.mint": { risk: "rug-pull", direction: "raises", severity: "high" },
      },
    }),
  );
  return new FakeModelArtifactAdapter(
    Object.freeze({ artifact, checksum: mustOk(ArtifactChecksum.parse("cd".repeat(32))) }),
  );
}

function mintSignals(signals: readonly Signal[]): Signal[] {
  return signals.filter(
    (signal) =>
      signal.kind === "capability" &&
      signal.risk === "rug-pull" &&
      signal.severity === "high" &&
      signal.evidence.some((entry) => (entry.selector as string) === MINT),
  );
}

async function analyze(modelVersion: string, artifact: FakeModelArtifactAdapter | FileModelArtifactAdapter) {
  const target = mustOk(Address.parse("0x0102030405060708090a0b0c0d0e0f1011121314"));
  const block = mustOk(BlockNumber.of(24000000));
  const services = createAppServices(
    {
      rpc: new FakeRpcAdapter(new Map<string, string>([[target as string, mintTokenHex()]]), block),
      modelArtifacts: artifact,
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
    mustDefaultDetectorSet(),
  );
  const analysed = await services.analyzeToken({
    address: target,
    block,
    requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(1700000005000)),
    modelVersion: mustOk(ModelVersion.parse(modelVersion)),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
  });
  if (!analysed.ok || analysed.value.kind !== "assessed") {
    throw new Error("expected an assessed envelope");
  }
  return analysed.value.envelope;
}

describe("owner-control scoring (S-115)", () => {
  test("prior artifact converts the mint finding to a scored signal", async () => {
    const envelope = await analyze("0.1.0-prior.test", priorArtifact());
    const signals = mintSignals(envelope.signals);
    expect(signals).toHaveLength(1);
    expect(envelope.score as number).not.toBe(50);
  });

  test("synthetic artifact without the catalogue converts nothing", async () => {
    const envelope = await analyze(
      "0.0.0-synthetic.1",
      new FileModelArtifactAdapter(join(repoRoot, "model")),
    );
    expect(mintSignals(envelope.signals)).toEqual([]);
    const prior = await analyze("0.1.0-prior.test", priorArtifact());
    expect(envelope.score as number).not.toBe(prior.score as number);
  });
});
