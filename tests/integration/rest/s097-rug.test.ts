// S-097 AI rug narrative plugin over REST (K-302, K-305, K-309):
// opt-in capability summary for the top risk type over the frozen
// analysis. Written first per A-21 (red): no `/v1/rug` route and no
// `rugService` option exist yet, so every test below fails until the story
// is implemented. In-process `inject` only with the fake adapter; no
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
import { createRugService } from "../../../src/application/rugService.ts";
import type { RugService } from "../../../src/application/rugService.ts";
import { SecretString } from "../../../src/ports/config.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeRugModelAdapter } from "../../fakes/fakeRugModel.ts";
import type { FakeRugMode } from "../../fakes/fakeRugModel.ts";
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

const TEST_ADDRESS = "0x030405060708090a0b0c0d0e0f10111213141516";
// Honest dispatcher: PUSH2 destination points at the JUMPDEST body, so the
// reachability walk attributes the SELFDESTRUCT to this selector.
const TEST_BYTECODE = "0x8063a9059cbb1461000b575bff";
const TEST_BLOCK = 18000000;
const TEST_API_KEY = "test-key-for-rug-suite-only";
const TEST_PEPPER = "test-pepper-for-rug-suite-only";

function testServer(rug: RugService | undefined): RestServer {
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
    rugService: rug,
  });
}

function serverWithFake(mode: FakeRugMode): { server: RestServer; fake: FakeRugModelAdapter } {
  const fake = new FakeRugModelAdapter(mode);
  return { server: testServer(createRugService(fake)), fake };
}

async function postRug(server: RestServer): Promise<{ statusCode: number; body: unknown }> {
  const response = await server.inject({
    method: "POST",
    url: "/v1/rug",
    headers: { "x-api-key": TEST_API_KEY, "content-type": "application/json" },
    payload: JSON.stringify({ address: TEST_ADDRESS }),
  });
  return { statusCode: response.statusCode, body: JSON.parse(response.body) as unknown };
}

describe("AI rug narrative plugin over REST (S-097)", () => {
  test("s097_rug_without_key_reports_not_configured_and_sends_nothing", async () => {
    // No port is wired (the opt-in key is absent), so the disabled service
    // answers without any provider call and the deterministic analysis
    // stands beside it.
    const fake = new FakeRugModelAdapter("ok");
    const server = testServer(createRugService(null));
    try {
      const posted = await postRug(server);
      expect(posted.statusCode).toBe(200);
      const body = posted.body as { rug: { kind: string } };
      expect(body.rug.kind).toBe("not-configured");
      expect(fake.calls.length).toBe(0);
      const direct = await server.inject({
        method: "GET",
        url: `/v1/analyze?address=${TEST_ADDRESS}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(direct.statusCode).toBe(200);
      expect(typeof (JSON.parse(direct.body) as { score: unknown }).score).toBe("number");
    } finally {
      await server.close();
    }
  });

  test("s097_rug_keeps_only_sentences_citing_collected_evidence", async () => {
    const { server, fake } = serverWithFake("mixed");
    try {
      const posted = await postRug(server);
      expect(posted.statusCode).toBe(200);
      expect(fake.calls.length).toBe(1);
      const body = posted.body as {
        topRisk: string;
        rug: { kind: string; narrative: string[]; droppedClaims: number; provider: string; modelId: string };
      };
      expect(body.rug.kind).toBe("ok");
      const cited = fake.calls[0]?.evidenceIds[0];
      expect(cited?.startsWith("signal:")).toBe(true);
      expect(body.rug.narrative).toEqual([`The top risk capability is present. [E:${cited}]`]);
      expect(body.rug.droppedClaims).toBe(2);
      expect(["rug-pull", "honeypot", "bot-pump"]).toContain(body.topRisk);
      expect(fake.calls[0]?.topRisk).toBe(body.topRisk);
      expect(typeof body.rug.provider).toBe("string");
      expect(typeof body.rug.modelId).toBe("string");
    } finally {
      await server.close();
    }
  });

  test("s097_rug_leaves_score_and_evidence_unchanged", async () => {
    async function analyzeBody(server: RestServer): Promise<string> {
      const response = await server.inject({
        method: "GET",
        url: `/v1/analyze?address=${TEST_ADDRESS}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(response.statusCode).toBe(200);
      return response.body;
    }
    const cases: Array<{ server: RestServer }> = [
      serverWithFake("ok"),
      serverWithFake("invalid-output"),
      { server: testServer(createRugService(null)) },
      { server: testServer(undefined) },
    ];
    try {
      const primary = cases[0];
      if (primary === undefined) {
        throw new Error("expected at least one rug case");
      }
      const before = await analyzeBody(primary.server);
      for (const entry of cases) {
        const posted = await postRug(entry.server);
        expect(posted.statusCode).toBe(200);
        expect(await analyzeBody(entry.server)).toBe(before);
      }
    } finally {
      for (const entry of cases) {
        await entry.server.close();
      }
    }
  });
});
