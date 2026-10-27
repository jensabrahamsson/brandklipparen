// S-051 example plugin test: the third-party-style example detector
// registers through a local registry only, reports a weight-0 finding in
// `pluginResults`, is listable with no interface code changed, and never
// enters the production default registry. Written first (red) per A-21:
// the example directory does not exist yet, so the imports fail until it
// lands. All ports are in-memory fakes; no outbound network happens here.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
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
import type { AppServices, DetectorSet } from "../../../src/application/analyzeToken.ts";
import {
  DEFAULT_DETECTOR_PLUGINS,
  DEFAULT_PLUGIN_REGISTRY,
  buildPluginRegistry,
  detectorPluginTable,
} from "../../../src/plugins/registry.ts";
import type { DetectorPlugin } from "../../../src/plugins/detector.ts";
import { SecretString } from "../../../src/ports/config.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { createRestServer } from "../../../src/interfaces/rest/server.ts";
import type { RestServer } from "../../../src/interfaces/rest/server.ts";
import { createMcpServer } from "../../../src/interfaces/mcp/server.ts";
import type { McpServer } from "../../../src/interfaces/mcp/server.ts";
import { feeCapabilityManifest } from "../../../examples/plugins/fee-capability/manifest.ts";
import { detectFeeCapability } from "../../../examples/plugins/fee-capability/detect.ts";

const EXAMPLE_ID = "dev.brandklipparen.example-fee-capability";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function placeholderArtifact(): FakeModelArtifactAdapter {
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
  return new FakeModelArtifactAdapter(
    Object.freeze({
      artifact,
      checksum: mustOk(ArtifactChecksum.parse("ef".repeat(32))),
    }),
  );
}

const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

// Frozen fixture: dispatcher exposing setFee(uint256) = 0x69fe0e2d.
const TEST_ADDRESS = "0x02030405060708090a0b0c0d0e0f101112131415";
const TEST_BYTECODE = "0x806369fe0e2d14600a578063a9059cbb1461005a57ff00";
const TEST_BLOCK = 18000000;
const TEST_API_KEY = "test-key-for-example-suite-only";
const TEST_PEPPER = "test-pepper-for-example-suite-only";

function exampleDetectorSet(): DetectorSet {
  const plugins = [
    ...DEFAULT_DETECTOR_PLUGINS,
    Object.freeze({ manifest: feeCapabilityManifest, detect: detectFeeCapability }),
  ] as readonly DetectorPlugin[];
  return Object.freeze({
    registry: mustOk(buildPluginRegistry(plugins.map((plugin) => plugin.manifest))),
    plugins: detectorPluginTable(plugins),
  });
}

function testServices(detectors?: DetectorSet): AppServices {
  const codes = new Map<string, string>([[mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE]]);
  return createAppServices(
    {
      rpc: new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK))),
      modelArtifacts: placeholderArtifact(),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
    detectors,
  );
}

function sharedOptions() {
  return {
    apiKeys: [new SecretString(TEST_API_KEY)] as readonly SecretString[],
    apiKeyPepper: new SecretString(TEST_PEPPER),
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
  };
}

describe("example plugin through a local registry (S-051)", () => {
  let rest: RestServer;
  let restBaseUrl: string;
  let mcp: McpServer;

  beforeAll(async () => {
    const detectors = exampleDetectorSet();
    const services = testServices(detectors);
    rest = createRestServer({ services, detectors, ...sharedOptions() });
    restBaseUrl = await rest.listen("127.0.0.1", 0);
    mcp = createMcpServer({ services, detectors, ...sharedOptions() });
  });

  afterAll(async () => {
    await rest.close();
  });

  test("example_plugin_registers_and_reports_weight_zero", async () => {
    const listed = await fetch(`${restBaseUrl}/v1/plugins`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as {
      plugins: readonly { id: string; weight: number }[];
    };
    const entry = listBody.plugins.find((item) => item.id === EXAMPLE_ID);
    expect(entry).toBeDefined();
    expect(entry?.weight).toBe(0);

    const single = await fetch(`${restBaseUrl}/v1/plugins/${EXAMPLE_ID}`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(single.status).toBe(200);

    const mcpListed = await mcp.callTool("list_plugins", {}, { apiKey: TEST_API_KEY });
    expect(mcpListed.ok).toBe(true);
    if (mcpListed.ok) {
      const mcpBody = JSON.parse(mcpListed.value.content[0]?.text ?? "null") as {
        plugins: readonly { id: string }[];
      };
      expect(mcpBody.plugins.some((item) => item.id === EXAMPLE_ID)).toBe(true);
    }

    const analysed = await fetch(`${restBaseUrl}/v1/analyze?address=${TEST_ADDRESS}`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(analysed.status).toBe(200);
    const body = (await analysed.json()) as {
      probabilities: Record<string, number>;
      score: number;
      pluginResults: readonly {
        pluginId: string;
        outcome: string;
        findings: readonly { id: string; title: string }[];
      }[];
    };
    const example = body.pluginResults.find((item) => item.pluginId === EXAMPLE_ID);
    expect(example?.outcome).toBe("ok");
    expect(example?.findings.length).toBeGreaterThan(0);

    const plain = await testServices().analyzeToken({
      address: mustOk(Address.parse(TEST_ADDRESS)),
      block: mustOk(BlockNumber.of(TEST_BLOCK)),
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustOk(ModelVersion.parse("0.1.0")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    });
    expect(plain.ok && plain.value.kind === "assessed").toBe(true);
    if (plain.ok && plain.value.kind === "assessed") {
      expect(plain.value.envelope.probabilities).toEqual(body.probabilities);
      expect(plain.value.envelope.score).toBe(body.score);
    }
  });

  test("production default registry carries no example plugin", () => {
    expect(
      DEFAULT_PLUGIN_REGISTRY.plugins.some((manifest) => manifest.id === EXAMPLE_ID),
    ).toBe(false);
    expect(
      DEFAULT_DETECTOR_PLUGINS.some((plugin) => plugin.manifest.id === EXAMPLE_ID),
    ).toBe(false);
  });
});
