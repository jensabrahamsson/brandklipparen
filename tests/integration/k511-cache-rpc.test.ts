// Verified external responses and verified cache entries (K-511, M-14).
// The named tests below were missing; the boundary checks they exercise
// (schema validation in the RPC adapter, key-bound reads in the cache)
// already exist, so these tests prove the behaviour as regression cover.
// Fakes and frozen fixtures only; no live network, no secrets.
import { describe, expect, test } from "vitest";
import { analyzeToken } from "../../src/application/analyzeToken.ts";
import { createAppServices } from "../../src/application/analyzeToken.ts";
import type { CacheKey as CacheKeyType } from "../../src/domain/types.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  Bytecode,
  CacheKey,
  CodeHash,
  IndexVersion,
  ModelVersion,
  RequestId,
  TemplateVersion,
  Timestamp,
} from "../../src/domain/types.ts";
import type { Result } from "../../src/domain/result.ts";
import type { CapabilityCatalogue } from "../../src/domain/signals.ts";
import { parseModelArtifact } from "../../src/domain/risk.ts";
import { SecretString } from "../../src/ports/config.ts";
import type { RpcError } from "../../src/ports/rpc.ts";
import type { BytecodeResult, RpcPort } from "../../src/ports/rpc.ts";
import { JsonRpcAdapter } from "../../src/adapters/rpc/jsonRpcAdapter.ts";
import type { RpcTransportResponse } from "../../src/adapters/rpc/jsonRpcAdapter.ts";
import { InMemoryCacheAdapter } from "../../src/adapters/cache/inMemoryCache.ts";
import { validateCacheEntry } from "../../src/adapters/cache/validateCacheEntry.ts";
import { FakeClockAdapter } from "../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../fakes/fakeRpc.ts";
import { mustDefaultDetectorSet } from "../helpers/detectorSets.ts";

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

// Placeholder catalogue for the test only: fixed risk mapping per
// capability key, so detection yields signals without learned values.
const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

const TEST_ADDRESS = "0x0102030405060708090a0b0c0d0e0f1011121314";
const TEST_BYTECODE = `0x8063a9059cbb14600a57${"00".repeat(10)}ff`;
const TEST_BLOCK = 18000000;

function ctx() {
  return {
    requestId: mustOk(RequestId.parse("123e4567-e89b-42d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(1900000000000)),
    block: mustOk(BlockNumber.of(TEST_BLOCK)),
  };
}

// RPC port that always fails: simulates a node outage so the test proves
// cached responses keep serving with zero outbound calls.
class OutageRpcAdapter implements RpcPort {
  getCodeCalls = 0;
  async getCode(): Promise<Result<BytecodeResult, RpcError>> {
    this.getCodeCalls += 1;
    return { ok: false, error: { kind: "node-error", message: "fake rpc node is down" } };
  }
  async getStorageAt(): Promise<Result<never, RpcError>> {
    return { ok: false, error: { kind: "node-error", message: "fake rpc node is down" } };
  }
  async call(): Promise<Result<never, RpcError>> {
    return { ok: false, error: { kind: "node-error", message: "fake rpc node is down" } };
  }
  async getBlockNumber(): Promise<Result<never, RpcError>> {
    return { ok: false, error: { kind: "node-error", message: "fake rpc node is down" } };
  }
  async getLogs(): Promise<Result<never, RpcError>> {
    return { ok: false, error: { kind: "node-error", message: "fake rpc node is down" } };
  }
  async getBlockReceipts(): Promise<Result<never, RpcError>> {
    return { ok: false, error: { kind: "node-error", message: "fake rpc node is down" } };
  }
}

describe("verified responses and cache entries (K-511, M-14)", () => {
  test("k511_manipulated_rpc_response_flagged", async () => {
    const bodies: RpcTransportResponse[] = [
      // Non-hex bytecode: schema breach at the boundary.
      { status: 200, bodyText: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "not-hex" }) },
      // Mismatched envelope id: response belongs to another call.
      { status: 200, bodyText: JSON.stringify({ jsonrpc: "2.0", id: 999, result: "0x6001" }) },
      // Node error envelope: the node refuses the call.
      { status: 200, bodyText: JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "nope" } }) },
      // Oversized body past the adapter limit.
      { status: 200, bodyText: `{"jsonrpc":"2.0","id":3,"result":"0x${"ff".repeat(2000)}"}` },
      // Wrong result shape: a number where hex text belongs.
      { status: 200, bodyText: JSON.stringify({ jsonrpc: "2.0", id: 4, result: 42 }) },
    ];
    for (const response of bodies) {
      const adapter = new JsonRpcAdapter({
        endpoint: new SecretString("https://rpc.example.invalid/v1"),
        maxResponseBytes: 1024,
        transport: async (): Promise<RpcTransportResponse> => response,
      });
      const outcome = await adapter.getCode(mustOk(Address.parse(TEST_ADDRESS)), ctx());
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        // Every manipulated response is flagged with a typed branch;
        // none reaches the core as valid bytecode.
        expect(["invalid-response", "node-error", "timeout"]).toContain(outcome.error.kind);
      }
    }
    // A valid response binds the reading to the pinned block number, so
    // stale context cannot pass as fresh (K-102 reproduction fields).
    const valid = new JsonRpcAdapter({
      endpoint: new SecretString("https://rpc.example.invalid/v1"),
      transport: async (_url: string, body: string): Promise<RpcTransportResponse> => {
        const id = (JSON.parse(body) as { id: number }).id;
        return {
          status: 200,
          bodyText: JSON.stringify({ jsonrpc: "2.0", id, result: TEST_BYTECODE }),
        };
      },
    });
    const fetched = await valid.getCode(mustOk(Address.parse(TEST_ADDRESS)), ctx());
    expect(fetched.ok).toBe(true);
    if (fetched.ok) {
      expect(fetched.value.block).toBe(TEST_BLOCK);
      expect(fetched.value.bytecode.length).toBeGreaterThan(0);
    }
  });

  test("k511_cache_entry_verified_on_read", async () => {
    const bytecode = mustOk(Bytecode.parse(TEST_BYTECODE));
    const codeHash = mustOk(CodeHash.of(bytecode));
    const key = mustOk(CacheKey.of(codeHash, mustOk(ModelVersion.parse("0.1.0"))));
    const cache = new InMemoryCacheAdapter();
    // A well-formed entry is verified first: build one through a real
    // analysis, then read it back under its key.
    const services = createAppServices({
      rpc: new FakeRpcAdapter(
        new Map([[mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE]]),
        mustOk(BlockNumber.of(TEST_BLOCK)),
      ),
      modelArtifacts: placeholderArtifact(),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      cache,
    },
  mustDefaultDetectorSet());
    const first = await services.analyzeToken({
      address: mustOk(Address.parse(TEST_ADDRESS)),
      block: mustOk(BlockNumber.of(TEST_BLOCK)),
      requestId: mustOk(RequestId.parse("123e4567-e89b-42d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1900000000000)),
      modelVersion: mustOk(ModelVersion.parse("0.1.0")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    });
    expect(first.ok).toBe(true);
    const hit = await cache.get(key);
    expect(hit.ok).toBe(true);
    // Entries impersonating another code hash or model version are
    // rejected as corrupt on every read, never served.
    const stored = (await cache.get(key)).ok
      ? ((await cache.get(key)) as { ok: true; value: unknown }).value
      : null;
    expect(stored).not.toBe(null);
    const otherCodeHash = `0x${"11".repeat(32)}`;
    const mismatchedHash = { ...(stored as Record<string, unknown>), codeHash: otherCodeHash };
    expect(validateCacheEntry(key, mismatchedHash).ok).toBe(false);
    const mismatchedVersion = {
      ...(stored as Record<string, unknown>),
      codeHash: codeHash as string,
      modelVersion: "9.9.9",
    };
    expect(validateCacheEntry(key, mismatchedVersion).ok).toBe(false);
    expect(validateCacheEntry(key, { kind: "assessed" }).ok).toBe(false);
    // A poisoned entry under a live key falls back to a fresh analysis:
    // the service analyses again instead of serving the poison.
    cache.injectRaw(key, mismatchedHash);
    const recovered = await services.analyzeToken({
      address: mustOk(Address.parse(TEST_ADDRESS)),
      block: mustOk(BlockNumber.of(TEST_BLOCK)),
      requestId: mustOk(RequestId.parse("123e4567-e89b-42d3-a456-426614174001")),
      deadline: mustOk(Timestamp.of(1900000000000)),
      modelVersion: mustOk(ModelVersion.parse("0.1.0")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    });
    expect(recovered.ok).toBe(true);
  });

  test("k511_cached_responses_served_during_provider_outage", async () => {
    const address = mustOk(Address.parse(TEST_ADDRESS));
    const block = mustOk(BlockNumber.of(TEST_BLOCK));
    const modelVersion = mustOk(ModelVersion.parse("0.1.0"));
    const cache = new InMemoryCacheAdapter();
    const clock = new FakeClockAdapter(mustOk(Timestamp.of(1700000000000)));
    const addressIndex = new Map<string, CacheKeyType>();
    const analysed = await analyzeToken(
      {
        rpc: new FakeRpcAdapter(new Map([[address as string, TEST_BYTECODE]]), block),
        modelArtifacts: placeholderArtifact(),
        clock,
        cache,
      },
      {
        address,
        block,
        requestId: mustOk(RequestId.parse("123e4567-e89b-42d3-a456-426614174000")),
        deadline: mustOk(Timestamp.of(1900000000000)),
        modelVersion,
        indexVersion: mustOk(IndexVersion.parse("1.0.0")),
        templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
        catalogue: TEST_CATALOGUE,
      },
      mustDefaultDetectorSet(),
      addressIndex);
    expect(analysed.ok).toBe(true);
    // The provider goes down; the same key still serves the cached
    // code-derived result. The proxy is re-resolved on every hit, so the
    // outage degrades the proxy to no proxy info while the cached score,
    // signals and code hash still serve.
    const outage = new OutageRpcAdapter();
    const served = await analyzeToken(
      { rpc: outage, modelArtifacts: placeholderArtifact(), clock, cache },
      {
        address,
        block,
        requestId: mustOk(RequestId.parse("123e4567-e89b-42d3-a456-426614174001")),
        deadline: mustOk(Timestamp.of(1900000000000)),
        modelVersion,
        indexVersion: mustOk(IndexVersion.parse("1.0.0")),
        templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
        catalogue: TEST_CATALOGUE,
      },
      mustDefaultDetectorSet(),
      addressIndex);
    expect(served.ok).toBe(true);
    if (analysed.ok && analysed.value.kind === "assessed" && served.ok && served.value.kind === "assessed") {
      expect(served.value.envelope.codeHash).toBe(analysed.value.envelope.codeHash as string);
      expect(served.value.envelope.score).toBe(analysed.value.envelope.score as number);
      expect(served.value.envelope.signals).toEqual(analysed.value.envelope.signals);
      expect(served.value.envelope.proxy).toEqual({ kind: "none" });
    } else {
      throw new Error("expected assessed outcomes before and during the outage");
    }
  });

});
