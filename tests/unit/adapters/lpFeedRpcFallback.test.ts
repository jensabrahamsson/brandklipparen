// Optional JSON-RPC eth_getLogs fallback on the same port (S-088,
// K-039). Test-first: these tests fail until the RPC fallback adapter
// lands. No live calls: the tests inject a fake JSON-RPC transport with
// recorded fixtures.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { SecretString } from "../../../src/ports/config.ts";
import { createRpcLogsAdapter } from "../../../src/adapters/lpFeed/rpcLogsAdapter.ts";

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
    expect(sentBodies).toHaveLength(1);
    const request = JSON.parse(sentBodies[0] ?? "{}") as {
      method: string;
      params: { address: string; fromBlock: string; toBlock: string }[];
    };
    expect(request.method).toBe("eth_getLogs");
    expect(request.params[0]?.address.toLowerCase()).toBe(FACTORY_V3.toLowerCase());
    expect(request.params[0]?.fromBlock).toBe("0x1499701");
    expect(request.params[0]?.toBlock).toBe("0x1499701");
    // Same candidate shape as the Etherscan adapter behind LpFeedPort.
    expect(result.value).toHaveLength(2);
    for (const log of result.value) {
      expect(Object.keys(log).sort()).toEqual(
        ["address", "blockHash", "blockNumber", "data", "logIndex", "topics", "txHash"],
      );
    }
    expect(result.value[0]?.address).toBe(FACTORY_V3.toLowerCase());
    expect(result.value[0]?.blockNumber).toBe(21600001);
    expect(result.value[0]?.logIndex).toBe(2);
    expect(result.value[1]?.blockHash).toBe(
      "0x07d83539997af0b620147b78fe38d8926def3dd49ae49c99fd4bc498f1fa43f4",
    );
  });
});
