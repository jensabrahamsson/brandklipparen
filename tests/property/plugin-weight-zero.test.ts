// Property: plugin findings leave probabilities and score unchanged (S-046,
// P-05). Detection runs through the registry at weight 0: scoring reads
// solely the converted signals, so adding a detector that always reports a
// finding changes `pluginResults` but never probabilities, score or
// signals. Written first (red) per A-21. All ports are in-memory fakes; no
// network happens in this test.
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { parseModelArtifact } from "../../src/domain/risk.ts";
import type { Result } from "../../src/domain/result.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  Bytecode,
  CodeHash,
  IndexVersion,
  ModelVersion,
  RequestId,
  TemplateVersion,
  Timestamp,
} from "../../src/domain/types.ts";
import type {
  Address as AddressType,
  BlockNumber as BlockNumberType,
} from "../../src/domain/types.ts";
import type { CapabilityCatalogue } from "../../src/domain/signals.ts";
import { createAppServices } from "../../src/application/analyzeToken.ts";
import type { AppServices, DetectorSet } from "../../src/application/analyzeToken.ts";
import {
  DEFAULT_DETECTOR_PLUGINS,
  buildPluginRegistry,
} from "../../src/plugins/registry.ts";
import { mustDefaultDetectorSet } from "../helpers/detectorSets.ts";
import { PluginManifest } from "../../src/plugins/api.ts";
import type { DetectorManifest } from "../../src/plugins/api.ts";
import type { DetectorInput, DetectorPlugin, PluginFinding } from "../../src/plugins/detector.ts";
import { Evidence } from "../../src/domain/evidence.ts";
import type { Evidence as EvidenceType, NonEmpty } from "../../src/domain/evidence.ts";
import { Selector } from "../../src/domain/types.ts";
import type { LoadedArtifact } from "../../src/ports/modelArtifact.ts";
import { FakeClockAdapter } from "../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../fakes/fakeRpc.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function placeholderLoadedArtifact(): LoadedArtifact {
  const artifact = mustOk(
    parseModelArtifact({
      version: "0.1.0",
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
    }),
  );
  return Object.freeze({
    artifact,
    checksum: mustOk(ArtifactChecksum.parse("ab".repeat(32))),
  });
}

const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

// A test-only detector that always reports one finding with valid
// evidence, registered solely in the local set below. Production never
// sees it: the default registry is untouched.
const EXTRA_MANIFEST_PARSED = mustOk(
  PluginManifest.parse({
    id: "dev.brandklipparen.test-extra",
    version: "1.0.0",
    kind: "detector",
    apiVersion: "1.0.0",
    displayName: "Test extra detector",
    description: "Test-only detector that always reports one finding.",
    inputs: ["bytecode"],
    docs: "PLUGIN.md",
    outputSchema: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        required: ["id", "pluginId", "title", "payload", "evidence"],
        properties: {
          id: { type: "string", minLength: 1 },
          pluginId: { const: "dev.brandklipparen.test-extra" },
          title: { type: "string", minLength: 1 },
          payload: {
            type: "object",
            required: ["marker"],
            properties: { marker: { type: "string", minLength: 1 } },
            additionalProperties: false,
          },
          evidence: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["selector"],
              properties: {
                selector: { type: "string", minLength: 1 },
                offset: { type: ["integer", "null"], minimum: 0 },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
    capabilities: {
      needsNetwork: false,
      needsSecrets: false,
      affectsScore: false,
      runsInFastPath: true,
    },
    limits: { maxFindings: 4, maxEvidencePerFinding: 4, maxOutputBytes: 4096 },
  }),
);

if (EXTRA_MANIFEST_PARSED.kind !== "detector") {
  throw new Error("test extra manifest carries the wrong kind");
}
const EXTRA_MANIFEST: DetectorManifest = EXTRA_MANIFEST_PARSED;

const EXTRA_PLUGIN: DetectorPlugin = Object.freeze({
  manifest: EXTRA_MANIFEST,
  detect: (input: DetectorInput): readonly PluginFinding[] => {
    void input;
    const evidence = mustOk(Evidence.create({ selector: mustOk(Selector.parse("0xa9059cbb")) }));
    const finding: PluginFinding = {
      id: "dev.brandklipparen.test-extra:always",
      pluginId: EXTRA_MANIFEST.id,
      title: "Test extra finding present on every input",
      evidence: Object.freeze([evidence]) as NonEmpty<EvidenceType>,
      payload: Object.freeze({ marker: "extra" }),
    };
    return Object.freeze([finding]);
  },
});

function extendedDetectorSet(): DetectorSet {
  const plugins = [...DEFAULT_DETECTOR_PLUGINS, EXTRA_PLUGIN] as readonly DetectorPlugin[];
  const registry = mustOk(buildPluginRegistry(plugins));
  return Object.freeze({ registry });
}

// A test-only detector that emits a real capability payload
// (`selfdestruct`) from an unlisted plugin id. Scoring must ignore it:
// only first-party scoring plugins and artifact-named plugins convert.
const EVIL_MANIFEST_PARSED = mustOk(
  PluginManifest.parse({
    id: "dev.brandklipparen.test-evil",
    version: "1.0.0",
    kind: "detector",
    apiVersion: "1.0.0",
    displayName: "Test evil detector",
    description: "Test-only detector that emits an unlisted capability finding.",
    inputs: ["bytecode"],
    docs: "PLUGIN.md",
    outputSchema: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        required: ["id", "pluginId", "title", "payload", "evidence"],
        properties: {
          id: { type: "string", minLength: 1 },
          pluginId: { const: "dev.brandklipparen.test-evil" },
          title: { type: "string", minLength: 1 },
          payload: {
            type: "object",
            required: ["capability"],
            properties: { capability: { type: "string", minLength: 1 } },
            additionalProperties: false,
          },
          evidence: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["selector"],
              properties: {
                selector: { type: "string", minLength: 1 },
                offset: { type: ["integer", "null"], minimum: 0 },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
    capabilities: {
      needsNetwork: false,
      needsSecrets: false,
      affectsScore: false,
      runsInFastPath: true,
    },
    limits: { maxFindings: 4, maxEvidencePerFinding: 4, maxOutputBytes: 4096 },
  }),
);

if (EVIL_MANIFEST_PARSED.kind !== "detector") {
  throw new Error("test evil manifest carries the wrong kind");
}
const EVIL_MANIFEST: DetectorManifest = EVIL_MANIFEST_PARSED;

const EVIL_PLUGIN: DetectorPlugin = Object.freeze({
  manifest: EVIL_MANIFEST,
  detect: (input: DetectorInput): readonly PluginFinding[] => {
    void input;
    const evidence = mustOk(Evidence.create({ selector: mustOk(Selector.parse("0xa9059cbb")) }));
    const finding: PluginFinding = {
      id: "dev.brandklipparen.test-evil:selfdestruct",
      pluginId: EVIL_MANIFEST.id,
      title: "Test evil capability finding present on every input",
      evidence: Object.freeze([evidence]) as NonEmpty<EvidenceType>,
      payload: Object.freeze({ capability: "selfdestruct" }),
    };
    return Object.freeze([finding]);
  },
});

function evilDetectorSet(): DetectorSet {
  const plugins = [...DEFAULT_DETECTOR_PLUGINS, EVIL_PLUGIN] as readonly DetectorPlugin[];
  const registry = mustOk(buildPluginRegistry(plugins));
  return Object.freeze({ registry });
}

function buildServices(bytecodeHex: string, address: AddressType, block: BlockNumberType): AppServices {
  const codes = new Map<string, string>([[address as string, bytecodeHex]]);
  return createAppServices({
    rpc: new FakeRpcAdapter(codes, block),
    modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact()),
    clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
  },
  mustDefaultDetectorSet());
}

function hexArb(length: number): fc.Arbitrary<string> {
  return fc
    .array(fc.integer({ min: 0, max: 15 }), { minLength: length, maxLength: length })
    .map((digits) => digits.map((digit) => (digit as number).toString(16)).join(""));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += (byte ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

const dispatcherBytecodeArb: fc.Arbitrary<string> = fc
  .tuple(hexArb(8), fc.constantFrom("ff", "f4", "f1", "55"))
  .map(([selector, capability]) => `0x8063${selector}14600a57${"00".repeat(10)}${capability}`);

const randomBytecodeArb: fc.Arbitrary<string> = fc
  .uint8Array({ minLength: 16, maxLength: 64 })
  .map((bytes) => `0x${bytesToHex(bytes)}`);

const REQUEST_ID = "123e4567-e89b-12d3-a456-426614174000";

describe("plugin findings leave score and probabilities unchanged", () => {
  test("plugin_findings_leave_probabilities_and_score_unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(
        hexArb(40),
        fc.oneof(dispatcherBytecodeArb, randomBytecodeArb),
        async (addressBody, bytecodeHex) => {
          const rawAddress = `0x${addressBody}`;
          const address = mustOk(Address.parse(rawAddress));
          const bytecode = mustOk(Bytecode.parse(bytecodeHex));
          const codeHash = mustOk(CodeHash.of(bytecode));
          void codeHash;
          const block = mustOk(BlockNumber.of(18000000));
          const input = {
            address,
            block,
            requestId: mustOk(RequestId.parse(REQUEST_ID)),
            deadline: mustOk(Timestamp.of(1700000005000)),
            modelVersion: mustOk(ModelVersion.parse("0.1.0")),
            indexVersion: mustOk(IndexVersion.parse("0.1.0")),
            templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
            catalogue: TEST_CATALOGUE,
          };
          const base = buildServices(bytecodeHex, address, block);
          const extended = createAppServices(
            {
              rpc: new FakeRpcAdapter(
                new Map<string, string>([[address as string, bytecodeHex]]),
                block,
              ),
              modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact()),
              clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
            },
            extendedDetectorSet(),
          );
          const [plain, withExtra] = await Promise.all([
            base.analyzeToken(input),
            extended.analyzeToken(input),
          ]);
          expect(plain.ok && plain.value.kind === "assessed").toBe(true);
          expect(withExtra.ok && withExtra.value.kind === "assessed").toBe(true);
          if (
            !plain.ok ||
            plain.value.kind !== "assessed" ||
            !withExtra.ok ||
            withExtra.value.kind !== "assessed"
          ) {
            return;
          }
          const left = plain.value.envelope;
          const right = withExtra.value.envelope;
          expect(right.probabilities).toEqual(left.probabilities);
          expect(right.score).toBe(left.score);
          expect(right.signals).toEqual(left.signals);
          expect(right.explanation).toEqual(left.explanation);
          expect(right.pluginResults.length).toBe(left.pluginResults.length + 1);
          expect(
            right.pluginResults.some((entry) => entry.pluginId === EXTRA_MANIFEST.id),
          ).toBe(true);
        },
      ),
      { numRuns: 25 },
    );
  });

  test("default detector set carries no test-only plugin", () => {
    expect(
      mustDefaultDetectorSet().registry.entries.some(
        (entry) => entry.manifest.id === EXTRA_MANIFEST.id,
      ),
    ).toBe(false);
  });

  test("unlisted_plugin_capability_finding_leaves_score_unchanged", async () => {
    const address = mustOk(Address.parse("0x0a0b0c0d0e0f1011121314151617181920212223"));
    const bytecodeHex = "0x8063a9059cbb1461005b57ff";
    const block = mustOk(BlockNumber.of(18000000));
    const input = {
      address,
      block,
      requestId: mustOk(RequestId.parse(REQUEST_ID)),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustOk(ModelVersion.parse("0.1.0")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    };
    const base = buildServices(bytecodeHex, address, block);
    const extended = createAppServices(
      {
        rpc: new FakeRpcAdapter(new Map<string, string>([[address as string, bytecodeHex]]), block),
        modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact()),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      },
      evilDetectorSet(),
    );
    const [plain, withEvil] = await Promise.all([base.analyzeToken(input), extended.analyzeToken(input)]);
    expect(plain.ok && plain.value.kind === "assessed").toBe(true);
    expect(withEvil.ok && withEvil.value.kind === "assessed").toBe(true);
    if (
      !plain.ok ||
      plain.value.kind !== "assessed" ||
      !withEvil.ok ||
      withEvil.value.kind !== "assessed"
    ) {
      return;
    }
    const left = plain.value.envelope;
    const right = withEvil.value.envelope;
    expect(right.probabilities).toEqual(left.probabilities);
    expect(right.score).toBe(left.score);
    expect(right.signals).toEqual(left.signals);
    expect(right.pluginResults.length).toBe(left.pluginResults.length + 1);
    expect(
      right.pluginResults.some((entry) => entry.pluginId === EVIL_MANIFEST.id),
    ).toBe(true);
  });
});
