// Etherscan logs source with token bucket and backoff (S-087, K-039,
// K-505). Test-first: these tests fail until the port and the Etherscan
// adapter land. No live calls: every test injects a fake transport with
// recorded fixtures and a manual clock.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { SecretString } from "../../../src/ports/config.ts";
import { V2_PAIR_CREATED_TOPIC0 } from "../../../src/domain/lpFeed.ts";
import { createEtherscanLogsAdapter } from "../../../src/adapters/lpFeed/etherscanLogsAdapter.ts";
import { parseFeedLog } from "../../../src/adapters/lpFeed/feedLogCodec.ts";
import { syntheticTxHash } from "../../helpers/syntheticAddresses.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURE = readFileSync(
  join(repoRoot, "tests", "fixtures", "lpfeed", "etherscan-pair-created.json"),
  "utf8",
);
const RATE_LIMIT_BODY = JSON.stringify({
  status: "0",
  message: "NOTOK",
  result: "Max rate limit reached, please use API Key for higher rate limit",
});
const EMPTY_RANGE_FIXTURE = readFileSync(
  join(repoRoot, "tests", "fixtures", "lpfeed", "etherscan-empty-range.json"),
  "utf8",
);

const FACTORY_V2 = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";

function syntheticNowMs(): number {
  return 1730000000000;
}

function manualClock(startMs = syntheticNowMs()): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number): void => {
      current += ms;
    },
  };
}

function stampHex(seconds: number): string {
  return `0x${seconds.toString(16)}`;
}

describe("etherscan logs source", () => {
  test("k039_etherscan_without_key_reports_not_configured_and_sends_nothing", async () => {
    let sends = 0;
    const adapter = createEtherscanLogsAdapter({
      apiKey: undefined,
      transport: async () => {
        sends += 1;
        return { status: 200, bodyText: FIXTURE };
      },
    });
    const result = await adapter.pollLogs(
      { factory: FACTORY_V2, fromBlock: 21600000, toBlock: 21600002 },
      { requestId: "req-1", deadlineMs: Number.MAX_SAFE_INTEGER },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("not-configured");
    }
    expect(sends).toBe(0);
  });

  test("k039_etherscan_polls_one_factory_per_call_with_token_bucket", async () => {
    const sentUrls: string[] = [];
    const clock = manualClock();
    const adapter = createEtherscanLogsAdapter({
      apiKey: new SecretString("test-key"),
      transport: async (url: string) => {
        sentUrls.push(url);
        return { status: 200, bodyText: FIXTURE };
      },
      now: clock.now,
      callsPerSecond: 3,
      dailyCap: 100000,
    });
    const ctx = { requestId: "req-1", deadlineMs: Number.MAX_SAFE_INTEGER };
    for (let call = 0; call < 3; call += 1) {
      const result = await adapter.pollLogs(
        { factory: FACTORY_V2, fromBlock: 21600000, toBlock: 21600002 },
        ctx,
      );
      expect(result.ok).toBe(true);
    }
    expect(sentUrls).toHaveLength(3);
    const first = new URL(sentUrls[0] ?? "");
    expect(first.searchParams.get("module")).toBe("logs");
    expect(first.searchParams.get("action")).toBe("getLogs");
    expect(first.searchParams.get("chainid")).toBe("1");
    expect((first.searchParams.get("address") ?? "").toLowerCase()).toBe(FACTORY_V2.toLowerCase());
    expect(first.searchParams.get("fromBlock")).toBe("21600000");
    expect(first.searchParams.get("toBlock")).toBe("21600002");
    const fourth = await adapter.pollLogs(
      { factory: FACTORY_V2, fromBlock: 21600000, toBlock: 21600002 },
      ctx,
    );
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) {
      expect(fourth.error.kind).toBe("rate-limited");
    }
    expect(sentUrls).toHaveLength(3);
    clock.advance(1000);
    const afterRefill = await adapter.pollLogs(
      { factory: FACTORY_V2, fromBlock: 21600000, toBlock: 21600002 },
      ctx,
    );
    expect(afterRefill.ok).toBe(true);
    if (afterRefill.ok) {
      expect(afterRefill.value.logs).toHaveLength(2);
      expect(afterRefill.value.logs[0]?.blockNumber).toBe(21600000);
      expect(afterRefill.value.logs[0]?.logIndex).toBe(0);
      expect(afterRefill.value.logs[0]?.txHash).toBe(
        "0x53dcb2e5ccbeaa8ee43360a826116afb791e69432d80637b5426465234361068",
      );
    }
    expect(sentUrls).toHaveLength(4);
  });

  test("k039_etherscan_backs_off_on_rate_limit", async () => {
    let sends = 0;
    let limited = true;
    const clock = manualClock();
    const adapter = createEtherscanLogsAdapter({
      apiKey: new SecretString("test-key"),
      transport: async () => {
        sends += 1;
        return limited
          ? { status: 200, bodyText: RATE_LIMIT_BODY }
          : { status: 200, bodyText: FIXTURE };
      },
      now: clock.now,
      callsPerSecond: 100,
      dailyCap: 100000,
      backoffBaseMs: 1000,
    });
    const ctx = { requestId: "req-1", deadlineMs: Number.MAX_SAFE_INTEGER };
    const input = { factory: FACTORY_V2, fromBlock: 21600000, toBlock: 21600002 };
    const first = await adapter.pollLogs(input, ctx);
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.error.kind).toBe("rate-limited");
    }
    expect(sends).toBe(1);
    limited = false;
    const duringBackoff = await adapter.pollLogs(input, ctx);
    expect(duringBackoff.ok).toBe(false);
    if (!duringBackoff.ok) {
      expect(duringBackoff.error.kind).toBe("rate-limited");
    }
    expect(sends).toBe(1);
    clock.advance(1000);
    const afterBackoff = await adapter.pollLogs(input, ctx);
    expect(afterBackoff.ok).toBe(true);
    expect(sends).toBe(2);
  });

  test("sec1_s7_explorer_key_never_appears_in_error_messages", async () => {
    const secret = "synthetic-explorer-key-for-tests";
    const echoingBody = JSON.stringify({
      status: "0",
      message: "NOTOK",
      result: `Invalid API Key for https://api.etherscan.io/v2/api?chainid=1&module=logs&apikey=${secret}&address=0x0`,
    });
    const adapter = createEtherscanLogsAdapter({
      apiKey: new SecretString(secret),
      transport: async () => ({ status: 200, bodyText: echoingBody }),
      now: manualClock().now,
      callsPerSecond: 100,
      dailyCap: 100000,
    });
    const result = await adapter.pollLogs(
      { factory: FACTORY_V2, fromBlock: 21600000, toBlock: 21600002 },
      { requestId: "req-1", deadlineMs: Number.MAX_SAFE_INTEGER },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toContain(secret);
      expect(result.error.message).toContain("apikey=[REDACTED]");
    }
    // A throwing transport also surfaces only the fixed message.
    const throwing = createEtherscanLogsAdapter({
      apiKey: new SecretString(secret),
      transport: async (url: string) => {
        throw new Error(`fetch failed for ${url}`);
      },
      now: manualClock().now,
      callsPerSecond: 100,
      dailyCap: 100000,
    });
    const failed = await throwing.pollLogs(
      { factory: FACTORY_V2, fromBlock: 21600000, toBlock: 21600002 },
      { requestId: "req-1", deadlineMs: Number.MAX_SAFE_INTEGER },
    );
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.message).not.toContain(secret);
    }
  });

  test("k039_etherscan_empty_range_returns_empty_list", async () => {
    // A quiet range answers status "0" with an empty result array (or the
    // "No records found" text): both are an empty log list, never an
    // invalid-response error.
    const bodies = [
      EMPTY_RANGE_FIXTURE,
      JSON.stringify({ status: "0", message: "No records found", result: "No records found" }),
    ];
    const ctx = { requestId: "req-1", deadlineMs: Number.MAX_SAFE_INTEGER };
    const input = { factory: FACTORY_V2, fromBlock: 21600000, toBlock: 21600002 };
    for (const bodyText of bodies) {
      const adapter = createEtherscanLogsAdapter({
        apiKey: new SecretString("test-key"),
        transport: async () => ({ status: 200, bodyText }),
        now: manualClock().now,
        callsPerSecond: 100,
        dailyCap: 100000,
      });
      const result = await adapter.pollLogs(input, ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(`expected an empty list, got error: ${result.error.kind}`);
      }
      expect(result.value.logs).toEqual([]);
      expect(result.value.coveredToBlock).toBe(21600002);
    }
  });

  test("chain time parses from the hex timeStamp and stays null when unusable", async () => {
    const clock = manualClock();
    const adapter = createEtherscanLogsAdapter({
      apiKey: new SecretString("test-key"),
      transport: async () => ({ status: 200, bodyText: FIXTURE }),
      now: clock.now,
      callsPerSecond: 100,
      dailyCap: 100000,
    });
    const polled = await adapter.pollLogs(
      { factory: FACTORY_V2, fromBlock: 21600000, toBlock: 21600002 },
      { requestId: "req-stamp", deadlineMs: Number.MAX_SAFE_INTEGER },
    );
    expect(polled.ok).toBe(true);
    if (!polled.ok) {
      throw new Error(`expected logs, got ${polled.error.kind}`);
    }
    expect(polled.value.logs).toHaveLength(2);
    expect(polled.value.logs[0]?.blockTimestampMs).toBe(parseInt("0x67123456", 16) * 1000);
  });

  test("strict stamp parsing keeps the log with null on bad input", () => {
    const nowMs = syntheticNowMs();
    const base = {
      address: FACTORY_V2,
      topics: [V2_PAIR_CREATED_TOPIC0],
      data: "0x00",
      blockNumber: "0x1499700",
      blockHash: syntheticTxHash(7),
      transactionHash: syntheticTxHash(1),
      logIndex: "0x0",
    };
    const pastSec = Math.floor((nowMs - 3600 * 1000) / 1000);
    expect(parseFeedLog({ ...base, timeStamp: stampHex(pastSec) }, nowMs)?.blockTimestampMs).toBe(
      pastSec * 1000,
    );
    // Missing stamp stays unknown but the log stays valid.
    expect(parseFeedLog({ ...base }, nowMs)?.blockTimestampMs).toBeNull();
    // Decimal, bare hex and far-future stamps never fabricate a time.
    expect(parseFeedLog({ ...base, timeStamp: String(pastSec) }, nowMs)?.blockTimestampMs).toBeNull();
    expect(parseFeedLog({ ...base, timeStamp: "0x" }, nowMs)?.blockTimestampMs).toBeNull();
    const futureSec = Math.floor((nowMs + 3600 * 1000) / 1000);
    expect(parseFeedLog({ ...base, timeStamp: stampHex(futureSec) }, nowMs)?.blockTimestampMs).toBeNull();
    // A stamp inside the small skew still counts.
    const nearSec = Math.floor((nowMs + 60 * 1000) / 1000);
    expect(parseFeedLog({ ...base, timeStamp: stampHex(nearSec) }, nowMs)?.blockTimestampMs).toBe(
      nearSec * 1000,
    );
  });
});
