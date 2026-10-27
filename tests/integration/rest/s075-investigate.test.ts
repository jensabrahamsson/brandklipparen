// S-075 investigate exposure tests (K-036, K-023, K-025, K-027, K-508).
// Written first per A-21 (red): POST /v1/investigate,
// GET /v1/investigate/events and the investigate_token MCP tool do not
// exist yet, so every test below fails until the exposure is implemented.
// All ports are in-memory fakes; the servers run in-process with a
// scripted investigation adapter. No outbound network happens here.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parseModelArtifact } from "../../../src/domain/risk.ts";
import type { Result } from "../../../src/domain/result.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  IndexVersion,
  ModelId,
  ModelVersion,
  TemplateVersion,
  Timestamp,
} from "../../../src/domain/types.ts";
import type { CapabilityCatalogue } from "../../../src/domain/signals.ts";
import { createAppServices } from "../../../src/application/analyzeToken.ts";
import type { AppServices } from "../../../src/application/analyzeToken.ts";
import { createInvestigationService } from "../../../src/application/investigationService.ts";
import type { InvestigationService } from "../../../src/application/investigationService.ts";
import { SecretString } from "../../../src/ports/config.ts";
import type {
  InvestigationDecision,
  InvestigationModelError,
  InvestigationModelInput,
  InvestigationModelPort,
} from "../../../src/ports/investigationModel.ts";
import { ok } from "../../../src/domain/result.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { createRestServer } from "../../../src/interfaces/rest/server.ts";
import type { RestServer } from "../../../src/interfaces/rest/server.ts";
import { createMcpServer } from "../../../src/interfaces/mcp/server.ts";
import type { McpServer } from "../../../src/interfaces/mcp/server.ts";
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
      checksum: mustOk(ArtifactChecksum.parse("ab".repeat(32))),
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
const TEST_API_KEY = "test-key-for-investigate-suite-only";
const TEST_PEPPER = "test-pepper-for-investigate-suite-only";

// Scripted adapter: lists evidence, then concludes with a draft citing the
// first collected id. The decision derives from the input trace alone, so
// repeated investigations over the same facts give identical envelopes.
// Deterministic with zero network.
function scriptedAdapter(): InvestigationModelPort {
  return {
    provider: () => "hosted-open-weights",
    modelId: () => mustOk(ModelId.parse("meta-models/muse-spark-open-1026")),
    async decide(
      input: InvestigationModelInput,
    ): Promise<Result<InvestigationDecision, InvestigationModelError>> {
      if (input.trace.length === 0) {
        return ok({
          kind: "run-tool",
          toolId: "evidence.list",
          args: {},
          rationale: "List the frozen evidence first.",
        });
      }
      const first = input.trace[0]?.evidenceIds[0] ?? "sig-1";
      return ok({ kind: "conclude", narrativeDraft: `The frozen evidence shows the finding. [E:${first}]` });
    },
  };
}

let rest: RestServer;
let mcp: McpServer;
let baseUrl = "";
let services: AppServices;

function freshInvestigation(detectors: ReturnType<typeof mustDefaultDetectorSet>): InvestigationService {
  return createInvestigationService({
    adapter: scriptedAdapter(),
    detectors,
    docs: {},
    limits: { maxSteps: 8, maxTokens: 8000, deadlineMs: 30000, toolTimeoutMs: 1000 },
  });
}

async function startRestServer(): Promise<{ server: RestServer; url: string }> {
  const detectors = mustDefaultDetectorSet();
  const server = createRestServer({
    services,
    apiKeys: [new SecretString(TEST_API_KEY)],
    apiKeyPepper: new SecretString(TEST_PEPPER),
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
    detectors,
    investigationService: freshInvestigation(detectors),
  });
  const url = await server.listen("127.0.0.1", 0);
  return { server, url };
}

beforeAll(async () => {
  const codes = new Map<string, string>([[mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE]]);
  const rpcFake = new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK)));
  services = createAppServices(
    {
      rpc: rpcFake,
      modelArtifacts: placeholderArtifact(),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
    mustDefaultDetectorSet(),
  );
  const detectors = mustDefaultDetectorSet();
  const started = await startRestServer();
  rest = started.server;
  baseUrl = started.url;
  mcp = createMcpServer({
    services,
    apiKeys: [new SecretString(TEST_API_KEY)],
    apiKeyPepper: new SecretString(TEST_PEPPER),
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
    detectors,
    investigationService: freshInvestigation(detectors),
  });
});

afterAll(async () => {
  await rest.close();
});

async function postInvestigate(key?: string): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== undefined) {
    headers["x-api-key"] = key;
  }
  const response = await fetch(`${baseUrl}/v1/investigate`, {
    method: "POST",
    headers,
    body: JSON.stringify({ address: TEST_ADDRESS }),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

describe("investigate exposure", () => {
  test("k036_investigate_matches_across_rest_and_mcp_for_same_codehash", async () => {
    const posted = await postInvestigate(TEST_API_KEY);
    expect(posted.status).toBe(200);
    const restBody = posted.body as { investigation: unknown; codeHash: string };
    const toolResult = await mcp.callTool(
      "investigate_token",
      { address: TEST_ADDRESS },
      { apiKey: TEST_API_KEY },
    );
    expect(toolResult.ok).toBe(true);
    if (!toolResult.ok) {
      return;
    }
    const mcpBody = JSON.parse(toolResult.value.content[0]?.text ?? "{}") as {
      investigation: unknown;
      codeHash: string;
    };
    expect(mcpBody.codeHash).toBe(restBody.codeHash);
    expect(mcpBody.investigation).toEqual(restBody.investigation);
  });

  test("k036_events_stream_emits_one_event_per_step_then_report", async () => {
    // A fresh server per stream test: the stream proves the S-075 fresh-run
    // shape (one event per step, then the report) independent of any
    // report caching a later story adds.
    const fresh = await startRestServer();
    try {
      const before = await (
        await fetch(`${fresh.url}/v1/analyze?address=${TEST_ADDRESS}`, {
          headers: { "x-api-key": TEST_API_KEY },
        })
      ).json();
      const response = await fetch(`${fresh.url}/v1/investigate/events?address=${TEST_ADDRESS}`, {
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const text = await response.text();
      const events = text.split("\n\n").filter((chunk) => chunk.includes("data:"));
      expect(events.length).toBeGreaterThanOrEqual(2);
      const kinds = events.map((chunk) => {
        const line = chunk.split("\n").find((entry) => entry.startsWith("data:")) ?? "";
        return (JSON.parse(line.slice("data:".length).trim()) as { kind: string }).kind;
      });
      for (let index = 0; index < kinds.length - 1; index += 1) {
        expect(kinds[index]).toBe("step");
      }
      expect(kinds[kinds.length - 1]).toBe("report");
      const after = await (
        await fetch(`${fresh.url}/v1/analyze?address=${TEST_ADDRESS}`, {
          headers: { "x-api-key": TEST_API_KEY },
        })
      ).json();
      expect(after).toEqual(before);
    } finally {
      await fresh.server.close();
    }
  });

  test("k024_missing_or_invalid_key_rejected_before_investigation", async () => {
    const missing = await postInvestigate(undefined);
    expect(missing.status).toBe(401);
    const wrong = await postInvestigate("wrong-key");
    expect(wrong.status).toBe(401);
    const events = await fetch(`${baseUrl}/v1/investigate/events?address=${TEST_ADDRESS}`);
    expect(events.status).toBe(401);
  });

  test("k026_investigate_tool_leaves_state_unchanged", async () => {
    const first = await mcp.callTool("investigate_token", { address: TEST_ADDRESS }, { apiKey: TEST_API_KEY });
    const second = await mcp.callTool("investigate_token", { address: TEST_ADDRESS }, { apiKey: TEST_API_KEY });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(second.value).toEqual(first.value);
    const unknown = await mcp.callTool("investigate_token", { address: "0xblooper" }, { apiKey: TEST_API_KEY });
    expect(unknown.ok).toBe(false);
  });
});
