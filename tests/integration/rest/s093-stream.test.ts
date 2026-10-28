// S-093 REST streaming analysis events (K-023, K-027, K-101): the analysis
// streams over the existing server as one SSE body (analysis first, then
// the deepening status) with no hijacked socket. Written first per A-21
// (red): no `/v1/analyze/stream` route exists yet, so every test below
// fails until the story is implemented. In-process `inject` only; no
// listener is opened and no outbound network happens in this file.
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

const TEST_ADDRESS = "0x0102030405060708090a0b0c0d0e0f1011121314";
const TEST_BYTECODE = `0x8063a9059cbb14600a57${"00".repeat(10)}ff`;
const TEST_BLOCK = 18000000;
const TEST_API_KEY = "test-key-for-stream-suite-only";
const TEST_PEPPER = "test-pepper-for-stream-suite-only";

function testServer(): RestServer {
  const codes = new Map<string, string>([[mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE]]);
  const rpcFake = new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK)));
  const services: AppServices = createAppServices(
    {
      rpc: rpcFake,
      modelArtifacts: placeholderArtifact(),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
    mustDefaultDetectorSet(),
  );
  return createRestServer({
    services,
    apiKeys: [new SecretString(TEST_API_KEY)] as readonly SecretString[],
    apiKeyPepper: new SecretString(TEST_PEPPER),
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
    detectors: mustDefaultDetectorSet(),
  });
}

function streamEvents(body: string): unknown[] {
  return body
    .split("\n\n")
    .filter((chunk) => chunk.includes("data:"))
    .map((chunk) => {
      const line = chunk.split("\n").find((entry) => entry.startsWith("data:")) ?? "";
      return JSON.parse(line.slice("data:".length).trim()) as unknown;
    });
}

describe("REST streaming analysis events (S-093)", () => {
  test("s093_stream_emits_analysis_then_deepening_status", async () => {
    const server = testServer();
    try {
      const response = await server.inject({
        method: "GET",
        url: `/v1/analyze/stream?address=${TEST_ADDRESS}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(response.statusCode).toBe(200);
      expect(String(response.headers["content-type"])).toContain("text/event-stream");
      const events = streamEvents(response.body);
      expect(events.length).toBe(2);
      const first = events[0] as Record<string, unknown>;
      expect(first["kind"]).toBe("assessed");
      expect(typeof first["score"]).toBe("number");
      const last = events[1] as Record<string, unknown>;
      expect(last["kind"]).toBe("deepening");
      expect(last["status"]).toBe("pending");
      const direct = await server.inject({
        method: "GET",
        url: `/v1/analyze?address=${TEST_ADDRESS}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(JSON.parse(direct.body)).toEqual(first);
    } finally {
      await server.close();
    }
  });

  test("s093_stream_leaves_analyze_body_unchanged", async () => {
    const server = testServer();
    try {
      const before = await server.inject({
        method: "GET",
        url: `/v1/analyze?address=${TEST_ADDRESS}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(before.statusCode).toBe(200);
      const streamed = await server.inject({
        method: "GET",
        url: `/v1/analyze/stream?address=${TEST_ADDRESS}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(streamed.statusCode).toBe(200);
      const after = await server.inject({
        method: "GET",
        url: `/v1/analyze?address=${TEST_ADDRESS}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(after.body).toBe(before.body);
    } finally {
      await server.close();
    }
  });

  test("s093_stream_key_gate_matches_analyze", async () => {
    const server = testServer();
    try {
      const missing = await server.inject({
        method: "GET",
        url: `/v1/analyze/stream?address=${TEST_ADDRESS}`,
      });
      expect(missing.statusCode).toBe(401);
      const body = JSON.parse(missing.body) as Record<string, unknown>;
      expect(typeof body["code"]).toBe("string");
    } finally {
      await server.close();
    }
  });
});
