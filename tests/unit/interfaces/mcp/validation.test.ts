// MCP input validation unit tests (K-026, K-508, M-15): the tools validate
// every argument against the published input schema before analysis.
// Written first per A-21 (red): src/interfaces/mcp does not exist yet.
import { describe, expect, test } from "vitest";
import { parseModelArtifact } from "../../../../src/domain/risk.ts";
import type { Result } from "../../../../src/domain/result.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  IndexVersion,
  ModelVersion,
  TemplateVersion,
  Timestamp,
} from "../../../../src/domain/types.ts";
import type { CapabilityCatalogue } from "../../../../src/domain/signals.ts";
import { createAppServices } from "../../../../src/application/analyzeToken.ts";
import type { AppServices } from "../../../../src/application/analyzeToken.ts";
import { SecretString } from "../../../../src/ports/config.ts";
import { FakeClockAdapter } from "../../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../../fakes/fakeRpc.ts";
import { createMcpServer } from "../../../../src/interfaces/mcp/server.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function placeholderServices(onAnalyze?: () => void): AppServices {
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
  const codes = new Map<string, string>([
    [mustOk(Address.parse("0x0102030405060708090a0b0c0d0e0f1011121314")) as string, "0x6001600201"],
  ]);
  const inner = createAppServices({
    rpc: new FakeRpcAdapter(codes, mustOk(BlockNumber.of(18000000))),
    modelArtifacts: new FakeModelArtifactAdapter(
      Object.freeze({ artifact, checksum: mustOk(ArtifactChecksum.parse("ef".repeat(32))) }),
    ),
    clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
  });
  return Object.freeze({
    analyzeToken: async (input) => {
      onAnalyze?.();
      return inner.analyzeToken(input);
    },
    resolveProxy: (input) => inner.resolveProxy(input),
  });
}

function serverOptions() {
  return {
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: Object.freeze({
      selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
      delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
      call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
      "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
    }) as CapabilityCatalogue,
  };
}

describe("MCP input validation (K-026)", () => {
  test("k026_invalid_address_fails_schema_before_analysis", async () => {
    let analyzeCalls = 0;
    const mcp = createMcpServer({ services: placeholderServices(() => { analyzeCalls += 1; }), ...serverOptions() });
    for (const address of ["not-an-address", "", "0x1234", 42, null, undefined]) {
      const result = await mcp.callTool("assess_token", { address });
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected validation error");
      }
      expect(result.error.code).toBe("validation-error");
    }
    expect(analyzeCalls).toBe(0);
  });

  test("k026_oversized_input_rejected_before_analysis", async () => {
    let analyzeCalls = 0;
    const mcp = createMcpServer({ services: placeholderServices(() => { analyzeCalls += 1; }), ...serverOptions() });
    // Past the same address length cap as the REST adapter, so the tool
    // itself turns the input away before analysis.
    const huge = await mcp.callTool("assess_token", { address: `0x${"ab".repeat(1500)}` });
    expect(huge.ok).toBe(false);
    if (huge.ok) {
      throw new Error("expected oversize error");
    }
    expect(huge.error.code).toBe("request-too-large");
    expect(analyzeCalls).toBe(0);
  });

  test("k026_extra_fields_rejected_before_analysis", async () => {
    let analyzeCalls = 0;
    const mcp = createMcpServer({ services: placeholderServices(() => { analyzeCalls += 1; }), ...serverOptions() });
    // The input schema is strict: injected extra fields never reach analysis.
    const result = await mcp.callTool("assess_token", {
      address: "0x0102030405060708090a0b0c0d0e0f1011121314",
      injected: "extra-field",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected validation error");
    }
    expect(result.error.code).toBe("validation-error");
    expect(analyzeCalls).toBe(0);
  });

  test("k026_secret_like_argument_rejected_before_analysis", async () => {
    let analyzeCalls = 0;
    const mcp = createMcpServer({ services: placeholderServices(() => { analyzeCalls += 1; }), ...serverOptions() });
    // Keys travel outside the tool arguments, never inside them (M-10).
    const result = await mcp.callTool("assess_token", {
      address: "0x0102030405060708090a0b0c0d0e0f1011121314",
      api_key: "test-key-value",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected key error");
    }
    expect(result.error.code).toBe("key-in-url-or-body");
    expect(analyzeCalls).toBe(0);
  });

  test("k026_invalid_block_rejected_before_analysis", async () => {
    let analyzeCalls = 0;
    const mcp = createMcpServer({ services: placeholderServices(() => { analyzeCalls += 1; }), ...serverOptions() });
    for (const block of ["yesterday", -1, 1.5, "0x123"]) {
      const result = await mcp.callTool("assess_token", {
        address: "0x0102030405060708090a0b0c0d0e0f1011121314",
        block,
      });
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected validation error");
      }
      expect(result.error.code).toBe("validation-error");
    }
    expect(analyzeCalls).toBe(0);
  });

  test("k026_missing_or_invalid_key_rejected_before_analysis", async () => {
    let analyzeCalls = 0;
    const keyed = createMcpServer({
      services: placeholderServices(() => { analyzeCalls += 1; }),
      apiKeys: [new SecretString("mcp-test-key")] as readonly SecretString[],
      apiKeyPepper: new SecretString("mcp-test-pepper"),
      ...serverOptions(),
    });
    const address = "0x0102030405060708090a0b0c0d0e0f1011121314";
    const missing = await keyed.callTool("assess_token", { address });
    expect(missing.ok).toBe(false);
    const invalid = await keyed.callTool("assess_token", { address }, { apiKey: "wrong-key" });
    expect(invalid.ok).toBe(false);
    expect(analyzeCalls).toBe(0);
    const allowed = await keyed.callTool("assess_token", { address }, { apiKey: "mcp-test-key" });
    expect(allowed.ok).toBe(true);
    expect(analyzeCalls).toBe(1);
  });

  test("k026_malformed_json_rpc_never_throws", async () => {
    const mcp = createMcpServer({ services: placeholderServices(), ...serverOptions() });
    for (const raw of ["", "{broken", "42", "null", "[]", JSON.stringify({ jsonrpc: "1.0", id: 1, method: "tools/list" })]) {
      const rawResponse = await mcp.handleJsonRpc(raw);
      const parsed = JSON.parse(rawResponse) as { error?: { code?: number } };
      expect(typeof parsed.error?.code).toBe("number");
    }
  });
});
