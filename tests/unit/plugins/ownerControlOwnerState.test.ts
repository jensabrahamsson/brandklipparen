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
import type { AssessmentEnvelope } from "../../../src/application/analyzeToken.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { FileModelArtifactAdapter } from "../../../src/adapters/model/fileArtifact.ts";
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
    // `owner()` getter the proof calls back: a slot word alone never
    // proves an owner, so the enriched read needs a dispatched getter
    // (same selector as OWNER_FN below).
    { selector: "0x8da5cb5b", body: [STOP] },
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
      // The dispatched `owner()` getter repeats the slot word, which is
      // what proves it as the owner under the P-2 follow-up rule.
      { calls: new Map([["0x8da5cb5b", OWNER_WORD]]) },
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

// P-2 owner address truth (RC-3): never show an address that is not a
// proven owner. This block appends to the S-115 suite without touching
// its earlier tests. The gated token carries a privileged mint finding
// and dispatches `owner()`, so the service cross-checks the owner slot
// against the getter before naming any changer anywhere.
const OWNER_FN = "0x8da5cb5b";
const MINT = "0x40c10f19";

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

function gatedTransferBody(): number[] {
  return [CALLDATALOAD, ...push1(1), SLOAD, ADD, ...sstoreConstSlot(2, [CALLDATALOAD]), STOP];
}

function gatedTokenHex(): string {
  const bytecode = tokenBytecode([
    { selector: MINT, body: mintBody() },
    { selector: TRANSFER, body: gatedTransferBody() },
    { selector: OWNER_FN, body: [STOP] },
  ]);
  return `0x${Buffer.from(bytecode).toString("hex")}`;
}

function gatedArtifact(): FakeModelArtifactAdapter {
  const artifact = mustOk(
    parseModelArtifact({
      version: "0.1.0-gated.test",
      severityWeights: { low: 0.2, medium: 0.5, high: 1.0 },
      causeWeights: { timeout: 0.4, "resource-limit": 0.4, "decompiler-error": 0.6, "obfuscated-structure": 0.6 },
      biases: { "rug-pull": 0.0, honeypot: 0.0, "bot-pump": 0.0 },
      calibration: {
        "rug-pull": { slope: 1.0, intercept: 0.0 },
        honeypot: { slope: 1.0, intercept: 0.0 },
        "bot-pump": { slope: 1.0, intercept: 0.0 },
      },
      scoreWeights: { "rug-pull": 1.0, honeypot: 1.0, "bot-pump": 1.0 },
      pluginWeights: { "dev.brandklipparen.mint": 0.9, "dev.brandklipparen.ownership": 0.9 },
      pluginFeatureCatalogue: {
        "dev.brandklipparen.mint": { risk: "rug-pull", direction: "raises", severity: "high" },
        "dev.brandklipparen.ownership": { risk: "rug-pull", direction: "raises", severity: "high" },
      },
    }),
  );
  return new FakeModelArtifactAdapter(
    Object.freeze({ artifact, checksum: mustOk(ArtifactChecksum.parse("cd".repeat(32))) }),
  );
}

const OWNER_A = syntheticAddress(21);
const OWNER_B = syntheticAddress(22);

function addressWord(owner: string): string {
  return `0x${"0".repeat(24)}${owner.slice(2).toLowerCase()}`;
}

function poisonedWord(owner: string): string {
  return `0x${"ab".repeat(12)}${owner.slice(2).toLowerCase()}`;
}

function eip55(owner: string): string {
  return mustOk(Address.parse(owner)) as string;
}

function noGetterTokenHex(): string {
  // Same privileged mint shape as the gated token but with no `owner()`
  // or `getOwner()` dispatch, so no getter can ever prove the slot.
  const bytecode = tokenBytecode([
    { selector: MINT, body: mintBody() },
    { selector: TRANSFER, body: gatedTransferBody() },
  ]);
  return `0x${Buffer.from(bytecode).toString("hex")}`;
}

async function analyseGatedOwnerState(
  slotWords: ReadonlyMap<string, string>,
  calls: ReadonlyMap<string, string>,
  requestTail: string,
  bytecodeHex: string = gatedTokenHex(),
): Promise<AssessmentEnvelope> {
  const target = mustOk(Address.parse(syntheticAddress(31)));
  const block = mustOk(BlockNumber.of(24000000));
  const rpc = new FakeRpcAdapter(
    new Map<string, string>([[target as string, bytecodeHex]]),
    block,
    new Map<string, ReadonlyMap<string, string>>([[target as string, slotWords]]),
    { calls },
  );
  const services = createAppServices(
    {
      rpc,
      modelArtifacts: gatedArtifact(),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
    mustDefaultDetectorSet(),
  );
  const analysed = await services.analyzeToken({
    address: target,
    block,
    requestId: mustOk(RequestId.parse(`123e4567-e89b-12d3-a456-42661417${requestTail}`)),
    deadline: mustOk(Timestamp.of(1700000005000)),
    modelVersion: mustOk(ModelVersion.parse("0.1.0-gated.test")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    // 1.1.0 per-origin claims: the mint and owner-slot signals share one
    // signal id, so only the origin- and temporality-keyed merge keeps the
    // gated mint claim's changer text apart from the Holds-now owner claim.
    templateVersion: mustOk(TemplateVersion.parse("1.1.0")),
    catalogue: TEST_CATALOGUE,
  });
  expect(analysed.ok).toBe(true);
  if (!analysed.ok || analysed.value.kind !== "assessed") {
    throw new Error("expected an assessed envelope");
  }
  return analysed.value.envelope;
}

function gatedMintSignals(signals: readonly Signal[]): Signal[] {
  return signals.filter(
    (signal) =>
      signal.kind === "capability" &&
      signal.risk === "rug-pull" &&
      signal.severity === "high" &&
      signal.evidence.some((entry) => (entry.selector as string) === MINT) &&
      signal.evidence.some((entry) => (entry.selector as string) === TRANSFER),
  );
}

function botPumpSignals(signals: readonly Signal[]): Signal[] {
  return signals.filter((signal) => signal.kind === "capability" && signal.risk === "bot-pump");
}

function ownerStateSummary(envelope: AssessmentEnvelope): string {
  return JSON.stringify({
    score: envelope.score as number,
    probabilities: {
      "bot-pump": envelope.probabilities["bot-pump"] as number,
      honeypot: envelope.probabilities.honeypot as number,
      "rug-pull": envelope.probabilities["rug-pull"] as number,
    },
    ids: envelope.signals.map((signal) => signal.id as string).sort(),
  });
}

describe("owner address truth (P-2)", () => {
  test("a poisoned slot word names no changer and no address", async () => {
    const envelope = await analyseGatedOwnerState(
      new Map([[ZERO_SLOT, poisonedWord(OWNER_A)]]),
      new Map([[OWNER_FN, addressWord(OWNER_A)]]),
      "4201",
    );
    for (const signal of envelope.signals) {
      expect(signal.kind === "capability" ? signal.temporality.kind : "can-change-unknown").toBe(
        "can-change-unknown",
      );
    }
    for (const claim of envelope.explanation.claims) {
      expect(claim.text.toLowerCase().includes(OWNER_A.slice(2).toLowerCase())).toBe(false);
    }
  });

  test("slot and owner() disagreeing names no changer", async () => {
    const envelope = await analyseGatedOwnerState(
      new Map([[ZERO_SLOT, addressWord(OWNER_A)]]),
      new Map([[OWNER_FN, addressWord(OWNER_B)]]),
      "4202",
    );
    for (const signal of envelope.signals) {
      expect(signal.kind === "capability" ? signal.temporality.kind : "can-change-unknown").toBe(
        "can-change-unknown",
      );
    }
    for (const claim of envelope.explanation.claims) {
      expect(claim.text.toLowerCase().includes(OWNER_A.slice(2).toLowerCase())).toBe(false);
      expect(claim.text.toLowerCase().includes(OWNER_B.slice(2).toLowerCase())).toBe(false);
    }
  });

  test("agreement attaches the EIP-55 changer to the gated signal only", async () => {
    const envelope = await analyseGatedOwnerState(
      new Map([[ZERO_SLOT, addressWord(OWNER_A)]]),
      new Map([[OWNER_FN, addressWord(OWNER_A)]]),
      "4203",
    );
    const wanted = eip55(OWNER_A);
    const mint = gatedMintSignals(envelope.signals);
    expect(mint.length).toBeGreaterThan(0);
    for (const signal of mint) {
      if (signal.kind !== "capability") {
        throw new Error("expected capability mint signals");
      }
      expect(signal.temporality).toEqual({ kind: "can-change", changer: wanted });
    }
    const pumps = botPumpSignals(envelope.signals);
    expect(pumps.length).toBeGreaterThan(0);
    for (const signal of pumps) {
      if (signal.kind !== "capability") {
        throw new Error("expected capability bot-pump signals");
      }
      expect(signal.temporality).toEqual({ kind: "can-change-unknown" });
    }
    for (const signal of envelope.signals) {
      if (signal.kind === "capability" && signal.temporality.kind === "can-change") {
        expect(signal.temporality.changer as string).toBe(wanted);
      }
    }
    const now = envelope.signals.filter(
      (signal) => signal.kind === "capability" && signal.temporality.kind === "applies-now",
    );
    expect(now).toHaveLength(1);
    const first = now[0];
    if (first === undefined || first.kind !== "capability" || first.temporality.kind !== "applies-now") {
      throw new Error("expected one applies-now capability signal");
    }
    expect(first.temporality.measuredValue.value as string).toBe(addressWord(OWNER_A));
    expect(first.temporality.measuredValue.slot as string).toBe(ZERO_SLOT);
    const mintIds = new Set(mint.map((signal) => signal.id as string));
    // A signal id covers the code hash and the first evidence selector,
    // so the mint signal shares its id with the owner-slot signal and a
    // bare link match also sweeps in the Holds-now owner claim. The mint
    // signal's own claim is the one whose evidence spans the transfer
    // path, so it names both selectors in its pointers.
    const mintClaims = envelope.explanation.claims.filter(
      (claim) =>
        claim.signalLinks.some((link) => mintIds.has(link as string)) && claim.text.includes(TRANSFER),
    );
    expect(mintClaims.length).toBeGreaterThan(0);
    for (const claim of mintClaims) {
      expect(claim.text.includes(wanted)).toBe(true);
    }
  });

  test("score, probabilities and signal list stay bit-identical across owner states", async () => {
    const slotWord = new Map([[ZERO_SLOT, addressWord(OWNER_A)]]);
    const poison = new Map([[ZERO_SLOT, poisonedWord(OWNER_A)]]);
    const agree = new Map([[OWNER_FN, addressWord(OWNER_A)]]);
    const disagree = new Map([[OWNER_FN, addressWord(OWNER_B)]]);
    const silent = new Map<string, string>();
    const summaries: string[] = [];
    summaries.push(ownerStateSummary(await analyseGatedOwnerState(slotWord, agree, "4204")));
    summaries.push(ownerStateSummary(await analyseGatedOwnerState(slotWord, disagree, "4205")));
    summaries.push(ownerStateSummary(await analyseGatedOwnerState(poison, agree, "4206")));
    summaries.push(ownerStateSummary(await analyseGatedOwnerState(slotWord, silent, "4207")));
    summaries.push(ownerStateSummary(await analyseGatedOwnerState(silent, silent, "4208")));
    for (const summary of summaries) {
      expect(summary).toBe(summaries[0]);
    }
  });

  // SCORE-1: proven renounced ownership (slot and owner() both zero)
  // removes the floor the same proven mint would otherwise carry, while
  // an active proven owner keeps it. Signals stay changerless either way.
  test("score floor follows proven ownership state", async () => {
    const zeroWord = `0x${"0".repeat(64)}`;
    const renounced = await analyseGatedOwnerState(
      new Map([[ZERO_SLOT, zeroWord]]),
      new Map([[OWNER_FN, zeroWord]]),
      "4211",
    );
    expect(renounced.scoreFloor).toBeUndefined();
    const active = await analyseGatedOwnerState(
      new Map([[ZERO_SLOT, addressWord(OWNER_A)]]),
      new Map([[OWNER_FN, addressWord(OWNER_A)]]),
      "4212",
    );
    expect(active.score as number).toBeGreaterThanOrEqual(30);
    expect(active.scoreFloor?.label).toContain("mint");
  });

  test("an address-shaped slot word without a dispatched owner getter proves no owner", async () => {
    const envelope = await analyseGatedOwnerState(
      new Map([[ZERO_SLOT, addressWord(OWNER_A)]]),
      new Map<string, string>(),
      "4210",
      noGetterTokenHex(),
    );
    // The ownership finding and its signal stay as they are; only the
    // proof is missing, so every capability keeps changerless
    // temporality and no measured owner value is presented.
    expect(envelope.signals.length).toBeGreaterThan(0);
    for (const signal of envelope.signals) {
      expect(signal.kind === "capability" ? signal.temporality.kind : "can-change-unknown").toBe(
        "can-change-unknown",
      );
    }
    const now = envelope.signals.filter(
      (signal) => signal.kind === "capability" && signal.temporality.kind === "applies-now",
    );
    expect(now).toHaveLength(0);
    for (const claim of envelope.explanation.claims) {
      expect(claim.text.toLowerCase().includes(OWNER_A.slice(2).toLowerCase())).toBe(false);
    }
  });
});
