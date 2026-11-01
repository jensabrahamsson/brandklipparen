// Rate and quota limits with retryable machine errors (K-504, M-08, M-09).
// Written first per A-21 (red): src/interfaces/rest/rateLimit.ts does not
// exist yet, so the import below fails until the limiter is implemented.
// The limiter is in-process with an injected clock, so tests use a fake
// clock instead of a load cluster. Fakes and frozen fixtures only.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createRateLimiter } from "../../../src/interfaces/rest/rateLimit.ts";
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
import type { Result } from "../../../src/domain/result.ts";
import type { CapabilityCatalogue } from "../../../src/domain/signals.ts";
import { createAppServices } from "../../../src/application/analyzeToken.ts";
import { analyzeToken } from "../../../src/application/analyzeToken.ts";
import type { CacheKey as CacheKeyType } from "../../../src/domain/types.ts";
import { SecretString } from "../../../src/ports/config.ts";
import type { RpcError } from "../../../src/ports/rpc.ts";
import type { BytecodeResult } from "../../../src/ports/rpc.ts";
import type { RpcPort } from "../../../src/ports/rpc.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { FakeCacheAdapter } from "../../fakes/fakeCache.ts";
import { parseModelArtifact } from "../../../src/domain/risk.ts";
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
const TEST_API_KEY = "test-key-for-ratelimit-suite-only";
const TEST_PEPPER = "test-pepper-for-ratelimit-suite-only";

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

// RPC port that always fails: simulates a provider outage after the cache
// was primed, so the test proves cache hits keep responding (M-09).
class OutageRpcAdapter implements RpcPort {
  getCodeCalls = 0;
  async getCode(): Promise<Result<BytecodeResult, RpcError>> {
    this.getCodeCalls += 1;
    return { ok: false, error: { kind: "node-error", message: "fake rpc provider is down" } };
  }
  async getStorageAt(): Promise<Result<never, RpcError>> {
    return { ok: false, error: { kind: "node-error", message: "fake rpc provider is down" } };
  }
  async call(): Promise<Result<never, RpcError>> {
    return { ok: false, error: { kind: "node-error", message: "fake rpc provider is down" } };
  }
  async getBlockNumber(): Promise<Result<never, RpcError>> {
    return { ok: false, error: { kind: "node-error", message: "fake rpc provider is down" } };
  }
  async getLogs(): Promise<Result<never, RpcError>> {
    return { ok: false, error: { kind: "node-error", message: "fake rpc provider is down" } };
  }
  async getBlockReceipts(): Promise<Result<never, RpcError>> {
    return { ok: false, error: { kind: "node-error", message: "fake rpc provider is down" } };
  }
}

describe("rate and cost limits (K-504, M-08, M-09)", () => {
  test("k504_over_limit_returns_retryable_machine_error", () => {
    let now = 1_700_000_000_000;
    const limiter = createRateLimiter(
      { perKeyPerMinute: 2, perKeyPerDay: 100, globalPerMinute: 1000 },
      () => now,
    );
    expect(limiter.check("key-a")).toEqual({ allowed: true });
    expect(limiter.check("key-a")).toEqual({ allowed: true });
    const denied = limiter.check("key-a");
    expect(denied.allowed).toBe(false);
    if (denied.allowed) {
      throw new Error("expected the third call to be denied");
    }
    expect(denied.retryAfterSec).toBeGreaterThan(0);
    // Another key is unaffected, and the window sliding past the first
    // calls readmits the limited key.
    expect(limiter.check("key-b")).toEqual({ allowed: true });
    now += 61_000;
    expect(limiter.check("key-a")).toEqual({ allowed: true });
  });

  test("k504_over_limit_returns_retryable_machine_error_over_rest", async () => {
    let server: RestServer | null = null;
    try {
      const codes = new Map<string, string>([
        [mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE],
      ]);
      const services = createAppServices({
        rpc: new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK))),
        modelArtifacts: placeholderArtifact(),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      },
  mustDefaultDetectorSet());
      server = createRestServer({ detectors: mustDefaultDetectorSet(),
        services,
        ...testServerOptions(),
        rateLimit: { perKeyPerMinute: 2, perKeyPerDay: 100, globalPerMinute: 1000 },
      });
      const baseUrl = await server.listen("127.0.0.1", 0);
      const authed = { headers: { "x-api-key": TEST_API_KEY } };
      expect((await fetch(`${baseUrl}/v1/analyze?address=${TEST_ADDRESS}`, authed)).status).toBe(200);
      expect((await fetch(`${baseUrl}/v1/analyze?address=${TEST_ADDRESS}`, authed)).status).toBe(200);
      const limited = await fetch(`${baseUrl}/v1/analyze?address=${TEST_ADDRESS}`, authed);
      expect(limited.status).toBe(429);
      const retryAfter = limited.headers.get("retry-after") ?? "";
      expect(retryAfter.length).toBeGreaterThan(0);
      expect(Number(retryAfter)).toBeGreaterThan(0);
      const body = (await limited.json()) as Record<string, unknown>;
      expect(body["code"]).toBe("rate-limited");
      expect(typeof body["requestId"]).toBe("string");
      expect(typeof body["message"]).toBe("string");
    } finally {
      await server?.close();
    }
  });

  test("k504_expensive_steps_require_key_with_quota", async () => {
    let server: RestServer | null = null;
    try {
      const codes = new Map<string, string>([
        [mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE],
      ]);
      const rpcFake = new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK)));
      const services = createAppServices({
        rpc: rpcFake,
        modelArtifacts: placeholderArtifact(),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      },
  mustDefaultDetectorSet());
      let analyses = 0;
      const counting = Object.freeze({
        analyzeToken: async (
          input: Parameters<typeof services.analyzeToken>[0],
          counters?: Parameters<typeof services.analyzeToken>[1],
        ) => {
          analyses += 1;
          return services.analyzeToken(input, counters);
        },
        resolveProxy: services.resolveProxy,
      });
      server = createRestServer({ detectors: mustDefaultDetectorSet(),
        services: counting,
        ...testServerOptions(),
        rateLimit: { perKeyPerMinute: 1000, perKeyPerDay: 1, globalPerMinute: 1000 },
      });
      const baseUrl = await server.listen("127.0.0.1", 0);
      // Missing and invalid keys are rejected before the first analysis
      // step on both the analysis and the assessment routes.
      const before = analyses;
      expect(
        (await fetch(`${baseUrl}/v1/analyze?address=${TEST_ADDRESS}`)).status,
      ).toBe(401);
      expect(
        (await fetch(`${baseUrl}/v1/analyze?address=${TEST_ADDRESS}`, {
          headers: { "x-api-key": "wrong-key" },
        })).status,
      ).toBe(401);
      expect(
        (
          await fetch(`${baseUrl}/v1/assessment?address=${TEST_ADDRESS}`, {
            method: "POST",
            headers: { "x-api-key": "wrong-key", "content-type": "application/json" },
            body: JSON.stringify({ address: TEST_ADDRESS }),
          })
        ).status,
      ).toBe(401);
      expect(analyses).toBe(before);
      // The single daily quota allows one expensive analysis; the next one
      // is rejected with a retryable error and zero new analysis calls.
      const authed = { headers: { "x-api-key": TEST_API_KEY } };
      expect((await fetch(`${baseUrl}/v1/analyze?address=${TEST_ADDRESS}`, authed)).status).toBe(200);
      const afterQuota = analyses;
      const capped = await fetch(`${baseUrl}/v1/analyze?address=${TEST_ADDRESS}`, authed);
      expect(capped.status).toBe(429);
      expect(((await capped.json()) as Record<string, unknown>)["code"]).toBe("rate-limited");
      expect(analyses).toBe(afterQuota);
    } finally {
      await server?.close();
    }
  });

  test("k504_limits_hold_under_overload_and_cache_serves", async () => {
    // Overload at the limiter: exactly the per-key budget is admitted.
    const now = 1_700_000_000_000;
    const limiter = createRateLimiter(
      { perKeyPerMinute: 5, perKeyPerDay: 1000, globalPerMinute: 1000 },
      () => now,
    );
    let admitted = 0;
    for (let i = 0; i < 50; i += 1) {
      if (limiter.check("flood-key").allowed) {
        admitted += 1;
      }
    }
    expect(admitted).toBe(5);
    // Cache serves while the provider is down: prime the shared address
    // index and the cache at a pinned block, then fail every RPC call.
    const address = mustOk(Address.parse(TEST_ADDRESS));
    const block = mustOk(BlockNumber.of(TEST_BLOCK));
    const codes = new Map<string, string>([[address as string, TEST_BYTECODE]]);
    const cache = new FakeCacheAdapter();
    const clock = new FakeClockAdapter(mustOk(Timestamp.of(1700000000000)));
    const addressIndex = new Map<string, CacheKeyType>();
    const first = await analyzeToken(
      {
        rpc: new FakeRpcAdapter(codes, block),
        modelArtifacts: placeholderArtifact(),
        clock,
        cache,
      },
      {
        address,
        block,
        requestId: mustOk(RequestId.parse("123e4567-e89b-42d3-a456-426614174000")),
        deadline: mustOk(Timestamp.of(1900000000000)),
        modelVersion: mustOk(ModelVersion.parse("0.1.0")),
        indexVersion: mustOk(IndexVersion.parse("1.0.0")),
        templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
        catalogue: TEST_CATALOGUE,
      },
      mustDefaultDetectorSet(),
      addressIndex);
    expect(first.ok).toBe(true);
    const outageRpc = new OutageRpcAdapter();
    const second = await analyzeToken(
      { rpc: outageRpc, modelArtifacts: placeholderArtifact(), clock, cache },
      {
        address,
        block,
        requestId: mustOk(RequestId.parse("123e4567-e89b-42d3-a456-426614174001")),
        deadline: mustOk(Timestamp.of(1900000000000)),
        modelVersion: mustOk(ModelVersion.parse("0.1.0")),
        indexVersion: mustOk(IndexVersion.parse("1.0.0")),
        templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
        catalogue: TEST_CATALOGUE,
      },
      mustDefaultDetectorSet(),
      addressIndex);
    expect(second.ok).toBe(true);
    if (first.ok && first.value.kind === "assessed" && second.ok && second.value.kind === "assessed") {
      expect(second.value.envelope.codeHash).toBe(first.value.envelope.codeHash as string);
      expect(second.value.envelope.score).toBe(first.value.envelope.score as number);
      expect(second.value.envelope.signals).toEqual(first.value.envelope.signals);
      expect(second.value.envelope.proxy).toEqual({ kind: "none" });
    } else {
      throw new Error("expected assessed outcomes on both runs");
    }
  });
});

describe("rate limiter over REST in isolation (K-504)", () => {
  let server: RestServer;
  let baseUrl: string;

  beforeAll(async () => {
    const codes = new Map<string, string>([
      [mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE],
    ]);
    const services = createAppServices({
      rpc: new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK))),
      modelArtifacts: placeholderArtifact(),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
  mustDefaultDetectorSet());
    server = createRestServer({ detectors: mustDefaultDetectorSet(),
      services,
      ...testServerOptions(),
      rateLimit: { perKeyPerMinute: 1000, perKeyPerDay: 1000, globalPerMinute: 1000 },
    });
    baseUrl = await server.listen("127.0.0.1", 0);
  });

  afterAll(async () => {
    await server.close();
  });

  test("sec1_s2_one_key_cannot_exhaust_the_global_window_for_other_keys", () => {
    const now = 1_700_000_000_000;
    const limiter = createRateLimiter(
      { perKeyPerMinute: 100, perKeyPerDay: 1000, globalPerMinute: 10, perKeyGlobalSharePercent: 50 },
      () => now,
    );
    let admittedA = 0;
    for (let i = 0; i < 20; i += 1) {
      if (limiter.check("key-a").allowed) admittedA += 1;
    }
    expect(admittedA).toBe(5);
    // The second key still has its reserved share of the global window.
    expect(limiter.check("key-b").allowed).toBe(true);
    let admittedB = 1;
    for (let i = 0; i < 20; i += 1) {
      if (limiter.check("key-b").allowed) admittedB += 1;
    }
    expect(admittedB).toBe(5);
    // Together they fill, and only then does the global limit close.
    expect(limiter.check("key-c").allowed).toBe(false);
  });

  test("sec1_s2_default_share_is_half_the_global_window", () => {
    const now = 1_700_000_000_000;
    const limiter = createRateLimiter(
      { perKeyPerMinute: 100, perKeyPerDay: 1000, globalPerMinute: 4 },
      () => now,
    );
    expect(limiter.check("key-a").allowed).toBe(true);
    expect(limiter.check("key-a").allowed).toBe(true);
    expect(limiter.check("key-a").allowed).toBe(false);
    expect(limiter.check("key-b").allowed).toBe(true);
  });

  test("sec1_s6_past_day_meters_are_pruned", () => {
    let now = Date.UTC(2030, 0, 1, 12, 0, 0);
    const limiter = createRateLimiter(
      { perKeyPerMinute: 100, perKeyPerDay: 1000, globalPerMinute: 1000 },
      () => now,
    );
    limiter.check("key-a");
    limiter.check("key-b");
    expect(limiter.dailyMeterCount()).toBe(2);
    now = Date.UTC(2030, 0, 2, 12, 0, 0);
    expect(limiter.check("key-a").allowed).toBe(true);
    expect(limiter.dailyMeterCount()).toBe(1);
    // The new day's quota is fresh for the returning key.
    expect(limiter.check("key-a").allowed).toBe(true);
  });

  test("k504_rest_error_shape_stays_machine_readable", async () => {
    const response = await fetch(`${baseUrl}/v1/analyze?address=not-an-address`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(typeof body["code"]).toBe("string");
    expect(typeof body["requestId"]).toBe("string");
  });
});
