// MCP explain parity tools (S-094, VS-B3, K-027): explain_token and
// explain_function run through the same application services, guards,
// per-key caps and caches as POST /v1/explain and POST /v1/explain-code,
// with outputs that never move score or evidence. In-process servers only
// with fake adapters; no listener is opened and no outbound network
// happens here. All bytecode below is hand-assembled synthetic fixtures.
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
import { createExplainService } from "../../../src/application/explainService.ts";
import { createExplainCodeService } from "../../../src/application/explainCodeService.ts";
import type { VerifiedSourceService } from "../../../src/application/verifiedSource.ts";
import { SecretString } from "../../../src/ports/config.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeExplainModelAdapter } from "../../fakes/fakeExplainModel.ts";
import { FakeExplainCodeModelAdapter } from "../../fakes/fakeExplainCodeModel.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { createMcpServer } from "../../../src/interfaces/mcp/server.ts";
import type { McpServer } from "../../../src/interfaces/mcp/server.ts";
import { createRestServer } from "../../../src/interfaces/rest/server.ts";
import type { RestServer } from "../../../src/interfaces/rest/server.ts";
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

// Hand-assembled dispatcher fixture with two entries: transfer
// (0xa9059cbb) and balanceOf (0x70a08231).
const TEST_ADDRESS = "0x0102030405060708090a0b0c0d0e0f1011121314";
const TEST_BYTECODE =
  "0x608060405234801561001057600080fd5b508063a9059cbb1461002d57806370a0823114610047575b600080fd5b600035331461003b57600080fd5b60015460023501600155005b6000355460005260206000f3";
const TEST_SELECTOR = "0xa9059cbb";
const TEST_BLOCK = 18000000;
const TEST_API_KEY = "test-key-for-mcp-explain-suite-only";
const TEST_PEPPER = "test-pepper-for-mcp-explain-suite-only";

// Hand-assembled verified-source fixture: the transfer function lives on
// lines 2-4 of the single published file.
const FIXTURE_FILE = "contracts/FixtureToken.sol";
const FIXTURE_CONTENT = [
  "// synthetic fixture source",
  "function transfer(address to, uint256 amount) {",
  "balances[to] += amount;",
  "}",
  "",
].join("\n");

function stubSourceService(): VerifiedSourceService {
  return {
    getSource: async () => ({
      ok: true as const,
      value: {
        codeHash: "code-hash-for-unit-suite",
        source: {
          status: "verified" as const,
          provider: "sourcify" as const,
          match: "full" as const,
          compiler: "0.8.20+commit.a1b79de6",
          files: [{ path: FIXTURE_FILE, content: FIXTURE_CONTENT }],
          functions: [
            {
              selector: TEST_SELECTOR,
              file: FIXTURE_FILE,
              startLine: 2,
              endLine: 4,
              name: "transfer",
              signature: "transfer(address,uint256)",
            },
          ],
        },
      },
    }),
  };
}

function sharedOptions() {
  return {
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
  };
}

function buildServices(): { services: AppServices; rpc: FakeRpcAdapter } {
  const codes = new Map<string, string>([[mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE]]);
  const rpc = new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK)));
  const services = createAppServices(
    {
      rpc,
      modelArtifacts: placeholderArtifact(),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
    mustDefaultDetectorSet(),
  );
  return { services, rpc };
}

function keyedOptions() {
  return {
    apiKeys: [new SecretString(TEST_API_KEY)] as readonly SecretString[],
    apiKeyPepper: new SecretString(TEST_PEPPER),
  };
}

describe("MCP explain tools over the shared services", () => {
  test("tool_list_snapshot_lists_the_closed_reading_tools", async () => {
    const { services } = buildServices();
    const mcp: McpServer = createMcpServer({ detectors: mustDefaultDetectorSet(), services, ...sharedOptions() });
    const tools = mcp.listTools();
    const core = tools.slice(0, 13).map((tool) => tool.name);
    expect(core).toEqual([
      "assess_token",
      "request_assessment",
      "investigate_token",
      "onchain_features",
      "list_plugins",
      "get_plugin_docs",
      "get_plugin_audit",
      "explain_token",
      "explain_function",
      "get_decompiled_function",
      "get_verified_source",
      "get_proof_trace",
      "list_new_tokens",
    ]);
    for (const tool of tools.slice(0, 13)) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.version.length).toBeGreaterThan(0);
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    const raw = await mcp.handleJsonRpc(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    );
    const parsed = JSON.parse(raw) as { result?: { toolListVersion?: unknown } };
    expect(parsed.result?.toolListVersion).toBe("1.3.0");
  });

  test("explain_token_matches_rest_byte_for_byte", async () => {
    const { services, rpc } = buildServices();
    void rpc;
    const explainFake = new FakeExplainModelAdapter("ok");
    const explainService = createExplainService(explainFake);
    const rest: RestServer = createRestServer({
      detectors: mustDefaultDetectorSet(),
      services,
      ...keyedOptions(),
      ...sharedOptions(),
      explainService,
    });
    const mcp: McpServer = createMcpServer({
      detectors: mustDefaultDetectorSet(),
      services,
      ...keyedOptions(),
      ...sharedOptions(),
      explainService,
    });
    const restResponse = await rest.inject({
      method: "GET",
      url: `/v1/explain?address=${TEST_ADDRESS}`,
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(restResponse.statusCode).toBe(200);
    const toolResult = await mcp.callTool("explain_token", { address: TEST_ADDRESS }, { apiKey: TEST_API_KEY });
    expect(toolResult.ok).toBe(true);
    if (!toolResult.ok) {
      throw new Error("expected tool success");
    }
    expect(toolResult.value.content).toHaveLength(1);
    expect(toolResult.value.content[0]?.text).toBe(restResponse.body);
    const body = JSON.parse(toolResult.value.content[0]?.text ?? "{}") as {
      explain?: { kind?: unknown; narrative?: unknown };
    };
    expect(body.explain?.kind).toBe("ok");
    expect(Array.isArray(body.explain?.narrative)).toBe(true);
    // One provider call per interface call through the same service.
    expect(explainFake.calls).toHaveLength(2);
    await rest.close();
  });

  test("explain_token_not_configured_stands_with_zero_provider_calls", async () => {
    const { services } = buildServices();
    const mcp: McpServer = createMcpServer({ detectors: mustDefaultDetectorSet(), services, ...sharedOptions() });
    const result = await mcp.callTool("explain_token", { address: TEST_ADDRESS });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected tool success");
    }
    const body = JSON.parse(result.value.content[0]?.text ?? "{}") as {
      explain?: { kind?: unknown };
      codeHash?: unknown;
    };
    expect(body.explain?.kind).toBe("not-configured");
    expect(typeof body.codeHash).toBe("string");
  });

  test("explain_token_validation_fails_before_analysis", async () => {
    const { services, rpc } = buildServices();
    const mcp: McpServer = createMcpServer({ detectors: mustDefaultDetectorSet(), services, ...sharedOptions() });
    const before = rpc.getCodeCalls.length;
    for (const args of [
      { address: "not-an-address" },
      { address: TEST_ADDRESS, block: "yesterday" },
      { address: TEST_ADDRESS, api_key: "test-key-value" },
      { address: TEST_ADDRESS, injected: "extra-field" },
    ]) {
      const result = await mcp.callTool("explain_token", args);
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected validation error");
      }
      expect(["validation-error", "key-in-url-or-body"]).toContain(result.error.code);
    }
    expect(rpc.getCodeCalls.length).toBe(before);
  });

  test("explain_token_leaves_score_and_evidence_untouched", async () => {
    const { services } = buildServices();
    const explainFake = new FakeExplainModelAdapter("ok");
    const mcp: McpServer = createMcpServer({
      detectors: mustDefaultDetectorSet(),
      services,
      ...sharedOptions(),
      explainService: createExplainService(explainFake),
    });
    const before = await mcp.callTool("assess_token", { address: TEST_ADDRESS });
    const explained = await mcp.callTool("explain_token", { address: TEST_ADDRESS });
    expect(explained.ok).toBe(true);
    const after = await mcp.callTool("assess_token", { address: TEST_ADDRESS });
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) {
      throw new Error("expected assessment success");
    }
    expect(after.value.content[0]?.text).toBe(before.value.content[0]?.text);
  });

  test("explain_function_decompiled_matches_rest_byte_for_byte", async () => {
    const { services, rpc } = buildServices();
    const explainCodeFake = new FakeExplainCodeModelAdapter("ok");
    const explainCodeService = createExplainCodeService(explainCodeFake);
    const rest: RestServer = createRestServer({
      detectors: mustDefaultDetectorSet(),
      services,
      ...keyedOptions(),
      ...sharedOptions(),
      explainCodeService,
      snippetRpc: rpc,
    });
    const mcp: McpServer = createMcpServer({
      detectors: mustDefaultDetectorSet(),
      services,
      ...keyedOptions(),
      ...sharedOptions(),
      explainCodeService,
      snippetRpc: rpc,
    });
    const payload = { address: TEST_ADDRESS, selector: TEST_SELECTOR, view: "decompiled" };
    const restResponse = await rest.inject({
      method: "POST",
      url: "/v1/explain-code",
      headers: { "x-api-key": TEST_API_KEY },
      payload,
    });
    expect(restResponse.statusCode).toBe(200);
    const toolResult = await mcp.callTool("explain_function", payload, { apiKey: TEST_API_KEY });
    expect(toolResult.ok).toBe(true);
    if (!toolResult.ok) {
      throw new Error(`expected tool success, got ${JSON.stringify(toolResult.error)}`);
    }
    expect(toolResult.value.content[0]?.text).toBe(restResponse.body);
    const body = JSON.parse(toolResult.value.content[0]?.text ?? "{}") as {
      explainCode?: { kind?: unknown };
    };
    expect(body.explainCode?.kind).toBe("ok");
    expect(explainCodeFake.calls).toHaveLength(2);
    await rest.close();
  });

  test("explain_function_source_view_returns_the_verified_range", async () => {
    const { services, rpc } = buildServices();
    const explainCodeFake = new FakeExplainCodeModelAdapter("ok");
    const mcp: McpServer = createMcpServer({
      detectors: mustDefaultDetectorSet(),
      services,
      ...sharedOptions(),
      explainCodeService: createExplainCodeService(explainCodeFake),
      snippetRpc: rpc,
      sourceService: stubSourceService(),
    });
    const result = await mcp.callTool("explain_function", {
      address: TEST_ADDRESS,
      selector: TEST_SELECTOR,
      view: "source",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`expected tool success, got ${JSON.stringify(result.error)}`);
    }
    const body = JSON.parse(result.value.content[0]?.text ?? "{}") as {
      explainCode?: { kind?: unknown };
      view?: unknown;
    };
    expect(body.explainCode?.kind).toBe("ok");
    expect(body.view).toBe("source");
    expect(explainCodeFake.calls[0]?.file).toBe(FIXTURE_FILE);
  });

  test("explain_function_validation_fails_before_any_provider_call", async () => {
    const { services, rpc } = buildServices();
    const explainCodeFake = new FakeExplainCodeModelAdapter("ok");
    let decompileCalls = 0;
    const mcp: McpServer = createMcpServer({
      detectors: mustDefaultDetectorSet(),
      services,
      ...sharedOptions(),
      explainCodeService: createExplainCodeService(explainCodeFake),
      snippetRpc: rpc,
      snippetDecompile: (bytecode) => {
        decompileCalls += 1;
        void bytecode;
        throw new Error("pipeline must not run for unknown selectors");
      },
    });
    for (const args of [
      { address: TEST_ADDRESS, selector: "0x123", view: "decompiled" },
      { address: TEST_ADDRESS, selector: TEST_SELECTOR, view: "raw" },
      { address: TEST_ADDRESS },
    ]) {
      const result = await mcp.callTool("explain_function", args);
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected validation error");
      }
      expect(result.error.code).toBe("validation-error");
    }
    const unknown = await mcp.callTool("explain_function", {
      address: TEST_ADDRESS,
      selector: "0xdeadbeef",
      view: "decompiled",
    });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) {
      throw new Error("expected unknown-selector error");
    }
    expect(unknown.error.code).toBe("validation-error");
    expect(decompileCalls).toBe(0);
    expect(explainCodeFake.calls).toHaveLength(0);
  });

  test("explain_function_not_configured_needs_no_chain_read", async () => {
    const { services, rpc } = buildServices();
    const mcp: McpServer = createMcpServer({ detectors: mustDefaultDetectorSet(), services, ...sharedOptions() });
    const before = rpc.getCodeCalls.length;
    const result = await mcp.callTool("explain_function", {
      address: TEST_ADDRESS,
      selector: TEST_SELECTOR,
      view: "decompiled",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected tool success");
    }
    const body = JSON.parse(result.value.content[0]?.text ?? "{}") as {
      explainCode?: { kind?: unknown };
    };
    expect(body.explainCode?.kind).toBe("not-configured");
    expect(rpc.getCodeCalls.length).toBe(before);
  });
});
