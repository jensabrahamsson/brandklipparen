// Unique signal ids at the envelope and assessment boundary (C-27,
// F-25): findings sharing one first selector convert to distinct ids, the
// ids stay stable across runs and enrichment rebuilds, and assessment
// claim links cite the real converted ids. Synthetic bytecode and probe
// detectors only; no network.
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
  ModelId,
  ModelVersion,
  PromptVersion,
  RequestId,
  Selector,
  SignalId,
  Slot,
  TemplateVersion,
  Timestamp,
} from "../../src/domain/types.ts";
import type { Result } from "../../src/domain/result.ts";
import { Evidence } from "../../src/domain/evidence.ts";
import { Signal } from "../../src/domain/signals.ts";
import type { CapabilityCatalogue } from "../../src/domain/signals.ts";
import { parseModelArtifact } from "../../src/domain/risk.ts";
import type { LoadedArtifact } from "../../src/ports/modelArtifact.ts";
import { PLUGIN_API_VERSION, PluginManifest } from "../../src/plugins/api.ts";
import type { DetectorManifest } from "../../src/plugins/api.ts";
import { buildPluginRegistry } from "../../src/plugins/registry.ts";
import type { DetectorPlugin, PluginFinding } from "../../src/plugins/detector.ts";
import type { CodeHash as CodeHashType } from "../../src/domain/types.ts";
import {
  createAssessmentService,
  createInMemoryAssessmentCache,
  createInMemoryAssessmentCostMeter,
} from "../../src/application/assessmentService.ts";
import { validateAssessmentOutput } from "../../src/adapters/assessment/validateAssessment.ts";
import { EvidenceList } from "../../src/ports/assessmentModel.ts";
import { FakeAssessmentModelAdapter } from "../fakes/fakeAssessmentModel.ts";
import { FakeClockAdapter } from "../fakes/fakeClock.ts";
import { FakeDecompilerAdapter } from "../fakes/fakeDecompiler.ts";
import { FakeModelArtifactAdapter } from "../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../fakes/fakeRpc.ts";
import { tokenBytecode } from "../helpers/ownerControlFixtures.ts";

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
const OWNER_RAW = "0x1112131415161718191a1b1c1d1e1f2021222324";
const BLOCK = 24000000;
const FIRST_SELECTOR = "0xa9059cbb";
const OWNER_SELECTOR = "0x8da5cb5b";
// One dispatcher window with a SELFDESTRUCT body: the entry selector is
// the first dispatcher selector.
const SMALL_BYTECODE = "0x8063a9059cbb14600a575bff00";

function placeholderLoadedArtifact(
  version: string,
  pluginWeights: Record<string, number> = {},
  pluginFeatureCatalogue: Record<string, { risk: string; direction: string; severity: string }> = {},
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
      pluginFeatureCatalogue,
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
    displayName: "C-27 signal-id probe",
    description: "Synthetic probe for unique signal ids.",
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

// One probe detector emitting one `feature` finding on the shared
// selector, so three probes reproduce the USDT shape of three honeypot
// signals on one first selector.
function featureProbe(
  pluginId: string,
  findingId: string,
  payload: { readonly feature: string; readonly slot?: number | undefined },
  selector: string,
): DetectorPlugin {
  const manifest = probeManifest(pluginId);
  const body =
    payload.slot === undefined ? { feature: payload.feature } : { feature: payload.feature, slot: payload.slot };
  return Object.freeze({
    manifest,
    detect: (): readonly PluginFinding[] => {
      const evidence = Evidence.create({ selector: mustOk(Selector.parse(selector)) });
      if (!evidence.ok) {
        throw new Error("probe evidence failed to build");
      }
      return Object.freeze([
        Object.freeze({
          id: findingId,
          pluginId: manifest.id,
          title: `C-27 probe finding ${findingId}`,
          evidence: Object.freeze([evidence.value]) as unknown as PluginFinding["evidence"],
          payload: Object.freeze(body),
        }),
      ]);
    },
  });
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

const HONEYPOT_HIGH = { risk: "honeypot", direction: "raises", severity: "high" } as const;

function usdtShapedProbes(): {
  detectors: DetectorSet;
  weights: Record<string, number>;
  catalogue: Record<string, { risk: string; direction: string; severity: string }>;
  findings: { pluginId: string; findingId: string }[];
} {
  const findings = [
    {
      pluginId: "dev.brandklipparen.c27-blacklist",
      findingId: "dev.brandklipparen.c27-blacklist:blacklist",
      feature: "blacklist",
    },
    {
      pluginId: "dev.brandklipparen.c27-pause",
      findingId: "dev.brandklipparen.c27-pause:pause",
      feature: "pause",
    },
    {
      pluginId: "dev.brandklipparen.c27-sell-block",
      findingId: "dev.brandklipparen.c27-sell-block:sell-block",
      feature: "sell-block",
    },
  ];
  const plugins = findings.map((entry) =>
    featureProbe(entry.pluginId, entry.findingId, { feature: entry.feature }, FIRST_SELECTOR),
  );
  const registry = mustOk(buildPluginRegistry(plugins));
  const weights: Record<string, number> = {};
  const catalogue: Record<string, { risk: string; direction: string; severity: string }> = {};
  for (const entry of findings) {
    weights[entry.pluginId] = 1;
    catalogue[entry.pluginId] = { ...HONEYPOT_HIGH };
  }
  return { detectors: Object.freeze({ registry }), weights, catalogue, findings };
}

function expectedKeyId(
  codeHash: CodeHashType,
  pluginId: string,
  findingId: string,
  risk: string,
): string {
  return mustOk(
    SignalId.ofKey(codeHash, `${pluginId}|${findingId}|${risk}|${FIRST_SELECTOR}:none`),
  ) as string;
}

describe("unique signal ids (C-27)", () => {
  test("c27_same_selector_findings_get_distinct_ids", async () => {
    const shaped = usdtShapedProbes();
    const block = mustOk(BlockNumber.of(BLOCK));
    const services = createAppServices(
      {
        rpc: new FakeRpcAdapter(new Map([[TARGET, SMALL_BYTECODE]]), block),
        modelArtifacts: new FakeModelArtifactAdapter(
          placeholderLoadedArtifact("0.1.0", shaped.weights, shaped.catalogue),
        ),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      },
      shaped.detectors,
    );
    const analysed = await services.analyzeToken(analyzeInput("0.1.0"));
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    const envelope = analysed.value.envelope;
    expect(envelope.signals).toHaveLength(3);
    const ids = envelope.signals.map((signal) => signal.id as string);
    // Three findings on one first selector give three distinct ids.
    expect(new Set(ids).size).toBe(3);
    const wanted = new Set(
      shaped.findings.map((entry) =>
        expectedKeyId(envelope.codeHash, entry.pluginId, entry.findingId, "honeypot"),
      ),
    );
    expect(new Set(ids)).toEqual(wanted);
    // None keeps the legacy colliding id: before the fix every signal
    // carried keccak(codeHash, first selector).
    const legacy = mustOk(SignalId.of(envelope.codeHash, mustOk(Selector.parse(FIRST_SELECTOR)))) as string;
    expect(ids).not.toContain(legacy);
  });

  test("c27_ids_stable_across_runs_and_input_order", async () => {
    const code = mustOk(Bytecode.parse("0x6001600055"));
    const codeHash = mustOk(CodeHash.of(code));
    const first = mustOk(Selector.parse("0xa9059cbb"));
    const second = mustOk(Selector.parse("0x70a08231"));
    const entryFor = (selector: typeof first) => mustOk(Evidence.create({ selector }));
    const discriminator = "dev.brandklipparen.c27-blacklist|dev.brandklipparen.c27-blacklist:blacklist|honeypot|0xa9059cbb:none";
    const ordered = mustOk(
      Signal.createCapability({
        codeHash,
        risk: "honeypot",
        direction: "raises",
        severity: "high",
        temporality: { kind: "can-change-unknown" },
        evidence: [entryFor(first), entryFor(second)],
        discriminator,
      }),
    );
    const reordered = mustOk(
      Signal.createCapability({
        codeHash,
        risk: "honeypot",
        direction: "raises",
        severity: "high",
        temporality: { kind: "can-change-unknown" },
        evidence: [entryFor(second), entryFor(first)],
        discriminator,
      }),
    );
    // Evidence input order never moves the discriminated id.
    expect(reordered.id).toBe(ordered.id);
    expect(ordered.id as string).toBe(mustOk(SignalId.ofKey(codeHash, discriminator)) as string);
    // keepId wins over both the discriminator and the legacy formula.
    const kept = mustOk(
      Signal.createCapability({
        codeHash,
        risk: "rug-pull",
        direction: "lowers",
        severity: "low",
        temporality: { kind: "can-change-unknown" },
        evidence: [entryFor(second)],
        discriminator: "another-discriminator",
        keepId: ordered.id,
      }),
    );
    expect(kept.id).toBe(ordered.id);
    // A different discriminator gives a different id, and the legacy
    // formula stays available for directly constructed signals.
    const other = mustOk(
      Signal.createCapability({
        codeHash,
        risk: "honeypot",
        direction: "raises",
        severity: "high",
        temporality: { kind: "can-change-unknown" },
        evidence: [entryFor(first)],
        discriminator: `${discriminator}:2`,
      }),
    );
    expect(other.id as string).not.toBe(ordered.id as string);
    const legacy = mustOk(
      Signal.createCapability({
        codeHash,
        risk: "honeypot",
        direction: "raises",
        severity: "high",
        temporality: { kind: "can-change-unknown" },
        evidence: [entryFor(first)],
      }),
    );
    expect(legacy.id as string).toBe(mustOk(SignalId.of(codeHash, first)) as string);
    // End to end: two full analyses give byte-identical signal id lists.
    const shaped = usdtShapedProbes();
    const block = mustOk(BlockNumber.of(BLOCK));
    const analyseOnce = async (): Promise<readonly string[]> => {
      const services = createAppServices(
        {
          rpc: new FakeRpcAdapter(new Map([[TARGET, SMALL_BYTECODE]]), block),
          modelArtifacts: new FakeModelArtifactAdapter(
            placeholderLoadedArtifact("0.1.0", shaped.weights, shaped.catalogue),
          ),
          clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
        },
        shaped.detectors,
      );
      const analysed = await services.analyzeToken(analyzeInput("0.1.0"));
      if (!analysed.ok || analysed.value.kind !== "assessed") {
        throw new Error("expected an assessed envelope");
      }
      return analysed.value.envelope.signals.map((signal) => signal.id as string);
    };
    expect(await analyseOnce()).toEqual(await analyseOnce());
  });

  test("c27_enrichment_keeps_ids", async () => {
    // Snippets: the decompiler rebuild attaches a snippet to every entry
    // while the converted ids stay byte-identical.
    const shaped = usdtShapedProbes();
    const block = mustOk(BlockNumber.of(BLOCK));
    const decompiled = createAppServices(
      {
        rpc: new FakeRpcAdapter(new Map([[TARGET, SMALL_BYTECODE]]), block),
        modelArtifacts: new FakeModelArtifactAdapter(
          placeholderLoadedArtifact("0.1.0", shaped.weights, shaped.catalogue),
        ),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
        decompiler: new FakeDecompilerAdapter({ scenario: "success" }),
      },
      shaped.detectors,
    );
    const enriched = await decompiled.analyzeToken(analyzeInput("0.1.0"));
    expect(enriched.ok).toBe(true);
    if (!enriched.ok || enriched.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    const envelope = enriched.value.envelope;
    expect(envelope.signals).toHaveLength(3);
    for (const signal of envelope.signals) {
      for (const entry of signal.evidence) {
        expect(entry.snippet).toBeDefined();
      }
    }
    expect(new Set(envelope.signals.map((signal) => signal.id as string))).toEqual(
      new Set(
        shaped.findings.map((entry) =>
          expectedKeyId(envelope.codeHash, entry.pluginId, entry.findingId, "honeypot"),
        ),
      ),
    );
    // Owner state: both the applies-now rebuild and the changer rename
    // keep the converted ids.
    const ownerPlugin = "dev.brandklipparen.ownership";
    const pausePlugin = "dev.brandklipparen.c27-pause";
    const pauseFinding = `${pausePlugin}:pause`;
    const ownership = featureProbe(
      ownerPlugin,
      `${ownerPlugin}:owner-slot`,
      { feature: "owner-slot", slot: 0 },
      FIRST_SELECTOR,
    );
    const pause = featureProbe(pausePlugin, pauseFinding, { feature: "pause" }, FIRST_SELECTOR);
    const registry = mustOk(buildPluginRegistry([ownership, pause]));
    const owner = mustOk(Address.parse(OWNER_RAW));
    const ownerWord = `0x${"0".repeat(24)}${(OWNER_RAW.slice(2)).toLowerCase()}`;
    const slotKey = (mustOk(Slot.parse(`0x${"0".repeat(64)}`)) as string).toLowerCase();
    const ownerCode = tokenBytecode([
      { selector: OWNER_SELECTOR, body: [0x00] },
      { selector: FIRST_SELECTOR, body: [0x00] },
    ]);
    const ownerHex = `0x${Buffer.from(ownerCode).toString("hex")}`;
    const owned = createAppServices(
      {
        rpc: new FakeRpcAdapter(
          new Map([[TARGET, ownerHex]]),
          block,
          new Map([[TARGET, new Map([[slotKey, ownerWord]])]]),
          { calls: new Map([[OWNER_SELECTOR, ownerWord]]) },
        ),
        modelArtifacts: new FakeModelArtifactAdapter(
          placeholderLoadedArtifact(
            "0.1.0",
            { [ownerPlugin]: 1, [pausePlugin]: 1 },
            {
              [ownerPlugin]: { risk: "rug-pull", direction: "raises", severity: "high" },
              [pausePlugin]: { ...HONEYPOT_HIGH },
            },
          ),
        ),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      },
      Object.freeze({ registry }),
    );
    const stated = await owned.analyzeToken(analyzeInput("0.1.0"));
    expect(stated.ok).toBe(true);
    if (!stated.ok || stated.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    const ownedEnvelope = stated.value.envelope;
    expect(ownedEnvelope.signals).toHaveLength(2);
    const ownerId = mustOk(
      SignalId.ofKey(
        ownedEnvelope.codeHash,
        `${ownerPlugin}|${ownerPlugin}:owner-slot|rug-pull|${FIRST_SELECTOR}:none`,
      ),
    ) as string;
    const pauseId = mustOk(
      SignalId.ofKey(
        ownedEnvelope.codeHash,
        `${pausePlugin}|${pauseFinding}|honeypot|${FIRST_SELECTOR}:none`,
      ),
    ) as string;
    const byId = new Map(ownedEnvelope.signals.map((signal) => [signal.id as string, signal]));
    expect(byId.has(ownerId)).toBe(true);
    expect(byId.has(pauseId)).toBe(true);
    // The rebuilds ran: the owner signal holds the live value and the
    // gated pause signal names the proven owner as its changer.
    const ownerSignal = byId.get(ownerId);
    expect(ownerSignal?.kind).toBe("capability");
    if (ownerSignal?.kind !== "capability") {
      throw new Error("expected the owner signal to convert");
    }
    expect(ownerSignal.temporality.kind).toBe("applies-now");
    const pauseSignal = byId.get(pauseId);
    expect(pauseSignal?.kind).toBe("capability");
    if (pauseSignal?.kind !== "capability") {
      throw new Error("expected the pause signal to convert");
    }
    expect(pauseSignal.temporality).toEqual({
      kind: "can-change",
      changer: owner,
    });
  });

  test("c27_assessment_links_use_real_ids", async () => {
    const shaped = usdtShapedProbes();
    const block = mustOk(BlockNumber.of(BLOCK));
    const services = createAppServices(
      {
        rpc: new FakeRpcAdapter(new Map([[TARGET, SMALL_BYTECODE]]), block),
        modelArtifacts: new FakeModelArtifactAdapter(
          placeholderLoadedArtifact("0.1.0", shaped.weights, shaped.catalogue),
        ),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      },
      shaped.detectors,
    );
    const fake = new FakeAssessmentModelAdapter({ provider: "meta-model-api", modelId: "fake-meta-spark-1" });
    const assessment = createAssessmentService({
      analyze: services.analyzeToken,
      adapter: fake,
      promptVersion: mustOk(PromptVersion.parse("1.0.0")),
      dailyCapPerKey: 100,
      cache: createInMemoryAssessmentCache(),
      meter: createInMemoryAssessmentCostMeter(),
    });
    const requested = await assessment.requestForToken({
      ...analyzeInput("0.1.0"),
      apiKeyId: "key-1",
      day: "2026-10-27",
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok || requested.value.kind !== "assessed") {
      throw new Error("expected an assessed outcome");
    }
    // The fake cites the first carried link, so a non-null assessment
    // proves the validator kept the real converted id.
    expect(requested.value.assessment).not.toBe(null);
    const last = fake.lastRequest;
    if (last === undefined) {
      throw new Error("expected the fake to record its request");
    }
    const envelopeIds = requested.value.envelope.signals.map((signal) => signal.id as string);
    expect(envelopeIds).toHaveLength(3);
    expect(new Set(envelopeIds).size).toBe(3);
    expect(last.evidence.links?.map((link) => link as string)).toEqual(envelopeIds);
    // The legacy selector-derived id no longer cites any signal once the
    // real links travel beside the evidence ...
    const legacy = mustOk(
      SignalId.of(requested.value.envelope.codeHash, mustOk(Selector.parse(FIRST_SELECTOR))),
    ) as string;
    expect(envelopeIds).not.toContain(legacy);
    const modelId = mustOk(ModelId.parse("fake-meta-spark-1"));
    const expectation = {
      provider: "meta-model-api" as const,
      modelId,
      promptVersion: mustOk(PromptVersion.parse("1.0.0")),
      maxOutputChars: 4000,
    };
    const claimFor = (link: string): Record<string, unknown> => ({
      provider: "meta-model-api",
      modelId: "fake-meta-spark-1",
      promptVersion: "1.0.0",
      explanationVersion: "1.0.0",
      text: "Placeholder assessment text for tests only.",
      claims: [
        {
          text: "Placeholder claim linked to the request evidence.",
          signalLinks: [link],
          temporality: { kind: "can-change-unknown" },
        },
      ],
    });
    const rejected = validateAssessmentOutput(claimFor(legacy), last.evidence, expectation);
    expect(rejected.ok).toBe(false);
    const kept = validateAssessmentOutput(
      claimFor((last.evidence.links?.[0] ?? "") as string),
      last.evidence,
      expectation,
    );
    expect(kept.ok).toBe(true);
    // ... while lists without links keep the legacy derivation, so
    // directly constructed evidence still validates.
    const unlinked = mustOk(
      EvidenceList.create(last.evidence.codeHash, last.evidence.evidence),
    );
    expect(validateAssessmentOutput(claimFor(legacy), unlinked, expectation).ok).toBe(true);
  });
});
