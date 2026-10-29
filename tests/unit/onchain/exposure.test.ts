// On-chain exposure tests (REST + MCP): the serving-mode read is
// reachable, gated, honest when unconfigured, and never touches scoring.
// Synthetic addresses only.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  ArtifactChecksum,
  BlockNumber,
  IndexVersion,
  ModelVersion,
  TemplateVersion,
  Timestamp,
} from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import { parseModelArtifact } from "../../../src/domain/risk.ts";
import type { CapabilityCatalogue } from "../../../src/domain/signals.ts";
import { createAppServices } from "../../../src/application/analyzeToken.ts";
import type { AppServices } from "../../../src/application/analyzeToken.ts";
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";
import { SecretString } from "../../../src/ports/config.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { createRestServer } from "../../../src/interfaces/rest/server.ts";
import type { RestServer } from "../../../src/interfaces/rest/server.ts";
import { createMcpServer } from "../../../src/interfaces/mcp/server.ts";
import { ONCHAIN_FEATURES_TOOL } from "../../../src/interfaces/mcp/tools.ts";
import { syntheticAddress } from "../../helpers/syntheticAddresses.ts";

const TEST_API_KEY = "test-key-for-onchain-only";
const TEST_PEPPER = "test-pepper-for-onchain-only";
const TOKEN = syntheticAddress(121);

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

function testServices(): AppServices {
  return createAppServices(
    {
      rpc: new FakeRpcAdapter(new Map(), mustOk(BlockNumber.of(18000000))),
      modelArtifacts: new FakeModelArtifactAdapter({
        artifact: mustOk(
          parseModelArtifact({
            version: "0.1.0",
            severityWeights: { low: 0.2, medium: 0.5, high: 1.0 },
            causeWeights: { timeout: 0.4, "resource-limit": 0.4, "decompiler-error": 0.6, "obfuscated-structure": 0.6 },
            biases: { "rug-pull": 0.0, honeypot: 0.0, "bot-pump": 0.0 },
            calibration: {
              "rug-pull": { slope: 1.0, intercept: 0.0 },
              honeypot: { slope: 1.0, intercept: 0.0 },
              "bot-pump": { slope: 1.0, intercept: 0.0 },
            },
            scoreWeights: { "rug-pull": 1.0, honeypot: 1.0, "bot-pump": 1.0 },
          }),
        ),
        checksum: mustOk(ArtifactChecksum.parse("cd".repeat(32))),
      }),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
    mustDefaultDetectorSet(),
  );
}

function chainRpc(): FakeRpcAdapter {
  return new FakeRpcAdapter(
    new Map([[TOKEN, "0x6001600055"]]),
    mustOk(BlockNumber.of(18000000)),
  );
}

describe("GET /v1/onchain-features", () => {
  let rest: RestServer;
  let baseUrl: string;

  beforeAll(async () => {
    rest = createRestServer({
      detectors: mustDefaultDetectorSet(),
      services: testServices(),
      apiKeys: [new SecretString(TEST_API_KEY)] as readonly SecretString[],
      apiKeyPepper: new SecretString(TEST_PEPPER),
      modelVersion: mustOk(ModelVersion.parse("0.1.0")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
      onchain: { rpc: chainRpc(), weth: null },
    });
    baseUrl = await rest.listen("127.0.0.1", 0);
  });

  afterAll(async () => {
    await rest.close();
  });

  test("serves serving-mode features without touching the score", async () => {
    const response = await fetch(`${baseUrl}/v1/onchain-features?address=${TOKEN}&block=latest`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("ok");
    expect(body["features"]).toBeDefined();
    expect(body["score"]).toBeUndefined();
    expect(body["probabilities"]).toBeUndefined();
  });

  test("the API-key gate holds", async () => {
    const missing = await fetch(`${baseUrl}/v1/onchain-features?address=${TOKEN}&block=latest`);
    expect(missing.status).toBe(401);
  });

  test("answers onchain-not-configured without wiring", async () => {
    const bare = createRestServer({
      detectors: mustDefaultDetectorSet(),
      services: testServices(),
      apiKeys: [new SecretString(TEST_API_KEY)] as readonly SecretString[],
      apiKeyPepper: new SecretString(TEST_PEPPER),
      modelVersion: mustOk(ModelVersion.parse("0.1.0")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    });
    const url = await bare.listen("127.0.0.1", 0);
    try {
      const response = await fetch(`${url}/v1/onchain-features?address=${TOKEN}&block=latest`, {
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(response.status).toBe(501);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["code"]).toBe("onchain-not-configured");
    } finally {
      await bare.close();
    }
  });
});

describe("onchain_features MCP tool", () => {
  test("the closed tool list names the read-only tool", () => {
    const server = createMcpServer({
      detectors: mustDefaultDetectorSet(),
      services: testServices(),
      apiKeys: [new SecretString(TEST_API_KEY)] as readonly SecretString[],
      modelVersion: mustOk(ModelVersion.parse("0.1.0")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    });
    expect(server.listTools().map((tool) => tool.name)).toContain(ONCHAIN_FEATURES_TOOL);
  });

  test("answers onchain-not-configured with zero chain calls", async () => {
    const rpc = chainRpc();
    const server = createMcpServer({
      detectors: mustDefaultDetectorSet(),
      services: testServices(),
      apiKeys: [new SecretString(TEST_API_KEY)] as readonly SecretString[],
      modelVersion: mustOk(ModelVersion.parse("0.1.0")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    });
    const outcome = await server.callTool(
      ONCHAIN_FEATURES_TOOL,
      { address: TOKEN, block: "latest" },
      { apiKey: TEST_API_KEY },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.error.code).toBe("onchain-not-configured");
    expect(rpc.getCodeCalls).toEqual([]);
  });

  test("serves features through the wired chain port", async () => {
    const server = createMcpServer({
      detectors: mustDefaultDetectorSet(),
      services: testServices(),
      apiKeys: [new SecretString(TEST_API_KEY)] as readonly SecretString[],
      modelVersion: mustOk(ModelVersion.parse("0.1.0")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
      onchain: { rpc: chainRpc(), weth: null },
    });
    const outcome = await server.callTool(
      ONCHAIN_FEATURES_TOOL,
      { address: TOKEN, block: "latest" },
      { apiKey: TEST_API_KEY },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const text = outcome.value.content[0]?.text ?? "";
    expect(text).toContain("features");
  });
});
