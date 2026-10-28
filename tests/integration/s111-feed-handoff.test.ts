// Feed-driven handoff parity (S-111, K-039): a creation that waits in
// the pending queue promotes on the liquidity poll, and the promoted
// candidate feeds one handoff through the service and both drivers: the
// REST body and the MCP tool text carry the byte-identical envelope. A
// block-hash change orphans the pending entry and the orphan report
// exposes the conflicting hash. No network; all ports are fakes.
import { describe, expect, test } from "vitest";
import { parseModelArtifact } from "../../src/domain/risk.ts";
import type { Result } from "../../src/domain/result.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  IndexVersion,
  ModelVersion,
  TemplateVersion,
  Timestamp,
} from "../../src/domain/types.ts";
import type { CapabilityCatalogue } from "../../src/domain/signals.ts";
import { createAppServices } from "../../src/application/analyzeToken.ts";
import type { AppServices } from "../../src/application/analyzeToken.ts";
import {
  analysisHandoffKey,
  noteAnalysisAddress,
  processFeedPoll,
} from "../../src/application/lpFeedService.ts";
import { SecretString } from "../../src/ports/config.ts";
import { FakeClockAdapter } from "../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../fakes/fakeRpc.ts";
import { createRestServer } from "../../src/interfaces/rest/server.ts";
import { createMcpServer } from "../../src/interfaces/mcp/server.ts";
import { mustDefaultDetectorSet } from "../helpers/detectorSets.ts";
import { QUOTE_TOKENS, V2_PAIR_CREATED_TOPIC0, V2_MINT_TOPIC0 } from "../../src/domain/lpFeed.ts";
import { parseFeedLog } from "../../src/adapters/lpFeed/feedLogCodec.ts";
import type { FeedLog } from "../../src/ports/lpFeed.ts";

const FACTORY_V2 = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
const PAIR = "0x338ab1edd0ebd1d7b065de0398050279c1bcb8d7";
const USDC = QUOTE_TOKENS.usdc.toLowerCase();
const ASSET = "0x419174f249096c659f013ccdc3d233c330bd803c";
const TX = "0x53dcb2e5ccbeaa8ee43360a826116afb791e69432d80637b5426465234361068";
const BLOCK_HASH_1 = "0xcaa11e6b828301b0c1549c1a0b3166ded2acdcfe547cdfd83a9cd5cae98f33c0";
const BLOCK_HASH_2 = `0x${"db".repeat(32)}`;
const FROM_BLOCK = 21600000;
const TEST_BYTECODE = "0x6001600201";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.message}`);
  }
  return result.value;
}

function word(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

function creationLog(blockHash: string): Record<string, unknown> {
  return {
    address: FACTORY_V2,
    topics: [V2_PAIR_CREATED_TOPIC0, word(USDC), word(ASSET)],
    data: `${word(PAIR)}${"0".repeat(62)}02`.toLowerCase(),
    blockNumber: FROM_BLOCK,
    blockHash,
    transactionHash: TX,
    logIndex: 0,
  };
}

function feedLogs(raws: readonly Record<string, unknown>[]): readonly FeedLog[] {
  return Object.freeze(
    raws.map((raw) => {
      const parsed = parseFeedLog(raw);
      if (parsed === null) {
        throw new Error('fixture log must parse');
      }
      return parsed;
    }),
  );
}

function mintLog(): Record<string, unknown> {
  return {
    address: PAIR,
    topics: [V2_MINT_TOPIC0],
    data: "0x00",
    blockNumber: FROM_BLOCK,
    blockHash: BLOCK_HASH_1,
    transactionHash: TX,
    logIndex: 1,
  };
}

const QUOTES = {
  usdc: QUOTE_TOKENS.usdc,
  usdt: QUOTE_TOKENS.usdt,
  dai: QUOTE_TOKENS.dai,
  weth: null,
  allowNativeZero: false,
};

const CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

function services(): AppServices {
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
  const codes = new Map<string, string>([[mustOk(Address.parse(ASSET)) as string, TEST_BYTECODE]]);
  return createAppServices(
    {
      rpc: new FakeRpcAdapter(codes, mustOk(BlockNumber.of(FROM_BLOCK))),
      modelArtifacts: new FakeModelArtifactAdapter(
        Object.freeze({ artifact, checksum: mustOk(ArtifactChecksum.parse("ef".repeat(32))) }),
      ),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
    mustDefaultDetectorSet(),
  );
}

const TEST_API_KEY = "test-key-for-handoff-suite-only";

function driverOptions(appServices: AppServices) {
  return {
    services: appServices,
    apiKeys: [new SecretString(TEST_API_KEY)],
    apiKeyPepper: new SecretString("test-pepper-for-handoff-suite-only"),
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: CATALOGUE,
    detectors: mustDefaultDetectorSet(),
    rateLimit: { perKeyPerMinute: 1000000, perKeyPerDay: 10000000, globalPerMinute: 1000000 },
  };
}

function mcpOptions(appServices: AppServices) {
  return {
    ...driverOptions(appServices),
    apiKeys: [],
  };
}

describe("feed-driven handoff parity (S-111)", () => {
  test("s111_pending_then_promoted_feeds_one_handoff", async () => {
    const appServices = services();

    // Poll one: the creation without liquidity waits in the pending queue.
    const first = processFeedPoll({
      logs: feedLogs([creationLog(BLOCK_HASH_1)]),
      quotes: QUOTES,
      pending: [],
      seenKeys: new Set<string>(),
      blockHashByKey: new Map<string, string>(),
      nowMs: 1_700_000_000_000,
      ttlMs: 300_000,
    });
    expect(first.candidates).toHaveLength(0);
    expect(first.pending).toHaveLength(1);

    // Poll two: the Mint log for the new pair promotes the same entry.
    const second = processFeedPoll({
      logs: feedLogs([mintLog()]),
      quotes: QUOTES,
      pending: first.pending,
      seenKeys: first.seenKeys,
      blockHashByKey: first.blockHashByKey,
      nowMs: 1_700_000_000_100,
      ttlMs: 300_000,
    });
    expect(second.candidates).toHaveLength(1);
    expect(second.pending).toHaveLength(0);
    const candidate = second.candidates[0];
    if (candidate === undefined || candidate.tokenAddress !== ASSET) {
      throw new Error("expected the promoted candidate for the asset");
    }

    // One handoff for the promoted candidate even when noted repeatedly.
    const key = analysisHandoffKey(1, "ab".repeat(32));
    if (!key.ok) {
      throw new Error("expected the handoff key to build");
    }
    const pointers = new Map<string, string>();
    noteAnalysisAddress(pointers, candidate.tokenAddress, key.value);
    noteAnalysisAddress(pointers, candidate.tokenAddress.toUpperCase(), key.value);
    expect(pointers.size).toBe(1);

    // The service, REST and MCP build the same envelope for the candidate.
    const rest = createRestServer(driverOptions(appServices));
    const mcp = createMcpServer(mcpOptions(appServices));
    try {
      const response = await rest.inject({
        method: "GET",
        url: `/v1/analyze?address=${ASSET}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(response.statusCode).toBe(200);
      const toolResult = await mcp.callTool("assess_token", { address: ASSET });
      expect(toolResult.ok).toBe(true);
      if (!toolResult.ok) {
        throw new Error("expected the tool call to succeed");
      }
      const text = toolResult.value.content[0]?.text ?? "";
      expect(text).toBe(response.body);
      expect((JSON.parse(text) as { codeHash?: unknown }).codeHash).toBeDefined();
    } finally {
      await rest.close();
    }

    // A block-hash change on the same funded creation re-emits it as an
    // orphan, and the orphan report exposes the conflicting hash.
    const reorganised = processFeedPoll({
      logs: feedLogs([creationLog(BLOCK_HASH_2), mintLog()]),
      quotes: QUOTES,
      pending: second.pending,
      seenKeys: second.seenKeys,
      blockHashByKey: second.blockHashByKey,
      nowMs: 1_700_000_000_200,
      ttlMs: 300_000,
    });
    expect(reorganised.candidates).toHaveLength(1);
    expect(reorganised.candidates[0]?.orphaned).toBe(true);
    expect(reorganised.candidates[0]?.blockHash).toBe(BLOCK_HASH_2);
  });
});
