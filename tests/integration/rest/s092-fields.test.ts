// S-092 REST field selection (K-023, K-027): `fields` allowlist projection
// on the analyze routes. Written first per A-21 (red): the server has no
// `fields` support and no `inject` hook yet, so every test below fails
// until the story is implemented. In-process `inject` only; no listener is
// opened and no outbound network happens in this file.
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
const TEST_API_KEY = "test-key-for-fields-suite-only";
const TEST_PEPPER = "test-pepper-for-fields-suite-only";

function testServer(analyzeCalls: { count: number }): RestServer {
  const codes = new Map<string, string>([[mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE]]);
  const rpcFake = new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK)));
  const inner = createAppServices(
    {
      rpc: rpcFake,
      modelArtifacts: placeholderArtifact(),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
    mustDefaultDetectorSet(),
  );
  const services: AppServices = Object.freeze({
    analyzeToken: async (input) => {
      analyzeCalls.count += 1;
      return inner.analyzeToken(input);
    },
    resolveProxy: (input) => inner.resolveProxy(input),
  });
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

describe("REST field selection (S-092)", () => {
  test("s092_fields_projection_returns_only_listed_sections", async () => {
    const server = testServer({ count: 0 });
    try {
      const response = await server.inject({
        method: "GET",
        url: `/v1/analyze?address=${TEST_ADDRESS}&fields=score,probabilities`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["kind", "probabilities", "score"]);
      expect(body["kind"]).toBe("assessed");
      expect(typeof body["score"]).toBe("number");
    } finally {
      await server.close();
    }
  });

  test("s092_unknown_field_fails_with_validation_error", async () => {
    const calls = { count: 0 };
    const server = testServer(calls);
    try {
      const before = calls.count;
      const response = await server.inject({
        method: "GET",
        url: `/v1/analyze?address=${TEST_ADDRESS}&fields=score,no-such-section`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body) as Record<string, unknown>;
      expect(body["code"]).toBe("validation-error");
      expect(calls.count).toBe(before);
    } finally {
      await server.close();
    }
  });

  test("s092_absent_fields_returns_full_envelope", async () => {
    const server = testServer({ count: 0 });
    try {
      const full = await server.inject({
        method: "GET",
        url: `/v1/analyze?address=${TEST_ADDRESS}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(full.statusCode).toBe(200);
      const second = await server.inject({
        method: "GET",
        url: `/v1/analyze?address=${TEST_ADDRESS}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(second.body).toBe(full.body);
      const body = JSON.parse(full.body) as Record<string, unknown>;
      expect(body["kind"]).toBe("assessed");
      expect(typeof body["score"]).toBe("number");
      expect(Array.isArray(body["signals"])).toBe(true);
    } finally {
      await server.close();
    }
  });
});
