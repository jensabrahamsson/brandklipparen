// S-056 plugin docs exposure tests (K-033 proposed): the validated
// `PLUGIN.md` record from the one registry-adjacent value is identical in
// `GET /v1/plugins/:id/docs` and the `get_plugin_docs` MCP tool, the
// API-key gate holds on the docs route, and unknown ids give the uniform
// not-found error in REST and the machine-readable error in MCP. Written
// first (red) per A-21: the docs route and tool do not exist yet, so every
// test below fails until the exposure lands. All ports are in-memory
// fakes; no outbound network happens here.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
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
import { validatePluginDocs } from "../../../src/plugins/docs.ts";
import type { ValidatedPluginDocs } from "../../../src/plugins/docs.ts";
import type { PluginDocsMap } from "../../../src/plugins/exposure.ts";
import { capabilityDetectorPlugin } from "../../../src/plugins/detectors/capability/index.ts";
import { cloneMatchDetectorPlugin } from "../../../src/plugins/detectors/clone-match/index.ts";
import { hardToAnalyzeDetectorPlugin } from "../../../src/plugins/detectors/hard-to-analyze/index.ts";
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
const TEST_API_KEY = "test-key-for-docs-suite-only";
const TEST_PEPPER = "test-pepper-for-docs-suite-only";
const DOCS_ID = "dev.brandklipparen.capability";

function testServices(): AppServices {
  const codes = new Map<string, string>([[mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE]]);
  return createAppServices(
    {
      rpc: new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK))),
      modelArtifacts: placeholderArtifact(),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
    mustDefaultDetectorSet(),
  );
}

// The one registry-adjacent docs value both servers read: the validated
// on-disk `PLUGIN.md` records for the default detector set.
function testDocs(): PluginDocsMap {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..", "..", "..");
  const entries = [
    { dir: "src/plugins/detectors/capability", plugin: capabilityDetectorPlugin },
    { dir: "src/plugins/detectors/clone-match", plugin: cloneMatchDetectorPlugin },
    { dir: "src/plugins/detectors/hard-to-analyze", plugin: hardToAnalyzeDetectorPlugin },
  ] as const;
  const map = new Map<string, ValidatedPluginDocs>();
  for (const entry of entries) {
    const markdown = readFileSync(join(repoRoot, entry.dir, "PLUGIN.md"), "utf8");
    const checked = validatePluginDocs(entry.plugin.manifest, markdown);
    if (!checked.ok) {
      throw new Error(`docs fixture failed validation: ${checked.error.kind}`);
    }
    map.set(entry.plugin.manifest.id as string, checked.value);
  }
  return map;
}

function sharedOptions(pluginDocs: PluginDocsMap) {
  return {
    apiKeys: [new SecretString(TEST_API_KEY)] as readonly SecretString[],
    apiKeyPepper: new SecretString(TEST_PEPPER),
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
    pluginDocs,
  };
}

describe("plugin docs exposure across interfaces (S-056)", () => {
  let rest: RestServer;
  let restBaseUrl: string;
  let mcp: McpServer;

  beforeAll(async () => {
    const services = testServices();
    const pluginDocs = testDocs();
    rest = createRestServer({ detectors: mustDefaultDetectorSet(), services, ...sharedOptions(pluginDocs) });
    restBaseUrl = await rest.listen("127.0.0.1", 0);
    mcp = createMcpServer({ detectors: mustDefaultDetectorSet(), services, ...sharedOptions(pluginDocs) });
  });

  afterAll(async () => {
    await rest.close();
  });

  test("k033_plugin_docs_match_registry_in_rest_and_mcp", async () => {
    const response = await fetch(`${restBaseUrl}/v1/plugins/${DOCS_ID}/docs`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(response.status).toBe(200);
    const restText = await response.text();
    const restBody = JSON.parse(restText) as {
      id: string;
      version: string;
      sections: readonly string[];
      markdown: string;
    };
    expect(restBody.id).toBe(DOCS_ID);
    expect(restBody.version).toBe("1.0.0");
    expect(restBody.sections).toContain("Inputs");
    expect(restBody.markdown).toContain("## Inputs");

    const documented = await mcp.callTool("get_plugin_docs", { id: DOCS_ID }, { apiKey: TEST_API_KEY });
    expect(documented.ok).toBe(true);
    if (!documented.ok) {
      return;
    }
    expect(documented.value.isError).toBe(false);
    expect(documented.value.content[0]?.text).toBe(restText);
  });

  test("k033_plugin_docs_routes_require_api_key_and_name_unknown_ids", async () => {
    const missing = await fetch(`${restBaseUrl}/v1/plugins/${DOCS_ID}/docs`);
    expect(missing.status).toBe(401);
    const invalid = await fetch(`${restBaseUrl}/v1/plugins/${DOCS_ID}/docs`, {
      headers: { "x-api-key": "wrong-key" },
    });
    expect(invalid.status).toBe(401);

    const unknown = await fetch(`${restBaseUrl}/v1/plugins/dev.brandklipparen.no-such-plugin/docs`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(unknown.status).toBe(404);
    const body = (await unknown.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("not-found");

    const denied = await mcp.callTool("get_plugin_docs", { id: DOCS_ID });
    expect(denied.ok).toBe(false);
    const mistaken = await mcp.callTool(
      "get_plugin_docs",
      { id: "dev.brandklipparen.no-such-plugin" },
      { apiKey: TEST_API_KEY },
    );
    expect(mistaken.ok).toBe(false);
    if (mistaken.ok) {
      throw new Error("expected an unknown plugin id to fail");
    }
    expect(mistaken.error.code).toBe("validation-error");
  });
});
