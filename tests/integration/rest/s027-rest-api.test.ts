// S-027 REST API tests (K-023, K-024, K-504, K-510): versioned REST API as a
// thin driving adapter over the shared application service.
// Written first per A-21 (red): src/interfaces/rest does not exist yet, so
// every test below fails until the adapter is implemented. All ports are
// in-memory fakes; the server binds an ephemeral local port and the tests
// use in-process HTTP requests. No outbound network happens in this file.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Ajv } from "ajv";
import { parseModelArtifact } from "../../../src/domain/risk.ts";
import { err } from "../../../src/domain/result.ts";
import type { Result } from "../../../src/domain/result.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  IndexVersion,
  ModelVersion,
  RequestId,
  TemplateVersion,
  Timestamp,
} from "../../../src/domain/types.ts";
import type { BlockNumber as BlockNumberType } from "../../../src/domain/types.ts";
import type { CapabilityCatalogue } from "../../../src/domain/signals.ts";
import { createAppServices, serializeAssessment } from "../../../src/application/analyzeToken.ts";
import type { AnalyzeTokenSuccess, AppServices } from "../../../src/application/analyzeToken.ts";
import { SecretString } from "../../../src/ports/config.ts";
import type { RpcError } from "../../../src/ports/rpc.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { createRestServer } from "../../../src/interfaces/rest/server.ts";
import type { RestServer } from "../../../src/interfaces/rest/server.ts";
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const schemaPath = join(repoRoot, "src", "interfaces", "rest", "schema", "v1.json");

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
      checksum: mustOk(ArtifactChecksum.parse("cd".repeat(32))),
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
const TEST_API_KEY = "test-key-for-rest-suite-only";
const TEST_PEPPER = "test-pepper-for-rest-suite-only";

function testServices(
  rpc?: FakeRpcAdapter,
  onAnalyze?: () => void,
): { services: AppServices; rpcFake: FakeRpcAdapter } {
  const codes = new Map<string, string>([[mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE]]);
  const rpcFake = rpc ?? new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK)));
  const inner = createAppServices({
    rpc: rpcFake,
    modelArtifacts: placeholderArtifact(),
    clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
  },
  mustDefaultDetectorSet());
  const services: AppServices = Object.freeze({
    analyzeToken: async (input) => {
      onAnalyze?.();
      return inner.analyzeToken(input);
    },
    resolveProxy: (input) => inner.resolveProxy(input),
  });
  return { services, rpcFake };
}

function testServerOptions() {
  return {
    apiKeys: [new SecretString(TEST_API_KEY)] as readonly SecretString[],
    apiKeyPepper: new SecretString(TEST_PEPPER),
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
  };
}

describe("versioned REST API over the shared service (S-027)", () => {
  let server: RestServer;
  let baseUrl: string;
  let analyzeCalls = 0;

  beforeAll(async () => {
    const { services } = testServices(undefined, () => {
      analyzeCalls += 1;
    });
    server = createRestServer({ detectors: mustDefaultDetectorSet(), services, ...testServerOptions() });
    baseUrl = await server.listen("127.0.0.1", 0);
  });

  afterAll(async () => {
    await server.close();
  });

  test("k023_all_routes_under_v1", async () => {
    const authed = { headers: { "x-api-key": TEST_API_KEY } };
    const analyze = await fetch(`${baseUrl}/v1/analyze?address=${TEST_ADDRESS}`, authed);
    expect(analyze.status).toBe(200);
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    // The unversioned analysis path does not exist; only /v1 carries the API
    // beside the documented public /health check per I-12.
    const unversioned = await fetch(`${baseUrl}/analyze?address=${TEST_ADDRESS}`, authed);
    expect(unversioned.status).toBe(404);
  });

  test("k023_response_matches_published_schema", async () => {
    const response = await fetch(`${baseUrl}/v1/analyze?address=${TEST_ADDRESS}`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
    const ajv = new Ajv({ strict: true });
    const validate = ajv.compile(schema);
    expect(validate(JSON.parse(body))).toBe(true);
  });

  test("k023_error_shape_has_status_code_message_request_id", async () => {
    const uuidPattern =
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    const badAddress = await fetch(`${baseUrl}/v1/analyze?address=not-an-address`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(badAddress.status).toBe(400);
    const badBody = (await badAddress.json()) as Record<string, unknown>;
    expect(typeof badBody["status"]).toBe("number");
    expect(typeof badBody["code"]).toBe("string");
    expect(typeof badBody["message"]).toBe("string");
    expect(uuidPattern.test(String(badBody["requestId"]))).toBe(true);

    const missingKey = await fetch(`${baseUrl}/v1/analyze?address=${TEST_ADDRESS}`);
    expect(missingKey.status).toBe(401);
    const missingBody = (await missingKey.json()) as Record<string, unknown>;
    expect(typeof missingBody["status"]).toBe("number");
    expect(typeof missingBody["code"]).toBe("string");
    expect(typeof missingBody["message"]).toBe("string");
    expect(uuidPattern.test(String(missingBody["requestId"]))).toBe(true);
  });

  test("k024_missing_or_invalid_key_rejected_before_analysis", async () => {
    const before = analyzeCalls;
    const missing = await fetch(`${baseUrl}/v1/analyze?address=${TEST_ADDRESS}`);
    expect(missing.status).toBe(401);
    const invalid = await fetch(`${baseUrl}/v1/analyze?address=${TEST_ADDRESS}`, {
      headers: { "x-api-key": "wrong-key" },
    });
    expect(invalid.status).toBe(401);
    expect(analyzeCalls).toBe(before);
  });

  test("k510_key_in_url_or_body_rejected", async () => {
    const before = analyzeCalls;
    const inUrl = await fetch(`${baseUrl}/v1/analyze?address=${TEST_ADDRESS}&api_key=${TEST_API_KEY}`);
    expect(inUrl.status).toBe(401);
    const inUrlBody = (await inUrl.json()) as Record<string, unknown>;
    expect(inUrlBody["code"]).toBe("key-in-url-or-body");
    const inBody = await fetch(`${baseUrl}/v1/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": TEST_API_KEY },
      body: JSON.stringify({ address: TEST_ADDRESS, api_key: TEST_API_KEY }),
    });
    expect(inBody.status).toBe(401);
    const inBodyJson = (await inBody.json()) as Record<string, unknown>;
    expect(inBodyJson["code"]).toBe("key-in-url-or-body");
    expect(analyzeCalls).toBe(before);
  });

  test("k504_oversized_input_rejected_before_analysis", async () => {
    const before = analyzeCalls;
    // Past the documented query cap, so the adapter itself turns the input
    // away with the uniform error format before analysis.
    const hugeQuery = `0x${"ab".repeat(1500)}`;
    const oversized = await fetch(`${baseUrl}/v1/analyze?address=${encodeURIComponent(hugeQuery)}`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(oversized.status).toBe(413);
    const oversizedBody = (await oversized.json()) as Record<string, unknown>;
    expect(oversizedBody["code"]).toBe("request-too-large");
    // Past the documented body cap, so the framework limit maps to the same
    // error shape before analysis.
    const hugeBody = await fetch(`${baseUrl}/v1/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": TEST_API_KEY },
      body: JSON.stringify({ address: `0x${"ab".repeat(5000)}` }),
    });
    expect(hugeBody.status).toBe(413);
    const hugeBodyJson = (await hugeBody.json()) as Record<string, unknown>;
    expect(hugeBodyJson["code"]).toBe("request-too-large");
    expect(analyzeCalls).toBe(before);
  });

  test("k510_error_responses_carry_no_secrets_or_internals", async () => {
    const secretKey = "test-key-for-rest-suite-only";
    const invalidKey = await fetch(`${baseUrl}/v1/analyze?address=${TEST_ADDRESS}`, {
      headers: { "x-api-key": secretKey.slice(0, 8) },
    });
    const invalidText = await invalidKey.text();
    expect(invalidText).not.toContain(secretKey);
    expect(invalidText).not.toContain("test-pepper-for-rest-suite-only");
    expect(invalidText).not.toContain("node_modules");
    expect(invalidText).not.toContain("at ");

    class FailingRpc extends FakeRpcAdapter {
      override async getCode(): Promise<Result<never, RpcError>> {
        return err({ kind: "rate-limited", message: "upstream says slow down" } as RpcError);
      }
    }
    const failing = testServices(
      new FailingRpc(
        new Map<string, string>([[mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE]]),
        mustOk(BlockNumber.of(TEST_BLOCK)),
      ),
    );
    const failingServer = createRestServer({ detectors: mustDefaultDetectorSet(), services: failing.services, ...testServerOptions() });
    const failingBase = await failingServer.listen("127.0.0.1", 0);
    try {
      const upstream = await fetch(`${failingBase}/v1/analyze?address=${TEST_ADDRESS}`, {
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(upstream.status).toBe(502);
      const upstreamBody = (await upstream.json()) as Record<string, unknown>;
      const text = JSON.stringify(upstreamBody);
      expect(text).not.toContain("upstream says slow down");
      expect(text).not.toContain(secretKey);
      expect(text).not.toContain("test-pepper-for-rest-suite-only");
      expect(typeof upstreamBody["requestId"]).toBe("string");
    } finally {
      await failingServer.close();
    }
  });

  test("k023_same_input_gives_byte_identical_body", async () => {
    const direct = await fetch(`${baseUrl}/v1/analyze?address=${TEST_ADDRESS}`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    const first = await direct.text();
    const repeated = await fetch(`${baseUrl}/v1/analyze?address=${TEST_ADDRESS}`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(await repeated.text()).toBe(first);

    // The HTTP body is the service output byte for byte: the same typed
    // input through AppServices serialises to the identical string.
    const { services } = testServices();
    const address = mustOk(Address.parse(TEST_ADDRESS));
    const analysed: AnalyzeTokenSuccess = await (async () => {
      const result = await services.analyzeToken({
        address,
        block: mustOk(BlockNumber.of(TEST_BLOCK)) as BlockNumberType,
        requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
        deadline: mustOk(Timestamp.of(1700000005000)),
        modelVersion: mustOk(ModelVersion.parse("0.1.0")),
        indexVersion: mustOk(IndexVersion.parse("1.0.0")),
        templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
        catalogue: TEST_CATALOGUE,
      });
      if (!result.ok) {
        throw new Error("expected assessed service result");
      }
      return result.value;
    })();
    if (analysed.kind !== "assessed") {
      throw new Error("expected assessed envelope");
    }
    expect(first).toBe(serializeAssessment(analysed.envelope));
  });

  test("c23_unexpected_throw_is_500_internal_error", async () => {
    const { services } = testServices();
    const throwing = Object.freeze({
      analyzeToken: async (): Promise<never> => {
        throw new Error("synthetic service failure");
      },
      resolveProxy: services.resolveProxy,
    });
    const faulty = createRestServer({
      detectors: mustDefaultDetectorSet(),
      services: throwing,
      ...testServerOptions(),
    });
    const faultyBase = await faulty.listen("127.0.0.1", 0);
    try {
      const response = await fetch(`${faultyBase}/v1/analyze?address=${TEST_ADDRESS}`, {
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(response.status).toBe(500);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["code"]).toBe("internal-error");
      expect(body["status"]).toBe(500);
      expect(typeof body["requestId"]).toBe("string");
      expect(response.headers.get("x-request-id")).toBe(String(body["requestId"]));
      expect(JSON.stringify(body)).not.toContain("synthetic service failure");
    } finally {
      await faulty.close();
    }
  });

  test("c23_malformed_json_still_400", async () => {
    const response = await fetch(`${baseUrl}/v1/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": TEST_API_KEY },
      body: '{"address":',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("validation-error");
  });
});
