// Session 18 partial coverage: pages fetched before a mid-range
// refusal are kept and the cursor input (coveredToBlock) advances to
// the last fully covered block, for both log sources. The provider
// range cap is replayed by a transport that turns wide spans away, so
// paging is what lets a large range succeed. Synthetic values only,
// no network.
import { describe, expect, test } from "vitest";
import { SecretString } from "../../../src/ports/config.ts";
import { createEtherscanLogsAdapter } from "../../../src/adapters/lpFeed/etherscanLogsAdapter.ts";
import { createRpcLogsAdapter } from "../../../src/adapters/lpFeed/rpcLogsAdapter.ts";
import { syntheticAddress, syntheticTxHash } from "../../helpers/syntheticAddresses.ts";

const FACTORY = syntheticAddress(21);
const BLOCK_HASH = syntheticTxHash(31);
const TX = syntheticTxHash(32);

function rawLog(index: number): Record<string, unknown> {
  return {
    address: FACTORY,
    topics: [syntheticTxHash(40)],
    data: "0x00",
    blockNumber: index,
    blockHash: BLOCK_HASH,
    transactionHash: TX,
    logIndex: index,
  };
}

function pageBody(logs: unknown[]): string {
  return JSON.stringify({ status: "1", message: "OK", result: logs });
}

const RATE_LIMIT_BODY = JSON.stringify({
  status: "0",
  message: "NOTOK",
  result: "Max rate limit reached, please use API Key for higher rate limit",
});

describe("feed partial coverage (session 18)", () => {
  test("a refused third page keeps the first two pages with coverage", async () => {
    const sentUrls: string[] = [];
    const adapter = createEtherscanLogsAdapter({
      apiKey: new SecretString("test-key"),
      transport: async (url: string) => {
        sentUrls.push(url);
        const from = /fromBlock=(\d+)/.exec(url)?.[1] ?? "";
        if (from === "20") {
          return { status: 200, bodyText: RATE_LIMIT_BODY };
        }
        const page = Math.floor(Number(from) / 10);
        return { status: 200, bodyText: pageBody([rawLog(page)]) };
      },
      callsPerSecond: 100,
      dailyCap: 100000,
      maxBlocksPerPage: 10,
    });
    const polled = await adapter.pollLogs(
      { factory: FACTORY, fromBlock: 0, toBlock: 34 },
      { requestId: "req-partial", deadlineMs: Number.MAX_SAFE_INTEGER },
    );
    expect(polled.ok).toBe(true);
    if (!polled.ok) {
      return;
    }
    expect(polled.value.logs.map((log) => log.logIndex)).toEqual([0, 1]);
    expect(polled.value.coveredToBlock).toBe(19);
    expect(sentUrls.length).toBe(3);
  });

  test("own bucket exhaustion is local scope, provider refusals are provider scope", async () => {
    const adapter = createEtherscanLogsAdapter({
      apiKey: new SecretString("test-key"),
      transport: async () => ({ status: 200, bodyText: pageBody([]) }),
      now: () => 1_700_000_000_000,
      callsPerSecond: 1,
      dailyCap: 100000,
    });
    const ctx = { requestId: "req-scope", deadlineMs: Number.MAX_SAFE_INTEGER };
    const first = await adapter.pollLogs({ factory: FACTORY, fromBlock: 0, toBlock: 5 }, ctx);
    expect(first.ok).toBe(true);
    const second = await adapter.pollLogs({ factory: FACTORY, fromBlock: 0, toBlock: 5 }, ctx);
    expect(second.ok).toBe(false);
    if (second.ok || second.error.kind !== "rate-limited") {
      throw new Error("expected a local-scope rate limit");
    }
    expect(second.error.scope).toBe("local");

    const refusing = createEtherscanLogsAdapter({
      apiKey: new SecretString("test-key"),
      transport: async () => ({ status: 200, bodyText: RATE_LIMIT_BODY }),
      now: () => 1_700_000_000_000,
      callsPerSecond: 100,
      dailyCap: 100000,
    });
    const refused = await refusing.pollLogs({ factory: FACTORY, fromBlock: 0, toBlock: 5 }, ctx);
    expect(refused.ok).toBe(false);
    if (refused.ok || refused.error.kind !== "rate-limited") {
      throw new Error("expected a provider-scope rate limit");
    }
    expect(refused.error.scope).toBe("provider");
  });

  test("paged RPC succeeds where a single wide range is turned away", async () => {
    const sentBodies: string[] = [];
    const adapter = createRpcLogsAdapter({
      url: new SecretString("https://rpc.example.invalid"),
      maxBlocksPerPage: 10,
      transport: async (url: string, body: string) => {
        const request = JSON.parse(body) as { method: string };
        if (request.method === "eth_getBlockByNumber") {
          // Block time lookups for the chain-time age are not log pages.
          return {
            status: 200,
            bodyText: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { timestamp: "0x6553f100" } }),
          };
        }
        sentBodies.push(body);
        const parsed = JSON.parse(body) as { params: [{ fromBlock: string; toBlock: string }] };
        const from = Number.parseInt(parsed.params[0].fromBlock, 16);
        const to = Number.parseInt(parsed.params[0].toBlock, 16);
        if (to - from > 10) {
          return {
            status: 200,
            bodyText: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "query exceeds the block range cap" } }),
          };
        }
        void url;
        return {
          status: 200,
          bodyText: JSON.stringify({ jsonrpc: "2.0", id: 1, result: [rawLog(from)] }),
        };
      },
    });
    const polled = await adapter.pollLogs(
      { factory: FACTORY, fromBlock: 0, toBlock: 29 },
      { requestId: "req-rpc-pages", deadlineMs: Number.MAX_SAFE_INTEGER },
    );
    expect(polled.ok).toBe(true);
    if (!polled.ok) {
      return;
    }
    expect(sentBodies.length).toBe(3);
    expect(polled.value.logs).toHaveLength(3);
    expect(polled.value.coveredToBlock).toBe(29);
  });

  test("a refused RPC page keeps the earlier pages with coverage", async () => {
    const adapter = createRpcLogsAdapter({
      url: new SecretString("https://rpc.example.invalid"),
      maxBlocksPerPage: 10,
      transport: async (_url: string, body: string) => {
        const parsed = JSON.parse(body) as { params: [{ fromBlock: string }] };
        const from = Number.parseInt(parsed.params[0].fromBlock, 16);
        if (from >= 20) {
          return { status: 429, bodyText: "limited" };
        }
        return {
          status: 200,
          bodyText: JSON.stringify({ jsonrpc: "2.0", id: 1, result: [rawLog(from)] }),
        };
      },
    });
    const polled = await adapter.pollLogs(
      { factory: FACTORY, fromBlock: 0, toBlock: 29 },
      { requestId: "req-rpc-partial", deadlineMs: Number.MAX_SAFE_INTEGER },
    );
    expect(polled.ok).toBe(true);
    if (!polled.ok) {
      return;
    }
    expect(polled.value.logs).toHaveLength(2);
    expect(polled.value.coveredToBlock).toBe(19);
  });
});
