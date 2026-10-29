// GET /v1/live-tokens (E-11 follow-up): snapshot shape, newest first,
// ?since= filtering, the API-key gate and the not-configured body.
// Written first (red) per A-21. The reader is an injected fake; the
// service constructor is never started here.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  ArtifactChecksum,
  BlockNumber,
  IndexVersion,
  ModelVersion,
  TemplateVersion,
  Timestamp,
} from "../../../../src/domain/types.ts";
import type { Result } from "../../../../src/domain/result.ts";
import { parseModelArtifact } from "../../../../src/domain/risk.ts";
import type { CapabilityCatalogue } from "../../../../src/domain/signals.ts";
import { createAppServices } from "../../../../src/application/analyzeToken.ts";
import type { AppServices } from "../../../../src/application/analyzeToken.ts";
import { mustDefaultDetectorSet } from "../../../helpers/detectorSets.ts";
import { SecretString } from "../../../../src/ports/config.ts";
import type { LiveTokensReader, LiveTokensSnapshot } from "../../../../src/ports/liveTokens.ts";
import { FakeClockAdapter } from "../../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../../fakes/fakeRpc.ts";
import { createRestServer } from "../../../../src/interfaces/rest/server.ts";
import type { RestServer } from "../../../../src/interfaces/rest/server.ts";
import { syntheticAddress, syntheticTxHash } from "../../../helpers/syntheticAddresses.ts";

const TEST_API_KEY = "test-key-for-live-tokens-only";
const TEST_PEPPER = "test-pepper-for-live-tokens-only";

const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function testServices(): AppServices {
  return createAppServices(
    {
      rpc: new FakeRpcAdapter(new Map(), mustOk(BlockNumber.of(18000000))),
      modelArtifacts: new FakeModelArtifactAdapter({
        artifact: mustOk(
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
        ),
        checksum: mustOk(ArtifactChecksum.parse("cd".repeat(32))),
      }),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
    mustDefaultDetectorSet(),
  );
}

const PAIR_NEW = syntheticAddress(10);
const PAIR_OLD = syntheticAddress(11);
const TOKEN_NEW = syntheticAddress(2);
const TOKEN_OLD = syntheticAddress(3);
const TX = syntheticTxHash(1);

function fakeReader(): LiveTokensReader {
  const snapshot: LiveTokensSnapshot = {
    source: "etherscan",
    status: "live",
    updatedAt: 1700000000000,
    items: Object.freeze([
      {
        chainId: 1,
        tokenAddress: TOKEN_NEW,
        symbol: "NEW",
        name: "New Token",
        pairAddress: PAIR_NEW,
        dex: "Uniswap V2",
        block: 21600002,
        txHash: TX,
        logIndex: 0,
        createdAt: 1700000000000,
        blockTimestampMs: 1700000000000,
        initialLiquidityWeth: "1.5",
        state: "done",
        score: 12,
        riskBand: "Low",
        ageSeconds: 0,
      },
      {
        chainId: 1,
        tokenAddress: TOKEN_OLD,
        symbol: null,
        name: null,
        pairAddress: PAIR_OLD,
        dex: "Uniswap V3",
        feeTier: 3000,
        block: 21600001,
        txHash: TX,
        logIndex: 1,
        createdAt: 1699999990000,
        blockTimestampMs: 1699999990000,
        initialLiquidityWeth: null,
        state: "analyzing",
        ageSeconds: 10,
      },
      {
        chainId: 1,
        tokenAddress: syntheticAddress(4),
        symbol: null,
        name: null,
        pairAddress: syntheticAddress(12),
        dex: "Uniswap V2",
        block: 21600000,
        txHash: TX,
        logIndex: 2,
        createdAt: 1700000000000,
        blockTimestampMs: null,
        initialLiquidityWeth: null,
        state: "queued",
        ageSeconds: null,
      },
    ]),
  };
  return {
    snapshot: (sinceMs?: number | undefined) =>
      sinceMs === undefined
        ? snapshot
        : { ...snapshot, items: snapshot.items.filter((entry) => entry.createdAt > sinceMs) },
  };
}

describe("GET /v1/live-tokens", () => {
  let rest: RestServer;
  let baseUrl: string;

  beforeAll(async () => {
    rest = createRestServer({
      detectors: mustDefaultDetectorSet(),
      services: testServices(),
      apiKeys: [new SecretString(TEST_API_KEY)] as readonly SecretString[],
      apiKeyPepper: new SecretString(TEST_PEPPER),
      modelVersion: mustOk(ModelVersion.parse("0.1.0")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
      liveTokens: fakeReader(),
    });
    baseUrl = await rest.listen("127.0.0.1", 0);
  });

  afterAll(async () => {
    await rest.close();
  });

  test("serves the snapshot newest first with ages and liquidity", async () => {
    const response = await fetch(`${baseUrl}/v1/live-tokens`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["source"]).toBe("etherscan");
    expect(body["status"]).toBe("live");
    expect(body["updatedAt"]).toBe(1700000000000);
    const items = body["items"] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    expect(items[0]?.["pairAddress"]).toBe(PAIR_NEW);
    expect(items[0]).toMatchObject({
      symbol: "NEW",
      dex: "Uniswap V2",
      block: 21600002,
      initialLiquidityWeth: "1.5",
      state: "done",
      riskBand: "Low",
      score: 12,
      ageSeconds: 0,
    });
    expect(items[1]).toMatchObject({ dex: "Uniswap V3", feeTier: 3000, state: "analyzing" });
    expect(items[2]).toMatchObject({ block: 21600000, state: "queued", ageSeconds: null });
    expect(items[2]?.["blockTimestampMs"]).toBeNull();
  });

  test("since trims to newer items and bad since fails validation", async () => {
    const trimmed = await fetch(`${baseUrl}/v1/live-tokens?since=1699999995000`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(trimmed.status).toBe(200);
    const body = (await trimmed.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(2);
    const bad = await fetch(`${baseUrl}/v1/live-tokens?since=soon`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(bad.status).toBe(400);
  });

  test("the API-key gate holds", async () => {
    const missing = await fetch(`${baseUrl}/v1/live-tokens`);
    expect(missing.status).toBe(401);
    const wrong = await fetch(`${baseUrl}/v1/live-tokens`, {
      headers: { "x-api-key": "wrong-key" },
    });
    expect(wrong.status).toBe(401);
  });
});
