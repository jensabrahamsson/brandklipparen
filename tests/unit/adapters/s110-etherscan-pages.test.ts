// Etherscan large-range pagination and log hygiene (S-110, K-039):
// a range wider than one page fans out to one request per block chunk and
// merges the pages in order without silent truncation; `0x` block fields
// parse as zero; malformed logs are skipped and counted instead of failing
// the poll; the daily budget persists across adapter restarts. Written
// first (red) per A-21: the adapter polls once per call. No network; the
// transport answers per-page fixtures.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  EtherscanLogsAdapter,
  createEtherscanLogsAdapter,
} from "../../../src/adapters/lpFeed/etherscanLogsAdapter.ts";
import { parseFeedLog } from "../../../src/adapters/lpFeed/feedLogCodec.ts";
import { SecretString } from "../../../src/ports/config.ts";

const FACTORY = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
const BLOCK_HASH = "0xcaa11e6b828301b0c1549c1a0b3166ded2acdcfe547cdfd83a9cd5cae98f33c0";
const TX = "0x53dcb2e5ccbeaa8ee43360a826116afb791e69432d80637b5426465234361068";

function rawLog(index: number): Record<string, unknown> {
  return {
    address: FACTORY,
    topics: ["0x0d3648bd0f6ba80134a8338bf6b7a3c2063b2c1c5"],
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

describe("etherscan large ranges and log hygiene (S-110)", () => {
  test("s110_large_range_paginates_without_silent_truncation", async () => {
    const sentUrls: string[] = [];
    const adapter = createEtherscanLogsAdapter({
      apiKey: new SecretString("test-key"),
      transport: async (url: string) => {
        sentUrls.push(url);
        const from = /fromBlock=(\d+)/.exec(url)?.[1];
        const index = from === "1000" ? 1 : 0;
        return { status: 200, bodyText: pageBody([rawLog(index)]) };
      },
      callsPerSecond: 100,
      dailyCap: 100000,
      maxBlocksPerPage: 1000,
    });
    const polled = await adapter.pollLogs(
      { factory: FACTORY, fromBlock: 0, toBlock: 1999 },
      { requestId: "req-s110", deadlineMs: Number.MAX_SAFE_INTEGER },
    );
    if (!polled.ok) {
      throw new Error(`expected the paged poll to succeed, got ${polled.error.kind}`);
    }
    // Two pages went out, one per block chunk, and both pages merged in
    // order with no log lost.
    expect(sentUrls.length).toBe(2);
    expect(sentUrls[0]).toContain("fromBlock=0");
    expect(sentUrls[0]).toContain("toBlock=999");
    expect(sentUrls[1]).toContain("fromBlock=1000");
    expect(sentUrls[1]).toContain("toBlock=1999");
    expect(polled.value.map((log) => log.logIndex)).toEqual([0, 1]);
  });

  test("s110_zero_hex_parses_as_zero_and_bad_logs_skip_with_count", async () => {
    const zero = parseFeedLog({ ...rawLog(0), blockNumber: "0x", logIndex: "0x" });
    expect(zero?.blockNumber).toBe(0);
    expect(zero?.logIndex).toBe(0);
    const adapter = createEtherscanLogsAdapter({
      apiKey: new SecretString("test-key"),
      transport: async () => ({
        status: 200,
        bodyText: pageBody([rawLog(0), { address: "not-an-address", topics: [], data: "0x" }]),
      }),
      callsPerSecond: 100,
      dailyCap: 100000,
    });
    const polled = await adapter.pollLogs(
      { factory: FACTORY, fromBlock: 0, toBlock: 10 },
      { requestId: "req-s110", deadlineMs: Number.MAX_SAFE_INTEGER },
    );
    if (!polled.ok) {
      throw new Error(`expected the poll to succeed, got ${polled.error.kind}`);
    }
    expect(polled.value).toHaveLength(1);
    if (!(adapter instanceof EtherscanLogsAdapter)) {
      throw new Error("expected the configured adapter");
    }
    expect(adapter.skippedLogCount()).toBe(1);
  });

  test("s110_daily_budget_persists_across_restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "feed-budget-s110-"));
    const budgetPath = join(dir, "budget.json");
    const first = createEtherscanLogsAdapter({
      apiKey: new SecretString("test-key"),
      transport: async () => ({ status: 200, bodyText: pageBody([]) }),
      callsPerSecond: 100,
      dailyCap: 100000,
      budgetPath,
    });
    const polled = await first.pollLogs(
      { factory: FACTORY, fromBlock: 0, toBlock: 10 },
      { requestId: "req-s110", deadlineMs: Number.MAX_SAFE_INTEGER },
    );
    expect(polled.ok).toBe(true);
    const second = createEtherscanLogsAdapter({
      apiKey: new SecretString("test-key"),
      transport: async () => {
        throw new Error("must not send: budget restore is read from disk");
      },
      callsPerSecond: 100,
      dailyCap: 1,
      budgetPath,
    });
    const limited = await second.pollLogs(
      { factory: FACTORY, fromBlock: 0, toBlock: 10 },
      { requestId: "req-s110", deadlineMs: Number.MAX_SAFE_INTEGER },
    );
    if (limited.ok) {
      throw new Error("expected the restored budget to rate limit the second adapter");
    }
    expect(limited.error.kind).toBe("rate-limited");
  });
});
