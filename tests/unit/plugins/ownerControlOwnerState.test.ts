// Tests for S-115 (K-010, K-016): on-chain owner state through RpcPort.
// Written first (red) per A-21: the application service runs detection
// but never reads the owner slot, so no signal carries the live value
// until the enrichment lands. With a prior artifact that names the
// ownership plugin, an owner-slot finding enriches its converted signal
// with the applies-now storage value; with the synthetic artifact that
// names nothing, no storage read happens and scoring stays unchanged.
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
  CALLDATALOAD,
  PUSH0,
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

const SET_ADMIN = "0x40c10f19";
const TRANSFER = "0xa9059cbb";
const OWNER_WORD = `0x${"0".repeat(62)}ab`;
const ZERO_SLOT = `0x${"0".repeat(64)}`;

function ownedTokenHex(): string {
  const bytecode = tokenBytecode([
    {
      selector: SET_ADMIN,
      body: [...ownerGuard(0, 200), ...sstoreConstSlot(9, [CALLDATALOAD]), STOP],
    },
    {
      selector: TRANSFER,
      body: [PUSH0, CALLDATALOAD, ...push1(0), SSTORE, STOP],
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
      pluginWeights: { "dev.brandklipparen.ownership": 0.9 },
      pluginFeatureCatalogue: {
        "dev.brandklipparen.ownership": { risk: "rug-pull", direction: "raises", severity: "high" },
      },
    }),
  );
  return new FakeModelArtifactAdapter(
    Object.freeze({ artifact, checksum: mustOk(ArtifactChecksum.parse("cd".repeat(32))) }),
  );
}

function ownerSignals(signals: readonly Signal[]): Signal[] {
  return signals.filter(
    (signal) =>
      signal.kind === "capability" &&
      signal.risk === "rug-pull" &&
      signal.severity === "high" &&
      signal.evidence.some((entry) => (entry.selector as string) === SET_ADMIN),
  );
}

describe("owner on-chain state (S-115)", () => {
  test("owner-slot signal carries the applies-now storage value", async () => {
    const target = mustOk(Address.parse("0x0102030405060708090a0b0c0d0e0f1011121314"));
    const block = mustOk(BlockNumber.of(24000000));
    const rpc = new FakeRpcAdapter(
      new Map<string, string>([[target as string, ownedTokenHex()]]),
      block,
      new Map([[target as string, new Map([[ZERO_SLOT, OWNER_WORD]])]]),
    );
    const services = createAppServices(
      {
        rpc,
        modelArtifacts: priorArtifact(),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      },
      mustDefaultDetectorSet(),
    );
    const analysed = await services.analyzeToken({
      address: target,
      block,
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustOk(ModelVersion.parse("0.1.0-prior.test")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    });
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    const signals = ownerSignals(analysed.value.envelope.signals);
    expect(signals.length).toBeGreaterThan(0);
    const appliesNow = signals.filter((signal) => signal.kind === "capability" && signal.temporality.kind === "applies-now");
    expect(appliesNow).toHaveLength(signals.length);
    for (const signal of appliesNow) {
      if (signal.kind !== "capability" || signal.temporality.kind !== "applies-now") {
        throw new Error("expected applies-now ownership signals");
      }
      expect(signal.temporality.measuredValue.value as string).toBe(OWNER_WORD);
      expect(signal.temporality.measuredValue.slot as string).toBe(ZERO_SLOT);
      expect(signal.temporality.block as number).toBe(block as number);
    }
    // Proxy resolution reads its own slots beside the owner read.
    expect(rpc.getStorageAtCalls.filter((call) => call.slot === ZERO_SLOT)).toEqual([
      { address: target as string, slot: ZERO_SLOT },
    ]);
  });

  test("synthetic artifact without the catalogue reads no storage", async () => {
    const target = mustOk(Address.parse("0x0102030405060708090a0b0c0d0e0f1011121314"));
    const block = mustOk(BlockNumber.of(24000000));
    const rpc = new FakeRpcAdapter(new Map<string, string>([[target as string, ownedTokenHex()]]), block);
    const services = createAppServices(
      {
        rpc,
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
    // Proxy resolution reads its own slots; the owner slot must stay unread.
    expect(rpc.getStorageAtCalls.filter((call) => call.slot === ZERO_SLOT)).toEqual([]);
    expect(ownerSignals(analysed.value.envelope.signals)).toEqual([]);
  });
});
