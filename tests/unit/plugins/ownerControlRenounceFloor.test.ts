// Tests for SCORE-2: renounced ownership proven from the live owner
// getter lifts the score floor, and floor-feeding findings say so.
// Synthetic fixtures only; all ports are in-memory fakes.
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
import { Evidence } from "../../../src/domain/evidence.ts";
import { Selector } from "../../../src/domain/types.ts";
import { createAppServices } from "../../../src/application/analyzeToken.ts";
import type { AssessmentEnvelope, DetectorSet } from "../../../src/application/analyzeToken.ts";
import { buildPluginRegistry } from "../../../src/plugins/registry.ts";
import type { DetectorPlugin, PluginFinding } from "../../../src/plugins/detector.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";
import { syntheticAddress } from "../../helpers/syntheticAddresses.ts";
import {
  ADD,
  CALLDATALOAD,
  KECCAK,
  PUSH0,
  SLOAD,
  SSTORE,
  STOP,
  ownerGuard,
  push1,
  sstoreConstSlot,
  tokenBytecode,
} from "../../helpers/ownerControlFixtures.ts";

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

const OWNER_FN = "0x8da5cb5b";
const GET_OWNER_FN = "0x893d20e8";
const MINT = "0x40c10f19";
const TRANSFER = "0xa9059cbb";
const ZERO_SLOT = `0x${"0".repeat(64)}`;
const ZERO_WORD = `0x${"0".repeat(64)}`;
const DEAD_WORD = `0x${"0".repeat(24)}000000000000000000000000000000000000dead`;
const OWNER_A = syntheticAddress(41);

function addressWord(owner: string): string {
  return `0x${"0".repeat(24)}${owner.slice(2).toLowerCase()}`;
}

function gatedArtifact(): FakeModelArtifactAdapter {
  const artifact = mustOk(
    parseModelArtifact({
      version: "0.1.0-renounce.test",
      severityWeights: { low: 0.2, medium: 0.5, high: 1.0 },
      causeWeights: { timeout: 0.4, "resource-limit": 0.4, "decompiler-error": 0.6, "obfuscated-structure": 0.6 },
      biases: { "rug-pull": 0.0, honeypot: 0.0, "bot-pump": 0.0 },
      calibration: {
        "rug-pull": { slope: 1.0, intercept: 0.0 },
        honeypot: { slope: 1.0, intercept: 0.0 },
        "bot-pump": { slope: 1.0, intercept: 0.0 },
      },
      scoreWeights: { "rug-pull": 1.0, honeypot: 1.0, "bot-pump": 1.0 },
      pluginWeights: {
        "dev.brandklipparen.mint": 0.9,
        "dev.brandklipparen.ownership": 0.9,
        "dev.brandklipparen.blacklist": 0.9,
      },
      pluginFeatureCatalogue: {
        "dev.brandklipparen.mint": { risk: "rug-pull", direction: "raises", severity: "high" },
        "dev.brandklipparen.ownership": { risk: "rug-pull", direction: "raises", severity: "high" },
        "dev.brandklipparen.blacklist": { risk: "honeypot", direction: "raises", severity: "high" },
      },
    }),
  );
  return new FakeModelArtifactAdapter(
    Object.freeze({ artifact, checksum: mustOk(ArtifactChecksum.parse("cd".repeat(32))) }),
  );
}

function mintBody(): number[] {
  return [
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
  ];
}

function gatedTokenHex(getter: string = OWNER_FN): string {
  const bytecode = tokenBytecode([
    { selector: MINT, body: mintBody() },
    { selector: TRANSFER, body: [CALLDATALOAD, ...push1(1), SLOAD, ADD, ...sstoreConstSlot(2, [CALLDATALOAD]), STOP] },
    { selector: getter, body: [STOP] },
  ]);
  return `0x${Buffer.from(bytecode).toString("hex")}`;
}

// Token with an owner-guarded setter (so the ownership detector proves
// the owner slot) plus a dispatched owner getter, and nothing else.
function ownerSlotTokenHex(): string {
  const bytecode = tokenBytecode([
    {
      selector: "0x11111111",
      body: [...ownerGuard(0, 200), ...sstoreConstSlot(0, [CALLDATALOAD]), STOP],
    },
    { selector: TRANSFER, body: [PUSH0, CALLDATALOAD, ...push1(0), SSTORE, STOP] },
    { selector: OWNER_FN, body: [STOP] },
  ]);
  return `0x${Buffer.from(bytecode).toString("hex")}`;
}

// Token that only dispatches owner() beside a plain transfer: no
// owner-guarded function, so no owner slot is ever proven.
function getterOnlyTokenHex(): string {
  const bytecode = tokenBytecode([
    { selector: TRANSFER, body: [PUSH0, CALLDATALOAD, ...push1(0), SSTORE, STOP] },
    { selector: OWNER_FN, body: [STOP] },
  ]);
  return `0x${Buffer.from(bytecode).toString("hex")}`;
}

function stubDetectorSet(pluginId: string, finding: PluginFinding): DetectorSet {
  const entries: DetectorPlugin[] = mustDefaultDetectorSet().registry.entries.map((entry) =>
    (entry.manifest.id as string) === pluginId
      ? Object.freeze({ ...entry, detect: () => Object.freeze([finding]) })
      : entry,
  );
  const built = buildPluginRegistry(entries);
  if (!built.ok) {
    throw new Error(`stub detector set failed to build: ${built.error.kind}`);
  }
  return Object.freeze({ registry: built.value });
}

function extendedFinding(
  pluginId: "dev.brandklipparen.mint" | "dev.brandklipparen.blacklist",
  payload: Readonly<Record<string, unknown>>,
  title: string,
): PluginFinding {
  const evidence = mustOk(Evidence.create({ selector: mustOk(Selector.parse(MINT)) }));
  return Object.freeze({
    id: `${pluginId}:stub-extended`,
    pluginId: pluginId as PluginFinding["pluginId"],
    title,
    evidence: Object.freeze([evidence]) as PluginFinding["evidence"],
    payload: Object.freeze(payload) as PluginFinding["payload"],
  });
}

async function analyse(
  bytecodeHex: string,
  slotWords: ReadonlyMap<string, string>,
  calls: ReadonlyMap<string, string>,
  tail: string,
  detectors: DetectorSet = mustDefaultDetectorSet(),
): Promise<AssessmentEnvelope> {
  const target = mustOk(Address.parse(syntheticAddress(43)));
  const block = mustOk(BlockNumber.of(24000000));
  const rpc = new FakeRpcAdapter(
    new Map<string, string>([[target as string, bytecodeHex]]),
    block,
    new Map([[target as string, slotWords]]),
    { calls },
  );
  const services = createAppServices(
    {
      rpc,
      modelArtifacts: gatedArtifact(),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
    detectors,
  );
  const analysed = await services.analyzeToken({
    address: target,
    block,
    requestId: mustOk(RequestId.parse(`123e4567-e89b-12d3-a456-42661417${tail}`)),
    deadline: mustOk(Timestamp.of(1700000005000)),
    modelVersion: mustOk(ModelVersion.parse("0.1.0-renounce.test")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.1.0")),
    catalogue: TEST_CATALOGUE,
  });
  expect(analysed.ok).toBe(true);
  if (!analysed.ok || analysed.value.kind !== "assessed") {
    throw new Error("expected an assessed envelope");
  }
  return analysed.value.envelope;
}

describe("renounced ownership lifts the score floor (SCORE-2)", () => {
  test("owner() returning the zero address renounces and lifts the floor", async () => {
    const envelope = await analyse(
      gatedTokenHex(),
      new Map([[ZERO_SLOT, ZERO_WORD]]),
      new Map([[OWNER_FN, ZERO_WORD]]),
      "4301",
    );
    expect(envelope.scoreFloor).toBeUndefined();
    expect(envelope.ownerState?.status).toBe("renounced");
    expect(envelope.ownerState?.getter).toBe("owner()");
    expect(envelope.ownerState?.address?.toLowerCase()).toBe(
      "0x0000000000000000000000000000000000000000",
    );
    expect(envelope.ownerState?.block as number).toBe(24000000);
  });

  test("owner() returning the dead address renounces and lifts the floor", async () => {
    const envelope = await analyse(
      gatedTokenHex(),
      new Map([[ZERO_SLOT, DEAD_WORD]]),
      new Map([[OWNER_FN, DEAD_WORD]]),
      "4302",
    );
    expect(envelope.scoreFloor).toBeUndefined();
    expect(envelope.ownerState?.status).toBe("renounced");
    expect(envelope.ownerState?.address?.toLowerCase()).toBe(
      "0x000000000000000000000000000000000000dead",
    );
  });

  test("getOwner() returning the zero address renounces and lifts the floor", async () => {
    const envelope = await analyse(
      gatedTokenHex(GET_OWNER_FN),
      new Map([[ZERO_SLOT, ZERO_WORD]]),
      new Map([[GET_OWNER_FN, ZERO_WORD]]),
      "4303",
    );
    expect(envelope.scoreFloor).toBeUndefined();
    expect(envelope.ownerState?.status).toBe("renounced");
    expect(envelope.ownerState?.getter).toBe("getOwner()");
  });

  test("a non-zero owner keeps the floor", async () => {
    const envelope = await analyse(
      gatedTokenHex(),
      new Map([[ZERO_SLOT, addressWord(OWNER_A)]]),
      new Map([[OWNER_FN, addressWord(OWNER_A)]]),
      "4304",
    );
    expect(envelope.score as number).toBeGreaterThanOrEqual(30);
    expect(envelope.scoreFloor?.label).toContain("mint");
    expect(envelope.ownerState?.status).toBe("active");
  });

  test("an unreadable owner keeps the floor and says the owner could not be read", async () => {
    const envelope = await analyse(
      gatedTokenHex(),
      new Map([[ZERO_SLOT, ZERO_WORD]]),
      new Map<string, string>(),
      "4305",
    );
    expect(envelope.score as number).toBeGreaterThanOrEqual(30);
    expect(envelope.scoreFloor?.label).toContain("mint");
    expect(envelope.ownerState?.status).toBe("unknown");
    expect(envelope.ownerState?.reason).toContain("could not be read");
  });

  test("a getter renounce lifts an owner-gated fact even without a proven owner slot", async () => {
    const finding = extendedFinding(
      "dev.brandklipparen.mint",
      { fact: "mint", slot: 4, auth: "owner", recipient: "argument", capped: false, proof: "extended" },
      "The owner can create new tokens. Found by extended analysis; not counted in the score.",
    );
    const envelope = await analyse(
      getterOnlyTokenHex(),
      new Map<string, string>(),
      new Map([[OWNER_FN, ZERO_WORD]]),
      "4306",
      stubDetectorSet("dev.brandklipparen.mint", finding),
    );
    expect(envelope.scoreFloor).toBeUndefined();
    expect(envelope.ownerState?.status).toBe("renounced");
    const mint = envelope.pluginResults.find(
      (entry) => (entry.pluginId as string) === "dev.brandklipparen.mint",
    );
    expect(mint?.findings[0]?.title).toContain("not counted because ownership is renounced");
    expect(mint?.findings[0]?.title).not.toContain("not counted in the score");
  });

  test("a separate non-owner gate role keeps the floor despite a renounced owner()", async () => {
    const finding = extendedFinding(
      "dev.brandklipparen.mint",
      { fact: "mint", slot: 4, auth: "role-mapping", recipient: "argument", capped: false, proof: "extended" },
      "The owner can create new tokens. Found by extended analysis; not counted in the score.",
    );
    const envelope = await analyse(
      getterOnlyTokenHex(),
      new Map<string, string>(),
      new Map([[OWNER_FN, ZERO_WORD]]),
      "4307",
      stubDetectorSet("dev.brandklipparen.mint", finding),
    );
    expect(envelope.score as number).toBeGreaterThanOrEqual(30);
    expect(envelope.scoreFloor?.label).toContain("mint");
    const mint = envelope.pluginResults.find(
      (entry) => (entry.pluginId as string) === "dev.brandklipparen.mint",
    );
    expect(mint?.findings[0]?.title).toContain("sets the minimum score");
  });

  test("a floor-feeding extended finding says it sets the minimum score while the owner is active", async () => {
    const finding = extendedFinding(
      "dev.brandklipparen.blacklist",
      { fact: "blacklist", proof: "extended" },
      "The owner can stop chosen wallets from sending tokens. Found by extended analysis; not counted in the score.",
    );
    const envelope = await analyse(
      ownerSlotTokenHex(),
      new Map([[ZERO_SLOT, addressWord(OWNER_A)]]),
      new Map([[OWNER_FN, addressWord(OWNER_A)]]),
      "4308",
      stubDetectorSet("dev.brandklipparen.blacklist", finding),
    );
    expect(envelope.score as number).toBeGreaterThanOrEqual(60);
    expect(envelope.scoreFloor?.label).toContain("blacklist");
    const entry = envelope.pluginResults.find(
      (item) => (item.pluginId as string) === "dev.brandklipparen.blacklist",
    );
    expect(entry?.findings[0]?.title).toContain("sets the minimum score");
    expect(entry?.findings[0]?.title).not.toContain("not counted in the score");
  });

  test("a floor-feeding extended finding says it is not counted when ownership is renounced", async () => {
    const finding = extendedFinding(
      "dev.brandklipparen.blacklist",
      { fact: "blacklist", proof: "extended" },
      "The owner can stop chosen wallets from sending tokens. Found by extended analysis; not counted in the score.",
    );
    const envelope = await analyse(
      ownerSlotTokenHex(),
      new Map([[ZERO_SLOT, ZERO_WORD]]),
      new Map([[OWNER_FN, ZERO_WORD]]),
      "4309",
      stubDetectorSet("dev.brandklipparen.blacklist", finding),
    );
    expect(envelope.scoreFloor).toBeUndefined();
    const entry = envelope.pluginResults.find(
      (item) => (item.pluginId as string) === "dev.brandklipparen.blacklist",
    );
    expect(entry?.findings[0]?.title).toContain("not counted because ownership is renounced");
    expect(entry?.findings[0]?.title).not.toContain("not counted in the score");
  });
});
