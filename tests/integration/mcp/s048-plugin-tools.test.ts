// S-048 per-plugin MCP tools (K-031, K-025, K-026, K-508). Written first
// per A-21 (red): the generated `plugin_*` tools do not exist yet, so the
// review coverage and dispatch tests below fail until the generator and
// the server wiring land. All ports are in-memory fakes; no outbound
// network happens here.
import { describe, expect, test } from "vitest";
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
import { SecretString } from "../../../src/ports/config.ts";
import {
  TOOL_SECURITY_REVIEWS,
  buildPluginToolDefinitions,
  pluginToolNameFor,
} from "../../../src/interfaces/mcp/pluginTools.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { createMcpServer } from "../../../src/interfaces/mcp/server.ts";
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";

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

const TEST_ADDRESS = "0x0102030405060708090a0b0c0d0e0f1011121314";
const TEST_BYTECODE = `0x8063a9059cbb14600a57${"00".repeat(10)}ff`;
const TEST_API_KEY = "test-key-for-plugin-tools-suite-only";
const TEST_PEPPER = "test-pepper-for-plugin-tools-suite-only";

function testServer(): {
  readonly call: (name: string, args: unknown) => Promise<unknown>;
  readonly list: () => readonly { readonly name: string }[];
} {
  const codes = new Map<string, string>([[mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE]]);
  const services: AppServices = createAppServices(
    {
      rpc: new FakeRpcAdapter(codes, mustOk(BlockNumber.of(18000000))),
      modelArtifacts: placeholderArtifact(),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
    mustDefaultDetectorSet(),
  );
  const server = createMcpServer({
    services,
    apiKeys: [new SecretString(TEST_API_KEY)],
    apiKeyPepper: new SecretString(TEST_PEPPER),
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
    detectors: mustDefaultDetectorSet(),
  });
  return {
    call: (name: string, args: unknown) => server.callTool(name, args, { apiKey: TEST_API_KEY }),
    list: () => server.listTools(),
  };
}

describe("per-plugin MCP tools", () => {
  test("k026_new_tool_security_review_recorded", () => {
    const { list } = testServer();
    for (const tool of list()) {
      const review = (TOOL_SECURITY_REVIEWS as Readonly<Record<string, unknown>>)[tool.name] as
        | { reviewer?: unknown; date?: unknown; scope?: unknown; verdict?: unknown }
        | undefined;
      expect(review, `tool ${tool.name} carries a review entry`).toBeDefined();
      expect(typeof review?.reviewer).toBe("string");
      expect((review?.reviewer as string).length).toBeGreaterThan(0);
      expect(typeof review?.date).toBe("string");
      expect(typeof review?.scope).toBe("string");
      expect(review?.verdict).toBe("approved");
    }
  });

  test("k025_unknown_plugin_tool_returns_machine_readable_error", async () => {
    const { call } = testServer();
    const result = (await call("plugin_no_such_plugin", { address: TEST_ADDRESS })) as {
      ok: boolean;
      error?: { code?: unknown; message?: unknown };
    };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("unknown-tool");
    expect(JSON.stringify(result.error?.message)).toContain("plugin_no_such_plugin");
  });

  test("k031_plugin_tool_returns_only_its_plugin_findings", async () => {
    const { call } = testServer();
    const toolName = pluginToolNameFor("dev.brandklipparen.capability");
    const pluginResult = (await call(toolName, { address: TEST_ADDRESS })) as {
      ok: boolean;
      value?: { content?: readonly { text?: unknown }[] };
    };
    expect(pluginResult.ok).toBe(true);
    const body = JSON.parse(String(pluginResult.value?.content?.[0]?.text)) as {
      plugin: { id: string; findings: readonly { id: string }[] };
    };
    expect(body.plugin.id).toBe("dev.brandklipparen.capability");
    const assessResult = (await call("assess_token", { address: TEST_ADDRESS })) as {
      ok: boolean;
      value?: { content?: readonly { text?: unknown }[] };
    };
    const assessBody = JSON.parse(String(assessResult.value?.content?.[0]?.text)) as {
      pluginResults: readonly { pluginId: string; findings: readonly { id: string }[] }[];
    };
    const entry = assessBody.pluginResults.find(
      (candidate) => candidate.pluginId === "dev.brandklipparen.capability",
    );
    expect(entry).toBeDefined();
    expect(body.plugin.findings.map((finding) => finding.id)).toEqual(
      entry?.findings.map((finding) => finding.id),
    );
  });

  test("k026_plugin_tool_calls_are_read_only", async () => {
    const { call } = testServer();
    const toolName = pluginToolNameFor("dev.brandklipparen.capability");
    const first = await call(toolName, { address: TEST_ADDRESS });
    const second = await call(toolName, { address: TEST_ADDRESS });
    expect(second).toEqual(first);
  });

  test("k031_plugin_tool_names_derive_from_registry_snapshot", () => {
    const built = mustOk(buildPluginToolDefinitions(mustDefaultDetectorSet().registry));
    const names = built.map((definition) => definition.name);
    expect(names).toContain(pluginToolNameFor("dev.brandklipparen.capability"));
    expect(names).toContain(pluginToolNameFor("dev.brandklipparen.clone-match"));
    expect(names).toContain(pluginToolNameFor("dev.brandklipparen.hard-to-analyze"));
    expect(new Set(names).size).toBe(names.length);
  });
});
