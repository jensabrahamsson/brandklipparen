// Etherscan logs source with token bucket and backoff (S-087, K-039,
// K-505). Test-first: these tests fail until the port and the Etherscan
// adapter land. No live calls: every test injects a fake transport with
// recorded fixtures and a manual clock.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { SecretString } from "../../../src/ports/config.ts";
import { createEtherscanLogsAdapter } from "../../../src/adapters/lpFeed/etherscanLogsAdapter.ts";

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

const FACTORY_V2 = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";

function manualClock(startMs = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number): void => {
      current += ms;
    },
  };
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
      expect(afterRefill.value).toHaveLength(2);
      expect(afterRefill.value[0]?.blockNumber).toBe(21600000);
      expect(afterRefill.value[0]?.logIndex).toBe(0);
      expect(afterRefill.value[0]?.txHash).toBe(
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
});
