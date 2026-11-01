// B-3 proof route (VS-B1, main spec B-3): the composed app answers
// `GET /v1/proof?address=` with the five per-detector extended-proof
// reports, code locations included. Key-gated like the other read routes,
// cached by code hash, never part of `/v1/analyze`. In-process `inject`
// only with the fake RPC adapter; no listener is opened and no outbound
// network happens here. All bytecode below is a hand-assembled synthetic
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
const TEST_API_KEY = "test-key-for-proof-suite-only";
const TEST_PEPPER = "test-pepper-for-proof-suite-only";

function baseConfig(): AppConfig {
  return Object.freeze({
    env: "ci",
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    modelArtifactPath: "model",
    cloneIndexVersion: mustOk(IndexVersion.parse("1.0.0")),
    logLevel: "error",
    apiKeys: Object.freeze([new SecretString(TEST_API_KEY)]),
    apiKeyPepper: new SecretString(TEST_PEPPER),
    rateLimitPerKeyPerMinute: 1000,
    quotaPerKeyPerDay: 10000,
    globalRatePerMinute: 10000,
  });
}

type ProofBody = {
  readonly status?: unknown;
  readonly codeHash?: unknown;
  readonly proofs?: ReadonlyArray<{
    readonly detector?: unknown;
    readonly steps?: ReadonlyArray<{
      readonly step?: unknown;
      readonly ok?: unknown;
      readonly detail?: unknown;
      readonly selector?: unknown;
      readonly pc?: unknown;
    }>;
  }>;
};

describe("proof route through the composed app (B-3)", () => {
  test("b03_composed_proof_returns_five_reports_with_step_ids", async () => {
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
      const first = await server.inject({
        method: "GET",
        url: `/v1/proof?address=${TEST_ADDRESS}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(first.statusCode).toBe(200);
      const body = JSON.parse(first.body) as ProofBody;
      expect(body.status).toBe("ok");
      expect(typeof body.codeHash).toBe("string");
      const proofs = body.proofs ?? [];
      expect(proofs.length).toBe(5);
      for (const report of proofs) {
        expect(typeof report.detector).toBe("string");
        const steps = report.steps ?? [];
        expect(steps.length).toBeGreaterThan(0);
        for (const entry of steps) {
          expect(typeof entry.step).toBe("string");
          expect(typeof entry.ok).toBe("boolean");
          expect(typeof entry.detail).toBe("string");
          if (entry.selector !== undefined) {
            expect(entry.selector).toMatch(/^0x[0-9a-fA-F]{8}$/);
          }
          if (entry.pc !== undefined) {
            expect(Number.isInteger(entry.pc)).toBe(true);
          }
        }
      }
      // A second call for the same code answers byte-identically: the
      // code-hash cache replays the reports without recomputation.
      const second = await server.inject({
        method: "GET",
        url: `/v1/proof?address=${TEST_ADDRESS}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(second.statusCode).toBe(200);
      expect(second.body).toBe(first.body);
    } finally {
      await server.close();
    }
  });

  test("b03_proof_leaves_the_analyze_envelope_byte_identical", async () => {
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
      const before = await server.inject({
        method: "GET",
        url: `/v1/analyze?address=${TEST_ADDRESS}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(before.statusCode).toBe(200);
      const proof = await server.inject({
        method: "GET",
        url: `/v1/proof?address=${TEST_ADDRESS}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(proof.statusCode).toBe(200);
      const after = await server.inject({
        method: "GET",
        url: `/v1/analyze?address=${TEST_ADDRESS}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(after.statusCode).toBe(200);
      // The proof walk is never part of the analysis: the envelope is
      // byte-identical before and after, and carries no proof reports.
      expect(after.body).toBe(before.body);
      expect(JSON.parse(after.body) as Record<string, unknown>).not.toHaveProperty("proofs");
    } finally {
      await server.close();
    }
  });
});
