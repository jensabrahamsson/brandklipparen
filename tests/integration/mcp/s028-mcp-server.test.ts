// S-028 MCP server tests (K-025, K-026, K-508): read-only MCP server as a
// thin driving adapter over the same shared application service as REST.
// Written first per A-21 (red): src/interfaces/mcp does not exist yet, so
// every test below fails until the adapter is implemented. All ports are
// in-memory fakes; the MCP server is driven in-process (direct tool calls
// and JSON-RPC text) and the REST server over loopback HTTP. No outbound
// network happens in this file.
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

// Synthetic placeholder artifact for the test only (K-210): finite test
// weights with no learned values, so scoring runs deterministically.
// Production values come from the versioned model artifact per A-20.
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

// Placeholder catalogue for the test only: fixed risk mapping per capability
// key, so detection yields signals without carrying learned values.
const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

const TEST_ADDRESS = "0x0102030405060708090a0b0c0d0e0f1011121314";
const TEST_BYTECODE = `0x8063a9059cbb14600a57${"00".repeat(10)}ff`;
const TEST_BLOCK = 18000000;
const TEST_API_KEY = "test-key-for-mcp-suite-only";
const TEST_PEPPER = "test-pepper-for-mcp-suite-only";
const UNKNOWN_ADDRESS = "0x1212121212121212121212121212121212121212";

function sharedOptions() {
  return {
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
  };
}

function buildServices(onAnalyze?: () => void): { services: AppServices; rpcFake: FakeRpcAdapter } {
  const codes = new Map<string, string>([[mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE]]);
  const rpcFake = new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK)));
  const inner = createAppServices({
    rpc: rpcFake,
    modelArtifacts: placeholderArtifact(),
    clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
  });
  const services: AppServices = Object.freeze({
    analyzeToken: async (input) => {
      onAnalyze?.();
      return inner.analyzeToken(input);
    },
    resolveProxy: (input) => inner.resolveProxy(input),
  });
  return { services, rpcFake };
}

describe("read-only MCP server over the shared service (S-028)", () => {
  let rest: RestServer;
  let restBaseUrl: string;
  let mcp: McpServer;
  let analyzeCalls = 0;

  beforeAll(async () => {
    const { services } = buildServices(() => {
      analyzeCalls += 1;
    });
    rest = createRestServer({
      services,
      apiKeys: [new SecretString(TEST_API_KEY)] as readonly SecretString[],
      apiKeyPepper: new SecretString(TEST_PEPPER),
      ...sharedOptions(),
    });
    restBaseUrl = await rest.listen("127.0.0.1", 0);
    mcp = createMcpServer({ services, ...sharedOptions() });
  });

  afterAll(async () => {
    await rest.close();
  });

  test("k025_assess_token_matches_rest_for_same_codehash", async () => {
    const restResponse = await fetch(`${restBaseUrl}/v1/analyze?address=${TEST_ADDRESS}`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(restResponse.status).toBe(200);
    const restBody = await restResponse.text();

    const toolResult = await mcp.callTool("assess_token", { address: TEST_ADDRESS });
    expect(toolResult.ok).toBe(true);
    if (!toolResult.ok) {
      throw new Error("expected tool success");
    }
    expect(toolResult.value.content).toHaveLength(1);
    const text = toolResult.value.content[0]?.text ?? "";
    // Byte-identical canonical payload: the MCP tool returns the shared
    // service output through the same serialisation as the REST adapter.
    expect(text).toBe(restBody);
    expect(JSON.parse(text)).toEqual(JSON.parse(restBody));
  });

  test("k025_assess_token_matches_rest_for_no_contract_address", async () => {
    const restResponse = await fetch(`${restBaseUrl}/v1/analyze?address=${UNKNOWN_ADDRESS}`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(restResponse.status).toBe(200);
    const restBody = await restResponse.text();

    const toolResult = await mcp.callTool("assess_token", { address: UNKNOWN_ADDRESS });
    expect(toolResult.ok).toBe(true);
    if (!toolResult.ok) {
      throw new Error("expected tool success");
    }
    expect(toolResult.value.content[0]?.text ?? "").toBe(restBody);
  });

  test("k025_assess_token_matches_rest_over_json_rpc", async () => {
    const restResponse = await fetch(`${restBaseUrl}/v1/analyze?address=${TEST_ADDRESS}`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    const restBody = await restResponse.text();

    const raw = await mcp.handleJsonRpc(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "assess_token", arguments: { address: TEST_ADDRESS } },
      }),
    );
    const parsed = JSON.parse(raw) as {
      result?: { content?: Array<{ text?: string }> };
      error?: unknown;
    };
    expect(parsed.error).toBeUndefined();
    expect(parsed.result?.content?.[0]?.text).toBe(restBody);
  });

  test("k025_tool_list_announces_name_description_version", async () => {
    const tools = mcp.listTools();
    const assess = tools.find((tool) => tool.name === "assess_token");
    expect(assess).toBeDefined();
    expect(typeof assess?.description).toBe("string");
    expect((assess?.description ?? "").length).toBeGreaterThan(0);
    expect(typeof assess?.version).toBe("string");
    expect((assess?.version ?? "").length).toBeGreaterThan(0);
    expect(assess?.inputSchema).toBeDefined();

    const raw = await mcp.handleJsonRpc(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    );
    const parsed = JSON.parse(raw) as {
      result?: { tools?: Array<{ name?: string; description?: string; version?: string }> };
    };
    const listed = parsed.result?.tools?.find((tool) => tool.name === "assess_token");
    expect(typeof listed?.description).toBe("string");
    expect(typeof listed?.version).toBe("string");
  });

  test("k025_unknown_tool_returns_machine_readable_error", async () => {
    const before = analyzeCalls;
    const result = await mcp.callTool("no_such_tool", { address: TEST_ADDRESS });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected tool error");
    }
    expect(result.error.code).toBe("unknown-tool");
    // The error names the unknown tool, so callers can tell which name failed.
    expect(result.error.message).toContain("no_such_tool");
    expect(analyzeCalls).toBe(before);

    const raw = await mcp.handleJsonRpc(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "no_such_tool", arguments: { address: TEST_ADDRESS } },
      }),
    );
    const parsed = JSON.parse(raw) as {
      error?: { message?: string; data?: { tool?: string; code?: string } };
    };
    expect(parsed.error?.message).toContain("no_such_tool");
    expect(parsed.error?.data?.tool).toBe("no_such_tool");
    expect(parsed.error?.data?.code).toBe("unknown-tool");
    expect(analyzeCalls).toBe(before);
  });
});
