// GET /v1/market-new (DX-B1): response shape, chain validation, the
// API-key gate, the typed provider states and the market health feature.
// Injected fake readers only; no network, no real addresses.
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
import type { MarketNewReader, MarketSnapshot } from "../../../../src/ports/marketFeed.ts";
import { FakeClockAdapter } from "../../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../../fakes/fakeRpc.ts";
import { createRestServer } from "../../../../src/interfaces/rest/server.ts";
import type { RestServer } from "../../../../src/interfaces/rest/server.ts";
import { syntheticAddress } from "../../../helpers/syntheticAddresses.ts";
import { Address } from "../../../../src/domain/types.ts";

const TEST_API_KEY = "test-key-for-market-new-only";
const TEST_PEPPER = "test-pepper-for-market-new-only";

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

function checksum(raw: string): string {
  return mustOk(Address.parse(raw)) as string;
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

function liveReader(): MarketNewReader {
  const snapshot: MarketSnapshot = {
    status: "live",
    updatedAt: 1700000100000,
    items: Object.freeze([
      Object.freeze({
        tokenAddress: checksum(syntheticAddress(71)),
        symbol: "SYN",
        name: "Synthetic Token",
        pairAddress: checksum(syntheticAddress(81)),
        dex: "uniswap",
        createdAt: 1700000000000,
        liquidityUsd: 2500,
        volume1hUsd: 30,
        volume24hUsd: 900,
        analysis: Object.freeze({ score: 12, powersFound: 2, powersExtended: 1 }),
      }),
      Object.freeze({
        tokenAddress: checksum(syntheticAddress(72)),
        symbol: null,
        name: null,
        pairAddress: checksum(syntheticAddress(82)),
        dex: "sushiswap",
        createdAt: 1699999900000,
        liquidityUsd: null,
        volume1hUsd: null,
        volume24hUsd: null,
      }),
    ]),
  };
  return { getMarket: async () => snapshot };
}

function startServer(options: { marketNew?: MarketNewReader | undefined }): Promise<RestServer> {
  const rest = createRestServer({
    detectors: mustDefaultDetectorSet(),
    services: testServices(),
    apiKeys: [new SecretString(TEST_API_KEY)] as readonly SecretString[],
    apiKeyPepper: new SecretString(TEST_PEPPER),
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
    marketNew: options.marketNew,
  });
  return Promise.resolve(rest);
}

describe("GET /v1/market-new", () => {
  let rest: RestServer;
  let baseUrl: string;

  beforeAll(async () => {
    rest = await startServer({ marketNew: liveReader() });
    baseUrl = await rest.listen("127.0.0.1", 0);
  });

  afterAll(async () => {
    await rest.close();
  });

  test("serves items with updatedAt in the contracted shape", async () => {
    const response = await fetch(`${baseUrl}/v1/market-new?chain=ethereum`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["items", "updatedAt"]);
    expect(body["updatedAt"]).toBe(1700000100000);
    const items = body["items"] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      tokenAddress: checksum(syntheticAddress(71)),
      symbol: "SYN",
      name: "Synthetic Token",
      pairAddress: checksum(syntheticAddress(81)),
      dex: "uniswap",
      createdAt: 1700000000000,
      liquidityUsd: 2500,
      volume1hUsd: 30,
      volume24hUsd: 900,
      analysis: { score: 12, powersFound: 2, powersExtended: 1 },
    });
    expect(items[1]).toMatchObject({
      symbol: null,
      liquidityUsd: null,
      volume1hUsd: null,
      volume24hUsd: null,
    });
    expect(items[1]).not.toHaveProperty("analysis");
  });

  test("other chains and a missing chain fail validation", async () => {
    for (const query of ["?chain=solana", "?chain=Ethereum", ""]) {
      const response = await fetch(`${baseUrl}/v1/market-new${query}`, {
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { code?: unknown };
      expect(body.code).toBe("validation-error");
    }
  });

  test("the API-key gate holds", async () => {
    const missing = await fetch(`${baseUrl}/v1/market-new?chain=ethereum`);
    expect(missing.status).toBe(401);
    const wrong = await fetch(`${baseUrl}/v1/market-new?chain=ethereum`, {
      headers: { "x-api-key": "wrong-key" },
    });
    expect(wrong.status).toBe(401);
  });

  test("the market health feature reports the bound provider", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { market?: unknown };
    expect(body.market).toEqual({ provider: "dexscreener" });
  });
});

describe("GET /v1/market-new provider states", () => {
  let rest: RestServer;
  let baseUrl: string;

  beforeAll(async () => {
    rest = await startServer({});
    baseUrl = await rest.listen("127.0.0.1", 0);
  });

  afterAll(async () => {
    await rest.close();
  });

  test("an unbound listing answers market-not-configured and reports disabled health", async () => {
    const response = await fetch(`${baseUrl}/v1/market-new?chain=ethereum`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(response.status).toBe(501);
    const body = (await response.json()) as { code?: unknown };
    expect(body.code).toBe("market-not-configured");
    const health = await fetch(`${baseUrl}/health`);
    const healthBody = (await health.json()) as { market?: unknown };
    expect(healthBody.market).toEqual({ disabled: true });
  });
});

describe("GET /v1/market-new snapshot states", () => {
  let rest: RestServer;
  let baseUrl: string;

  beforeAll(async () => {
    const reader: MarketNewReader = {
      getMarket: async (chain: string) =>
        chain === "ethereum"
          ? { status: "not-configured", updatedAt: 1700000100000, items: Object.freeze([]) }
          : { status: "unavailable", updatedAt: 1700000100000, items: Object.freeze([]) },
    };
    rest = await startServer({ marketNew: reader });
    baseUrl = await rest.listen("127.0.0.1", 0);
  });

  afterAll(async () => {
    await rest.close();
  });

  test("a not-configured snapshot answers 501", async () => {
    const response = await fetch(`${baseUrl}/v1/market-new?chain=ethereum`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(response.status).toBe(501);
    const body = (await response.json()) as { code?: unknown };
    expect(body.code).toBe("market-not-configured");
  });
});

describe("GET /v1/market-new unavailable snapshot", () => {
  let rest: RestServer;
  let baseUrl: string;

  beforeAll(async () => {
    const reader: MarketNewReader = {
      getMarket: async () => ({
        status: "unavailable",
        message: "the market listing is unavailable",
        updatedAt: 1700000100000,
        items: Object.freeze([]),
      }),
    };
    rest = await startServer({ marketNew: reader });
    baseUrl = await rest.listen("127.0.0.1", 0);
  });

  afterAll(async () => {
    await rest.close();
  });

  test("an unavailable snapshot answers 502 without internals", async () => {
    const response = await fetch(`${baseUrl}/v1/market-new?chain=ethereum`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(response.status).toBe(502);
    const body = (await response.json()) as { code?: unknown; message?: unknown };
    expect(body.code).toBe("upstream-unavailable");
    expect(body.message).toBe("Market listing is unavailable; retry with the same request ID.");
  });
});
