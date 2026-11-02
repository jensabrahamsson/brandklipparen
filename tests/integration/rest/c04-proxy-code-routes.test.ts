// C-4 (F-6) proxy-aware code routes: snippet, proof and explain-code read
// the implementation behind an EIP-1967 proxy, matching the scored
// analysis. In-process `inject` only with the fake RPC adapter carrying a
// synthetic proxy stub plus a synthetic implementation dispatcher; no
// listener is opened and no outbound network happens here.
import { describe, expect, test } from "vitest";
import type { Result } from "../../../src/domain/result.ts";
import {
  Address,
  BlockNumber,
  IndexVersion,
  ModelVersion,
  Timestamp,
} from "../../../src/domain/types.ts";
import { IMPLEMENTATION_SLOT, ADMIN_SLOT } from "../../../src/domain/proxy.ts";
import { SecretString } from "../../../src/ports/config.ts";
import type { AppConfig } from "../../../src/ports/config.ts";
import { buildApp } from "../../../src/composition/app.ts";
import { createRestServer } from "../../../src/interfaces/rest/server.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { parseModelArtifact } from "../../../src/domain/risk.ts";
import { ArtifactChecksum } from "../../../src/domain/types.ts";
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

// Synthetic addresses only for tests.
const PROXY = "0x0102030405060708090a0b0c0d0e0f1011121314";
const IMPL = "0x1112131415161718191a1b1c1d1e1f2021222324";
const ADMIN = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
// Proxy stub with no dispatcher entries; the implementation carries the
// transfer (0xa9059cbb) entry, so only the resolved code answers it.
// BK-02: paired dispatcher plus DELEGATECALL proves forwarding.
const PROXY_BYTECODE = "0x8063a9059cbb14600a575b6001600a600b600c600d600e600f55f4";
const IMPL_BYTECODE =
  "0x608060405234801561001057600080fd5b508063a9059cbb1461002d57806370a0823114610047575b600080fd5b600035331461003b57600080fd5b60015460023501600155005b6000355460005260206000f3";
const TEST_BLOCK = 18000000;
const TEST_API_KEY = "test-key-for-proxy-code-routes-only";
const TEST_PEPPER = "test-pepper-for-proxy-code-routes-only";

function addressWord(raw: string): string {
  return `0x${"0".repeat(24)}${raw.slice(2).toLowerCase()}`;
}

function baseConfig(): AppConfig {
  return Object.freeze({
    env: "ci",
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    modelArtifactPath: "model",
    cloneIndexVersion: mustOk(IndexVersion.parse("1.0.0")),
    extdecompDeadlineMs: 5000,
    extdecompMaxOutputBytes: 65536,
    extdecompMaxMemoryMb: 512,
    logLevel: "error",
    apiKeys: Object.freeze([new SecretString(TEST_API_KEY)]),
    apiKeyPepper: new SecretString(TEST_PEPPER),
    rateLimitPerKeyPerMinute: 1000,
    quotaPerKeyPerDay: 10000,
    globalRatePerMinute: 10000,
  });
}

function proxyRpc(): FakeRpcAdapter {
  const proxy = mustOk(Address.parse(PROXY));
  const codes = new Map<string, string>([
    [proxy as string, PROXY_BYTECODE],
    [mustOk(Address.parse(IMPL)) as string, IMPL_BYTECODE],
  ]);
  const storage = new Map<string, Map<string, string>>([
    [
      proxy as string,
      new Map<string, string>([
        [(IMPLEMENTATION_SLOT as string).toLowerCase(), addressWord(IMPL).toLowerCase()],
        [(ADMIN_SLOT as string).toLowerCase(), addressWord(ADMIN).toLowerCase()],
      ]),
    ],
  ]);
  return new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK)), storage);
}

describe("proxy-aware code routes (C-4, F-6)", () => {
  test("snippet_serves_an_implementation_only_selector_through_the_proxy", async () => {
    const built = buildApp(baseConfig(), {
      ports: Object.freeze({
        rpc: proxyRpc(),
        modelArtifacts: placeholderArtifact(),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      }),
      detectors: mustDefaultDetectorSet(),
    });
    if (!built.ok) {
      throw new Error(`expected the composed app to build, got ${built.error.kind}`);
    }
    const server = createRestServer(built.value.rest);
    try {
      const response = await server.inject({
        method: "GET",
        url: `/v1/snippet?address=${PROXY}&selector=0xa9059cbb`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        readonly codeHash?: unknown;
        readonly snippet?: { readonly selector?: unknown };
      };
      expect(body.snippet?.selector).toBe("0xa9059cbb");
      expect(typeof body.codeHash).toBe("string");
    } finally {
      await server.close();
    }
  });

  test("proof_codeHash_matches_the_analyze_envelope_behind_the_proxy", async () => {
    const built = buildApp(baseConfig(), {
      ports: Object.freeze({
        rpc: proxyRpc(),
        modelArtifacts: placeholderArtifact(),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      }),
      detectors: mustDefaultDetectorSet(),
    });
    if (!built.ok) {
      throw new Error(`expected the composed app to build, got ${built.error.kind}`);
    }
    const server = createRestServer(built.value.rest);
    try {
      const analysed = await server.inject({
        method: "GET",
        url: `/v1/analyze?address=${PROXY}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(analysed.statusCode).toBe(200);
      const envelope = JSON.parse(analysed.body) as { readonly codeHash?: unknown };
      expect(typeof envelope.codeHash).toBe("string");
      const proved = await server.inject({
        method: "GET",
        url: `/v1/proof?address=${PROXY}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(proved.statusCode).toBe(200);
      const proof = JSON.parse(proved.body) as { readonly codeHash?: unknown };
      expect(proof.codeHash).toBe(envelope.codeHash);
    } finally {
      await server.close();
    }
  });
});
