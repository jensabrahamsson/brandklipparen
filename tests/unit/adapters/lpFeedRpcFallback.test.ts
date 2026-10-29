// Optional JSON-RPC eth_getLogs fallback on the same port (S-088,
// K-039). Test-first: these tests fail until the RPC fallback adapter
// lands. No live calls: the tests inject a fake JSON-RPC transport with
// recorded fixtures.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { SecretString } from "../../../src/ports/config.ts";
import { V3_POOL_CREATED_TOPIC0 } from "../../../src/domain/lpFeed.ts";
import { createRpcLogsAdapter } from "../../../src/adapters/lpFeed/rpcLogsAdapter.ts";
import { parseFeedLog } from "../../../src/adapters/lpFeed/feedLogCodec.ts";
import { syntheticTxHash } from "../../helpers/syntheticAddresses.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURE = readFileSync(join(repoRoot, "tests", "fixtures", "lpfeed", "rpc-getlogs.json"), "utf8");

const FACTORY_V3 = "0x1F98431c8aD98523631AE4a59f267346ea31F984";

describe("rpc logs fallback", () => {
  test("k039_rpc_fallback_without_url_reports_not_configured", async () => {
    let sends = 0;
    const adapter = createRpcLogsAdapter({
      url: undefined,
      transport: async () => {
        sends += 1;
        return { status: 200, bodyText: FIXTURE };
      },
    });
    const result = await adapter.pollLogs(
      { factory: FACTORY_V3, fromBlock: 21600001, toBlock: 21600001 },
      { requestId: "req-1", deadlineMs: Number.MAX_SAFE_INTEGER },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("not-configured");
    }
    expect(sends).toBe(0);
  });

  test("k039_rpc_fallback_returns_same_port_shape", async () => {
    const sentBodies: string[] = [];
    const adapter = createRpcLogsAdapter({
      url: new SecretString("https://rpc.example.test"),
      transport: async (url: string, body: string) => {
        expect(url).toBe("https://rpc.example.test");
        sentBodies.push(body);
        const parsed = JSON.parse(body) as { method?: string };
        if (parsed.method === "eth_getBlockByNumber") {
          return { status: 200, bodyText: JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }) };
        }
        return { status: 200, bodyText: FIXTURE };
      },
    });
    const result = await adapter.pollLogs(
      { factory: FACTORY_V3, fromBlock: 21600001, toBlock: 21600001 },
      { requestId: "req-1", deadlineMs: Number.MAX_SAFE_INTEGER },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const logsRequest = JSON.parse(sentBodies[0] ?? "{}") as {
      method: string;
      params: { address: string; fromBlock: string; toBlock: string }[];
    };
    expect(logsRequest.method).toBe("eth_getLogs");
    expect(logsRequest.params[0]?.address.toLowerCase()).toBe(FACTORY_V3.toLowerCase());
    expect(logsRequest.params[0]?.fromBlock).toBe("0x1499701");
    expect(logsRequest.params[0]?.toBlock).toBe("0x1499701");
    // Same candidate shape as the Etherscan adapter behind LpFeedPort.
    expect(result.value.logs).toHaveLength(2);
    for (const log of result.value.logs) {
      expect(Object.keys(log).sort()).toEqual(
        ["address", "blockHash", "blockNumber", "blockTimestampMs", "data", "logIndex", "topics", "txHash"],
      );
      // The recorded RPC fixture carries no stamp, and the block lookup
      // answers null here, so the age stays honestly unknown.
      expect(log.blockTimestampMs).toBeNull();
    }
    expect(result.value.logs[0]?.address).toBe(FACTORY_V3.toLowerCase());
    expect(result.value.logs[0]?.blockNumber).toBe(21600001);
    expect(result.value.logs[0]?.logIndex).toBe(2);
    expect(result.value.logs[1]?.blockHash).toBe(
      "0x07d83539997af0b620147b78fe38d8926def3dd49ae49c99fd4bc498f1fa43f4",
    );
  });

  test("rpc blockTimestamp in the log needs no extra lookup", () => {
    const nowMs = 1730000000000;
    const pastSec = Math.floor((nowMs - 3600 * 1000) / 1000);
    const raw = {
      address: FACTORY_V3,
      topics: [V3_POOL_CREATED_TOPIC0],
      data: "0x00",
      blockNumber: "0x1499701",
      blockHash: syntheticTxHash(7),
      transactionHash: syntheticTxHash(1),
      logIndex: "0x2",
      blockTimestamp: `0x${pastSec.toString(16)}`,
    };
    expect(parseFeedLog(raw, nowMs)?.blockTimestampMs).toBe(pastSec * 1000);
  });

  test("missing rpc stamps resolve once per block and stay null on failure", async () => {
    const pastSec = Math.floor((1730000000000 - 3600 * 1000) / 1000);
    const stampHex = `0x${pastSec.toString(16)}`;
    const logsBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: [
        {
          address: FACTORY_V3,
          topics: [V3_POOL_CREATED_TOPIC0],
          data: "0x00",
          blockNumber: "0x10",
          blockHash: syntheticTxHash(7),
          transactionHash: syntheticTxHash(1),
          logIndex: "0x0",
        },
        {
          address: FACTORY_V3,
          topics: [V3_POOL_CREATED_TOPIC0],
          data: "0x00",
          blockNumber: "0x10",
          blockHash: syntheticTxHash(7),
          transactionHash: syntheticTxHash(2),
          logIndex: "0x1",
        },
        {
          address: FACTORY_V3,
          topics: [V3_POOL_CREATED_TOPIC0],
          data: "0x00",
          blockNumber: "0x11",
          blockHash: syntheticTxHash(7),
          transactionHash: syntheticTxHash(3),
          logIndex: "0x0",
        },
      ],
    });
    const seen: string[] = [];
    const adapter = createRpcLogsAdapter({
      url: new SecretString("https://rpc.example.test"),
      transport: async (_url: string, body: string) => {
        const parsed = JSON.parse(body) as { method?: string; params?: unknown[] };
        seen.push(parsed.method ?? "");
        if (parsed.method === "eth_getLogs") {
          return { status: 200, bodyText: logsBody };
        }
        const blockParam = (parsed.params?.[0] as string | undefined) ?? "";
        if (blockParam.toLowerCase() === "0x10") {
          return {
            status: 200,
            bodyText: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { timestamp: stampHex } }),
          };
        }
        return { status: 200, bodyText: JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }) };
      },
      now: () => 1730000000000,
    });
    const result = await adapter.pollLogs(
      { factory: FACTORY_V3, fromBlock: 16, toBlock: 17 },
      { requestId: "req-blocks", deadlineMs: Number.MAX_SAFE_INTEGER },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`expected logs, got ${result.error.kind}`);
    }
    // One logs call plus one block call per distinct missing block.
    expect(seen.filter((method) => method === "eth_getLogs")).toHaveLength(1);
    expect(seen.filter((method) => method === "eth_getBlockByNumber")).toHaveLength(2);
    expect(result.value.logs).toHaveLength(3);
    expect(result.value.logs[0]?.blockTimestampMs).toBe(pastSec * 1000);
    expect(result.value.logs[1]?.blockTimestampMs).toBe(pastSec * 1000);
    // The failed block lookup keeps an honest unknown, never a guess.
    expect(result.value.logs[2]?.blockTimestampMs).toBeNull();
  });
});
