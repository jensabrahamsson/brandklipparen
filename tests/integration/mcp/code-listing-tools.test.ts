// MCP code and listing parity tools (S-095, VS-B1, VS-B2, E-11, DX-B1):
// get_decompiled_function, get_proof_trace, get_verified_source and
// list_new_tokens run through the same application services, guards and
// caches as /v1/snippet, /v1/proof, /v1/source, /v1/live-tokens and
// /v1/market-new. Display data only: outputs never change score or
// evidence and the listing never starts an analysis. In-process servers
// only with fake adapters; no listener is opened and no outbound network
// happens here. All bytecode, sources and addresses below are
// hand-assembled synthetic fixtures.
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
import type { VerifiedSourceService } from "../../../src/application/verifiedSource.ts";
import type { LiveTokensReader, LiveTokensSnapshot } from "../../../src/ports/liveTokens.ts";
import type { MarketNewReader, MarketSnapshot } from "../../../src/ports/marketFeed.ts";
import { SecretString } from "../../../src/ports/config.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { createProofService } from "../../../src/application/proofService.ts";
import { createMcpServer } from "../../../src/interfaces/mcp/server.ts";
import type { McpServer } from "../../../src/interfaces/mcp/server.ts";
import { createRestServer } from "../../../src/interfaces/rest/server.ts";
import type { RestServer } from "../../../src/interfaces/rest/server.ts";
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";
import { syntheticAddress } from "../../helpers/syntheticAddresses.ts";

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

// Hand-assembled dispatcher fixture with two entries: transfer
// (0xa9059cbb) and balanceOf (0x70a08231).
const TEST_ADDRESS = "0x0102030405060708090a0b0c0d0e0f1011121314";
const TEST_BYTECODE =
  "0x608060405234801561001057600080fd5b508063a9059cbb1461002d57806370a0823114610047575b600080fd5b600035331461003b57600080fd5b60015460023501600155005b6000355460005260206000f3";
const TEST_SELECTOR = "0xa9059cbb";
const TEST_BLOCK = 18000000;
const TEST_API_KEY = "test-key-for-mcp-code-listing-suite-only";
const TEST_PEPPER = "test-pepper-for-mcp-code-listing-suite-only";
const UNKNOWN_ADDRESS = "0x1212121212121212121212121212121212121212";

const FIXTURE_FILE = "contracts/FixtureToken.sol";
const FIXTURE_CONTENT = [
  "// synthetic fixture source",
  "function transfer(address to, uint256 amount) {",
  "balances[to] += amount;",
  "}",
  "",
].join("\n");

function stubSourceService(): VerifiedSourceService {
  return {
    getSource: async () => ({
      ok: true as const,
      value: {
        codeHash: "code-hash-for-unit-suite",
        source: {
          status: "verified" as const,
          provider: "sourcify" as const,
          match: "full" as const,
          compiler: "0.8.20+commit.a1b79de6",
          files: [{ path: FIXTURE_FILE, content: FIXTURE_CONTENT }],
          functions: [
            {
              selector: TEST_SELECTOR,
              file: FIXTURE_FILE,
              startLine: 2,
              endLine: 4,
              name: "transfer",
              signature: "transfer(address,uint256)",
            },
          ],
        },
      },
    }),
  };
}

function sharedOptions() {
  return {
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
  };
}

function keyedOptions() {
  return {
    apiKeys: [new SecretString(TEST_API_KEY)] as readonly SecretString[],
    apiKeyPepper: new SecretString(TEST_PEPPER),
  };
}

function buildServices(): { services: AppServices; rpc: FakeRpcAdapter } {
  const codes = new Map<string, string>([[mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE]]);
  const rpc = new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK)));
  const services = createAppServices(
    {
      rpc,
      modelArtifacts: placeholderArtifact(),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
    mustDefaultDetectorSet(),
  );
  return { services, rpc };
}

function checksum(raw: string): string {
  return mustOk(Address.parse(raw)) as string;
}

function stubLiveTokens(): LiveTokensReader {
  const snapshot: LiveTokensSnapshot = {
    source: "etherscan",
    status: "live",
    updatedAt: 1700000000000,
    items: Object.freeze([
      Object.freeze({
        chainId: 1,
        tokenAddress: checksum(syntheticAddress(21)),
        symbol: "NEWSYN",
        name: "New Synthetic",
        pairAddress: checksum(syntheticAddress(31)),
        dex: "Uniswap V2",
        block: 21600002,
        txHash: `0x${"1".repeat(64)}`,
        logIndex: 0,
        createdAt: 1700000000000,
        blockTimestampMs: 1700000000000,
        initialLiquidityWeth: "1.5",
        state: "done",
        score: 12,
        riskBand: "Low",
        ageSeconds: 0,
      }),
      Object.freeze({
        chainId: 1,
        tokenAddress: checksum(syntheticAddress(22)),
        symbol: null,
        name: null,
        pairAddress: checksum(syntheticAddress(32)),
        dex: "Uniswap V3",
        feeTier: 3000,
        block: 21600001,
        txHash: `0x${"2".repeat(64)}`,
        logIndex: 1,
        createdAt: 1699999990000,
        blockTimestampMs: 1699999990000,
        initialLiquidityWeth: null,
        state: "queued",
        ageSeconds: 10,
      }),
    ]),
  };
  return {
    snapshot: (sinceMs?: number | undefined) =>
      sinceMs === undefined
        ? snapshot
        : { ...snapshot, items: snapshot.items.filter((entry) => entry.createdAt > sinceMs) },
  };
}

function stubMarket(): MarketNewReader {
  const snapshot: MarketSnapshot = {
    status: "live",
    updatedAt: 1700000100000,
    items: Object.freeze([
      Object.freeze({
        tokenAddress: checksum(syntheticAddress(41)),
        symbol: "SYN",
        name: "Synthetic Token",
        pairAddress: checksum(syntheticAddress(51)),
        dex: "uniswap",
        createdAt: 1700000000000,
        liquidityUsd: 2500,
        volume1hUsd: 30,
        volume24hUsd: 900,
        priceChange24hPct: 3.5,
      }),
    ]),
  };
  return { getMarket: async () => snapshot };
}

type SnippetBody = {
  readonly codeHash?: unknown;
  readonly snippet?: { readonly selector?: unknown; readonly lines?: ReadonlyArray<{ readonly text?: unknown }> };
};

type ProofBody = {
  readonly proofs?: ReadonlyArray<{ readonly detector?: unknown; readonly steps?: unknown }>;
};

type SourceBody = {
  readonly codeHash?: unknown;
  readonly source?: {
    readonly status?: unknown;
    readonly match?: unknown;
    readonly compiler?: unknown;
    readonly functions?: ReadonlyArray<{ readonly selector?: unknown }>;
    readonly files?: unknown;
    readonly file?: { readonly path?: unknown; readonly content?: unknown };
  };
};

type ListingBody = {
  readonly chain?: unknown;
  readonly live?: { readonly items?: unknown[]; readonly status?: unknown } | null;
  readonly market?: { readonly items?: unknown[]; readonly status?: unknown } | null;
};

describe("MCP code and listing tools over the shared services", () => {
  test("get_decompiled_function_matches_rest_byte_for_byte", async () => {
    const { services, rpc } = buildServices();
    const rest: RestServer = createRestServer({
      detectors: mustDefaultDetectorSet(),
      services,
      ...keyedOptions(),
      ...sharedOptions(),
      snippetRpc: rpc,
    });
    const mcp: McpServer = createMcpServer({
      detectors: mustDefaultDetectorSet(),
      services,
      ...keyedOptions(),
      ...sharedOptions(),
      snippetRpc: rpc,
    });
    const payload = { address: TEST_ADDRESS, selector: TEST_SELECTOR };
    const restResponse = await rest.inject({
      method: "GET",
      url: `/v1/snippet?address=${TEST_ADDRESS}&selector=${TEST_SELECTOR}`,
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(restResponse.statusCode).toBe(200);
    const toolResult = await mcp.callTool("get_decompiled_function", payload, { apiKey: TEST_API_KEY });
    expect(toolResult.ok).toBe(true);
    if (!toolResult.ok) {
      throw new Error(`expected tool success, got ${JSON.stringify(toolResult.error)}`);
    }
    expect(toolResult.value.content[0]?.text).toBe(restResponse.body);
    const body = JSON.parse(toolResult.value.content[0]?.text ?? "{}") as SnippetBody;
    expect(body.snippet?.selector).toBe(TEST_SELECTOR);
    expect((body.snippet?.lines ?? []).length).toBeGreaterThan(1);
    await rest.close();
  });

  test("get_decompiled_function_rejects_unknown_selector_before_any_pipeline_call", async () => {
    const { services, rpc } = buildServices();
    let decompileCalls = 0;
    const mcp: McpServer = createMcpServer({
      detectors: mustDefaultDetectorSet(),
      services,
      ...sharedOptions(),
      snippetRpc: rpc,
      snippetDecompile: (bytecode) => {
        decompileCalls += 1;
        void bytecode;
        throw new Error("pipeline must not run for unknown selectors");
      },
    });
    const result = await mcp.callTool("get_decompiled_function", {
      address: TEST_ADDRESS,
      selector: "0xdeadbeef",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected unknown-selector error");
    }
    expect(result.error.code).toBe("validation-error");
    expect(result.error.message).toContain("Unknown selector");
    expect(decompileCalls).toBe(0);
  });

  test("get_decompiled_function_needs_chain_access_and_a_key", async () => {
    const { services } = buildServices();
    const open: McpServer = createMcpServer({ detectors: mustDefaultDetectorSet(), services, ...sharedOptions() });
    const missing = await open.callTool("get_decompiled_function", {
      address: TEST_ADDRESS,
      selector: TEST_SELECTOR,
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) {
      throw new Error("expected not-available error");
    }
    expect(missing.error.code).toBe("snippet-not-available");

    const { rpc } = buildServices();
    const keyed: McpServer = createMcpServer({
      detectors: mustDefaultDetectorSet(),
      services,
      ...keyedOptions(),
      ...sharedOptions(),
      snippetRpc: rpc,
    });
    const denied = await keyed.callTool("get_decompiled_function", {
      address: TEST_ADDRESS,
      selector: TEST_SELECTOR,
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) {
      throw new Error("expected missing-key error");
    }
    expect(denied.error.code).toBe("missing-api-key");

    const withProof = createMcpServer({
      detectors: mustDefaultDetectorSet(),
      services,
      ...keyedOptions(),
      ...sharedOptions(),
      snippetRpc: rpc,
      proofService: createProofService(),
    });
    const noContract = await withProof.callTool(
      "get_proof_trace",
      { address: UNKNOWN_ADDRESS },
      { apiKey: TEST_API_KEY },
    );
    expect(noContract.ok).toBe(false);
    if (noContract.ok) {
      throw new Error("expected not-found error");
    }
    expect(noContract.error.code).toBe("not-found");
  });

  test("get_proof_trace_matches_rest_and_reports_per_detector_steps", async () => {
    const { services, rpc } = buildServices();
    const proofService = createProofService();
    const rest: RestServer = createRestServer({
      detectors: mustDefaultDetectorSet(),
      services,
      ...keyedOptions(),
      ...sharedOptions(),
      snippetRpc: rpc,
      proofService,
    });
    const mcp: McpServer = createMcpServer({
      detectors: mustDefaultDetectorSet(),
      services,
      ...keyedOptions(),
      ...sharedOptions(),
      snippetRpc: rpc,
      proofService,
    });
    const restResponse = await rest.inject({
      method: "GET",
      url: `/v1/proof?address=${TEST_ADDRESS}`,
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(restResponse.statusCode).toBe(200);
    const toolResult = await mcp.callTool("get_proof_trace", { address: TEST_ADDRESS }, { apiKey: TEST_API_KEY });
    expect(toolResult.ok).toBe(true);
    if (!toolResult.ok) {
      throw new Error(`expected tool success, got ${JSON.stringify(toolResult.error)}`);
    }
    expect(toolResult.value.content[0]?.text).toBe(restResponse.body);
    const body = JSON.parse(toolResult.value.content[0]?.text ?? "{}") as ProofBody;
    expect((body.proofs ?? []).length).toBeGreaterThan(0);
    await rest.close();
  });

  test("get_proof_trace_without_a_service_is_unavailable", async () => {
    const { services, rpc } = buildServices();
    const mcp: McpServer = createMcpServer({
      detectors: mustDefaultDetectorSet(),
      services,
      ...sharedOptions(),
      snippetRpc: rpc,
    });
    const result = await mcp.callTool("get_proof_trace", { address: TEST_ADDRESS });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected not-available error");
    }
    expect(result.error.code).toBe("proof-not-available");
  });

  test("get_verified_source_summarises_and_quotes_only_the_requested_range", async () => {
    const { services, rpc } = buildServices();
    const mcp: McpServer = createMcpServer({
      detectors: mustDefaultDetectorSet(),
      services,
      ...sharedOptions(),
      snippetRpc: rpc,
      sourceService: stubSourceService(),
    });
    const summary = await mcp.callTool("get_verified_source", { address: TEST_ADDRESS });
    expect(summary.ok).toBe(true);
    if (!summary.ok) {
      throw new Error(`expected tool success, got ${JSON.stringify(summary.error)}`);
    }
    const summaryBody = JSON.parse(summary.value.content[0]?.text ?? "{}") as SourceBody;
    expect(summaryBody.source?.status).toBe("verified");
    expect(summaryBody.source?.match).toBe("full");
    expect(typeof summaryBody.source?.compiler).toBe("string");
    expect(summaryBody.source?.functions).toHaveLength(1);
    expect(summaryBody.source?.files).toEqual([]);
    expect(summaryBody.source).not.toHaveProperty("file");

    const ranged = await mcp.callTool("get_verified_source", {
      address: TEST_ADDRESS,
      functionSelector: TEST_SELECTOR,
    });
    expect(ranged.ok).toBe(true);
    if (!ranged.ok) {
      throw new Error(`expected tool success, got ${JSON.stringify(ranged.error)}`);
    }
    const rangedBody = JSON.parse(ranged.value.content[0]?.text ?? "{}") as SourceBody;
    expect(rangedBody.codeHash).toBe(summaryBody.codeHash);
    expect(rangedBody.source?.file?.path).toBe(FIXTURE_FILE);
    expect(rangedBody.source?.file?.content).toBe(
      ["function transfer(address to, uint256 amount) {", "balances[to] += amount;", "}"].join("\n"),
    );

    const unknown = await mcp.callTool("get_verified_source", {
      address: TEST_ADDRESS,
      functionSelector: "0xdeadbeef",
    });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) {
      throw new Error("expected unknown-function error");
    }
    expect(unknown.error.code).toBe("validation-error");
  });

  test("get_verified_source_without_a_service_is_unavailable", async () => {
    const { services } = buildServices();
    const mcp: McpServer = createMcpServer({ detectors: mustDefaultDetectorSet(), services, ...sharedOptions() });
    const result = await mcp.callTool("get_verified_source", { address: TEST_ADDRESS });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected tool success");
    }
    const body = JSON.parse(result.value.content[0]?.text ?? "{}") as SourceBody;
    expect(body.source?.status).toBe("unavailable");
  });

  test("list_new_tokens_merges_on_chain_pairs_with_market_promotions", async () => {
    const { services } = buildServices();
    const live = stubLiveTokens();
    const market = stubMarket();
    const mcp: McpServer = createMcpServer({
      detectors: mustDefaultDetectorSet(),
      services,
      ...sharedOptions(),
      liveTokens: live,
      marketNew: market,
    });
    const result = await mcp.callTool("list_new_tokens", {});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`expected tool success, got ${JSON.stringify(result.error)}`);
    }
    const body = JSON.parse(result.value.content[0]?.text ?? "{}") as ListingBody;
    expect(body.chain).toBe("ethereum");
    expect(body.live?.status).toBe("live");
    expect(body.live?.items).toHaveLength(2);
    expect(body.market?.status).toBe("live");
    expect(body.market?.items).toHaveLength(1);

    const trimmed = await mcp.callTool("list_new_tokens", { since: 1699999995000 });
    expect(trimmed.ok).toBe(true);
    if (!trimmed.ok) {
      throw new Error("expected tool success");
    }
    const trimmedBody = JSON.parse(trimmed.value.content[0]?.text ?? "{}") as ListingBody;
    expect(trimmedBody.live?.items).toHaveLength(1);

    for (const args of [{ chain: "solana" }, { since: "soon" }, { chain: "ethereum", since: -1 }]) {
      const bad = await mcp.callTool("list_new_tokens", args);
      expect(bad.ok).toBe(false);
      if (bad.ok) {
        throw new Error("expected validation error");
      }
      expect(bad.error.code).toBe("validation-error");
    }
  });

  test("list_new_tokens_without_readers_is_not_configured", async () => {
    const { services } = buildServices();
    const mcp: McpServer = createMcpServer({ detectors: mustDefaultDetectorSet(), services, ...sharedOptions() });
    const result = await mcp.callTool("list_new_tokens", {});
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected listings error");
    }
    expect(result.error.code).toBe("listings-not-configured");
  });

  test("list_new_tokens_maps_a_market_failure_to_upstream", async () => {
    const { services } = buildServices();
    const failing: MarketNewReader = {
      getMarket: async () => {
        throw new Error("synthetic market failure");
      },
    };
    const mcp: McpServer = createMcpServer({
      detectors: mustDefaultDetectorSet(),
      services,
      ...sharedOptions(),
      liveTokens: stubLiveTokens(),
      marketNew: failing,
    });
    const result = await mcp.callTool("list_new_tokens", {});
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected upstream error");
    }
    expect(result.error.code).toBe("upstream-unavailable");
  });
});
