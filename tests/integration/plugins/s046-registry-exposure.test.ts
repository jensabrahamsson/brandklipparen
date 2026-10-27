// S-046 registry exposure tests (K-031 proposed): the plugin list from the
// registry is identical across REST and MCP, per-plugin lookup works, the
// API-key gate holds, and unknown ids give the uniform not-found error.
// Written first (red) per A-21: GET /v1/plugins and the list_plugins MCP
// tool do not exist yet, so every test below fails until the exposure
// lands. All ports are in-memory fakes; no outbound network happens here.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Ajv } from "ajv";
import { parseModelArtifact } from "../../../src/domain/risk.ts";
import type { Result } from "../../../src/domain/result.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  IndexVersion,
  ModelVersion,
  TemplateVersion,
  Timestamp,
} from "../../../src/domain/types.ts";
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
import type { McpServer } from "../../../src/interfaces/mcp/server.ts";

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
      checksum: mustOk(ArtifactChecksum.parse("cd".repeat(32))),
    }),
  );
}

const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

const TEST_ADDRESS = "0x0102030405060708090a0b0c0d0e0f1011121314";
const TEST_BYTECODE = `0x8063a9059cbb14600a57${"00".repeat(10)}ff`;
const TEST_BLOCK = 18000000;
const TEST_API_KEY = "test-key-for-plugin-suite-only";
const TEST_PEPPER = "test-pepper-for-plugin-suite-only";

function testServices(): AppServices {
  const codes = new Map<string, string>([[mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE]]);
  return createAppServices({
    rpc: new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK))),
    modelArtifacts: placeholderArtifact(),
    clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
  },
  mustDefaultDetectorSet());
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

describe("registry exposure across interfaces (S-046)", () => {
  let rest: RestServer;
  let restBaseUrl: string;
  let mcp: McpServer;

  beforeAll(async () => {
    const services = testServices();
    rest = createRestServer({ detectors: mustDefaultDetectorSet(), services, ...sharedOptions() });
    restBaseUrl = await rest.listen("127.0.0.1", 0);
    mcp = createMcpServer({ detectors: mustDefaultDetectorSet(), services, ...sharedOptions() });
  });

  afterAll(async () => {
    await rest.close();
  });

  test("k031_plugin_list_matches_registry_in_rest_and_mcp", async () => {
    const response = await fetch(`${restBaseUrl}/v1/plugins`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(response.status).toBe(200);
    const restText = await response.text();
    const schema = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "interfaces", "rest", "schema", "v1.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const ajv = new Ajv({ strict: true });
    const validate = ajv.compile(schema);
    expect(validate(JSON.parse(restText))).toBe(true);
    const restList = JSON.parse(restText) as { readonly plugins: readonly unknown[] };
    expect(Array.isArray(restList.plugins)).toBe(true);
    const defaultIds = mustDefaultDetectorSet().registry.entries.map((entry) => entry.manifest.id);
    expect(restList.plugins.length).toBe(defaultIds.length);
    const restIds = restList.plugins.map((entry) => (entry as { id: string }).id);
    expect(restIds).toEqual(defaultIds);

    const listed = await mcp.callTool("list_plugins", {}, { apiKey: TEST_API_KEY });
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      return;
    }
    expect(listed.value.isError).toBe(false);
    const mcpList = JSON.parse(listed.value.content[0]?.text ?? "null") as {
      readonly plugins: readonly unknown[];
    };
    expect(mcpList).toEqual(restList);

    for (const id of defaultIds) {
      const single = await fetch(`${restBaseUrl}/v1/plugins/${id}`, {
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(single.status).toBe(200);
      const body = (await single.json()) as { id: string };
      expect(body.id).toBe(id);
    }
  });

  test("k031_plugin_routes_require_api_key_and_name_unknown_ids", async () => {
    const missing = await fetch(`${restBaseUrl}/v1/plugins`);
    expect(missing.status).toBe(401);
    const invalid = await fetch(`${restBaseUrl}/v1/plugins`, {
      headers: { "x-api-key": "wrong-key" },
    });
    expect(invalid.status).toBe(401);

    const unknown = await fetch(`${restBaseUrl}/v1/plugins/dev.brandklipparen.no-such-plugin`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(unknown.status).toBe(404);
    const body = (await unknown.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("not-found");

    const denied = await mcp.callTool("list_plugins", {});
    expect(denied.ok).toBe(false);
  });

  test("k031_plugin_results_ride_the_assess_output_in_rest_and_mcp", async () => {
    const response = await fetch(`${restBaseUrl}/v1/analyze?address=${TEST_ADDRESS}`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(response.status).toBe(200);
    const restBody = (await response.json()) as {
      pluginResults: readonly { pluginId: string }[];
    };
    expect(Array.isArray(restBody.pluginResults)).toBe(true);
    expect(restBody.pluginResults.map((entry) => entry.pluginId)).toEqual(
      mustDefaultDetectorSet().registry.entries.map((entry) => entry.manifest.id),
    );

    const assessed = await mcp.callTool(
      "assess_token",
      { address: TEST_ADDRESS },
      { apiKey: TEST_API_KEY },
    );
    expect(assessed.ok).toBe(true);
    if (!assessed.ok) {
      return;
    }
    const mcpBody = JSON.parse(assessed.value.content[0]?.text ?? "null") as {
      pluginResults: readonly { pluginId: string }[];
    };
    expect(mcpBody.pluginResults).toEqual(restBody.pluginResults);
  });
});
