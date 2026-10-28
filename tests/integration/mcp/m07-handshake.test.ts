// MCP dated-protocol handshake (S-107, K-021): the server negotiates the
// dated protocol version the SDK client sends, answers with its supported
// version and server info, turns an unsupported version away with a
// machine-readable mismatch error, and fails closed on tool calls without
// a key when keys are configured. Written first (red) per A-21: the
// server answers every initialize without negotiating. No network; the
// frames below mirror what the official SDK client sends over stdio.
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
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { createMcpServer } from "../../../src/interfaces/mcp/server.ts";
import type { McpServer } from "../../../src/interfaces/mcp/server.ts";
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";

const TEST_API_KEY = "test-key-for-handshake-suite-only";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function placeholderServices(): AppServices {
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
  return createAppServices(
    {
      rpc: new FakeRpcAdapter(codes, mustOk(BlockNumber.of(18000000))),
      modelArtifacts: new FakeModelArtifactAdapter(
        Object.freeze({ artifact, checksum: mustOk(ArtifactChecksum.parse("ef".repeat(32))) }),
      ),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
    mustDefaultDetectorSet(),
  );
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

function frame(method: string, params: unknown, id: number): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

describe("MCP handshake negotiation (S-107)", () => {
  test("m07_initialize_handshake_against_sdk_client", async () => {
    const mcp: McpServer = createMcpServer({
      detectors: mustDefaultDetectorSet(),
      services: placeholderServices(),
      ...serverOptions(),
    });
    // The SDK client opens with its protocol version, capabilities and
    // client info; the server negotiates the dated version it supports.
    const opened = JSON.parse(
      await mcp.handleJsonRpc(
        frame(
          "initialize",
          {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test-sdk-client", version: "0.0.0" },
          },
          1,
        ),
      ),
    ) as {
      result?: { protocolVersion?: unknown; capabilities?: unknown; serverInfo?: unknown };
    };
    expect(opened.result?.protocolVersion).toBe("2025-06-18");
    expect(opened.result?.capabilities).toEqual({ tools: {} });
    expect(opened.result?.serverInfo).toMatchObject({ name: "brandklipparen-mcp" });

    // An unsupported version fails closed with a machine-readable error
    // instead of a silent downgrade.
    const mismatched = JSON.parse(
      await mcp.handleJsonRpc(frame("initialize", { protocolVersion: "1999-01-01" }, 2)),
    ) as { error?: { code?: unknown; data?: { code?: unknown } } };
    expect(mismatched.error?.code).toBe(-32602);
    expect(mismatched.error?.data?.code).toBe("protocol-version-mismatch");

    // A keyed server fails closed on a tool call without a key.
    const keyed: McpServer = createMcpServer({
      detectors: mustDefaultDetectorSet(),
      services: placeholderServices(),
      ...serverOptions(),
      apiKeys: [new SecretString(TEST_API_KEY)],
    });
    const unkeyed = JSON.parse(
      await keyed.handleJsonRpc(
        frame(
          "tools/call",
          {
            name: "assess_token",
            arguments: { address: "0x0102030405060708090a0b0c0d0e0f1011121314" },
          },
          3,
        ),
      ),
    ) as { error?: { data?: { code?: unknown } } };
    expect(unkeyed.error?.data?.code).toBe("missing-api-key");
  });
});
