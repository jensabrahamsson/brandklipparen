// B-2 snippet RPC wiring (S-095, K-008, K-010): the composed app answers
// `/v1/snippet` through the bound RPC port. A known dispatcher selector
// returns quoted numbered lines from the local pipeline; an unknown
// selector fails as a 400 validation error. In-process `inject` only with
// the fake RPC adapter; no listener is opened and no outbound network
// happens here. All bytecode below is a hand-assembled synthetic
// dispatcher shape for tests only.
import { describe, expect, test } from "vitest";
import type { Result } from "../../../src/domain/result.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  IndexVersion,
  ModelVersion,
  Timestamp,
} from "../../../src/domain/types.ts";
import { parseModelArtifact } from "../../../src/domain/risk.ts";
import { SecretString } from "../../../src/ports/config.ts";
import type { AppConfig } from "../../../src/ports/config.ts";
import { buildApp } from "../../../src/composition/app.ts";
import { createRestServer } from "../../../src/interfaces/rest/server.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
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

// Hand-assembled synthetic dispatcher with two entries: transfer
// (0xa9059cbb) and balanceOf (0x70a08231).
const TEST_ADDRESS = "0x0102030405060708090a0b0c0d0e0f1011121314";
const TEST_BYTECODE =
  "0x608060405234801561001057600080fd5b508063a9059cbb1461002d57806370a0823114610047575b600080fd5b600035331461003b57600080fd5b60015460023501600155005b6000355460005260206000f3";
const TEST_BLOCK = 18000000;
const TEST_API_KEY = "test-key-for-snippet-wiring-suite-only";
const TEST_PEPPER = "test-pepper-for-snippet-wiring-suite-only";

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

type SnippetBody = {
  readonly status?: unknown;
  readonly code?: unknown;
  readonly snippet?: {
    readonly selector?: unknown;
    readonly entryPc?: unknown;
    readonly lines?: ReadonlyArray<{ readonly selector?: unknown; readonly lineNumber?: unknown; readonly text?: unknown }>;
  };
};

describe("snippet wiring through the composed app (B-2)", () => {
  test("b02_composed_snippet_returns_numbered_lines_and_rejects_unknown", async () => {
    const codes = new Map<string, string>([[mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE]]);
    const rpcFake = new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK)));
    const built = buildApp(baseConfig(), {
      ports: Object.freeze({
        rpc: rpcFake,
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
      const known = await server.inject({
        method: "GET",
        url: `/v1/snippet?address=${TEST_ADDRESS}&selector=0xa9059cbb`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(known.statusCode).toBe(200);
      const knownBody = JSON.parse(known.body) as SnippetBody;
      expect(knownBody.status).toBe("ok");
      expect(knownBody.snippet?.selector).toBe("0xa9059cbb");
      expect(typeof knownBody.snippet?.entryPc).toBe("number");
      const lines = knownBody.snippet?.lines ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const [index, line] of lines.entries()) {
        expect(line.selector).toBe("0xa9059cbb");
        expect(line.lineNumber).toBe(index + 1);
        expect(typeof line.text).toBe("string");
        expect((line.text as string).length).toBeGreaterThan(0);
      }
      expect(lines[0]?.text).toContain("function transfer(");
      expect(lines[lines.length - 1]?.text).toBe("}");

      const unknown = await server.inject({
        method: "GET",
        url: `/v1/snippet?address=${TEST_ADDRESS}&selector=0x12345678`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(unknown.statusCode).toBe(400);
      expect((JSON.parse(unknown.body) as SnippetBody).code).toBe("validation-error");
    } finally {
      await server.close();
    }
  });
});
