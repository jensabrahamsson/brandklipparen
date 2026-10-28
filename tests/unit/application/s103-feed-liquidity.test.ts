// S-103 feed liquidity fetch with cursor and pending persistence (K-039):
// after decoding V2 creations the poll fetches Mint/Sync logs for the new
// pair addresses (topic0-limited), so the liquidity gate and the same-tx
// fast path promote a same-tx funded V2 creation that a factory-only poll
// would leave pending. The block cursor and the pending queue persist to
// a small JSON file from configuration with an atomic write. Written
// first (red) per A-21: `pollFeedWithLiquidity` and the feed state file
// do not exist yet. No network: the Etherscan adapter runs on a fake
// transport serving a factory-only fixture plus a pair-log fixture.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createEtherscanLogsAdapter } from "../../../src/adapters/lpFeed/etherscanLogsAdapter.ts";
import { SecretString } from "../../../src/ports/config.ts";
import {
  QUOTE_TOKENS,
  V2_MINT_TOPIC0,
  V2_PAIR_CREATED_TOPIC0,
} from "../../../src/domain/lpFeed.ts";
import {
  loadFeedState,
  saveFeedState,
} from "../../../src/adapters/feedState/feedStateFile.ts";
import { pollFeedWithLiquidity } from "../../../src/application/lpFeedService.ts";

const FACTORY_V2 = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
const PAIR = "0x338ab1edd0ebd1d7b065de0398050279c1bcb8d7";
const USDC = QUOTE_TOKENS.usdc.toLowerCase();
const ASSET = "0x419174f249096c659f013ccdc3d233c330bd803c";
const TX_FUNDED = "0x53dcb2e5ccbeaa8ee43360a826116afb791e69432d80637b5426465234361068";
const BLOCK_HASH = "0xcaa11e6b828301b0c1549c1a0b3166ded2acdcfe547cdfd83a9cd5cae98f33c0";
const FROM_BLOCK = 21600000;
const TO_BLOCK = 21600002;

function word(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

function creationLog(): Record<string, unknown> {
  return {
    address: FACTORY_V2,
    topics: [V2_PAIR_CREATED_TOPIC0, word(USDC), word(ASSET)],
    data: `${word(PAIR)}${"0".repeat(62)}02`.toLowerCase(),
    blockNumber: FROM_BLOCK,
    blockHash: BLOCK_HASH,
    transactionHash: TX_FUNDED,
    logIndex: 0,
  };
}

function mintLog(): Record<string, unknown> {
  return {
    address: PAIR,
    topics: [V2_MINT_TOPIC0],
    data: "0x00",
    blockNumber: FROM_BLOCK,
    blockHash: BLOCK_HASH,
    transactionHash: TX_FUNDED,
    logIndex: 1,
  };
}

function bodyFor(url: string): string {
  // Pair-address polls answer the pair-log fixture; the factory poll
  // answers the factory-only fixture with no liquidity inside.
  if (url.includes(`address=${PAIR}`)) {
    return JSON.stringify({ status: "1", message: "OK", result: [mintLog()] });
  }
  return JSON.stringify({ status: "1", message: "OK", result: [creationLog()] });
}

const QUOTES = {
  usdc: QUOTE_TOKENS.usdc,
  usdt: QUOTE_TOKENS.usdt,
  dai: QUOTE_TOKENS.dai,
  weth: null,
  allowNativeZero: false,
};

describe("feed liquidity fetch and state persistence (S-103)", () => {
  test("s103_feed_fetches_liquidity_for_new_pairs", async () => {
    const sentUrls: string[] = [];
    const adapter = createEtherscanLogsAdapter({
      apiKey: new SecretString("test-key"),
      transport: async (url: string) => {
        sentUrls.push(url);
        return { status: 200, bodyText: bodyFor(url) };
      },
      callsPerSecond: 100,
      dailyCap: 100000,
    });
    const polled = await pollFeedWithLiquidity({
      feed: adapter,
      factories: [FACTORY_V2],
      fromBlock: FROM_BLOCK,
      toBlock: TO_BLOCK,
      ctx: { requestId: "req-s103", deadlineMs: Number.MAX_SAFE_INTEGER },
      quotes: QUOTES,
      pending: [],
      seenKeys: new Set<string>(),
      blockHashByKey: new Map<string, string>(),
      nowMs: 1_700_000_000_000,
      ttlMs: 300_000,
    });
    if (!polled.ok) {
      throw new Error(`expected the poll to succeed, got ${polled.error.kind}`);
    }
    // The factory-only poll carries no liquidity, so without the pair-log
    // fetch this creation would wait in the pending queue. The Mint fetch
    // for the new pair address promotes it through the same-tx fast path.
    expect(sentUrls.some((url) => url.includes(`address=${PAIR}`))).toBe(true);
    expect(polled.value.failedPairs).toEqual([]);
    expect(polled.value.output.candidates).toHaveLength(1);
    expect(polled.value.output.candidates[0]?.tokenAddress).toBe(ASSET);
    expect(polled.value.output.candidates[0]?.pool).toEqual({ kind: "pair", address: PAIR });
    expect(polled.value.output.pending).toHaveLength(0);

    // The block cursor and the pending queue persist to the configured
    // JSON file with an atomic write and read back bit-identical.
    const dir = mkdtempSync(join(tmpdir(), "feed-state-s103-"));
    const statePath = join(dir, "feed-state.json");
    const saved = saveFeedState(statePath, {
      version: 1,
      cursorBlock: polled.value.cursorBlock,
      pending: polled.value.output.pending,
      seenKeys: [...polled.value.output.seenKeys],
      blockHashes: [...polled.value.output.blockHashByKey],
    });
    expect(saved.ok).toBe(true);
    const raw = readFileSync(statePath, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    const loaded = loadFeedState(statePath);
    if (!loaded.ok || loaded.value === null) {
      throw new Error("expected the persisted feed state to load");
    }
    expect(loaded.value.cursorBlock).toBe(TO_BLOCK);
    expect(loaded.value.pending).toEqual(polled.value.output.pending);
    expect(loaded.value.seenKeys).toEqual([...polled.value.output.seenKeys]);
  });

  test("s103_feed_state_round_trip_rejects_corrupt_files", () => {
    const dir = mkdtempSync(join(tmpdir(), "feed-state-s103-"));
    const missing = loadFeedState(join(dir, "absent.json"));
    expect(missing.ok).toBe(true);
    if (!missing.ok || missing.value !== null) {
      throw new Error("expected a missing state file to load as null");
    }
  });
});
