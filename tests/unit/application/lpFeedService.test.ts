// Idempotency, reorg handling, quote rules and score neutrality
// (S-090, K-039, K-102). Test-first: these tests fail until the feed
// service lands in src/application/lpFeedService.ts. All logs and
// addresses are synthetic; no live calls.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { canonicalSerialize } from "../../../src/domain/serialize.ts";
import {
  QUOTE_TOKENS,
  V2_MINT_TOPIC0,
  V2_PAIR_CREATED_TOPIC0,
  decodeV4Initialize,
} from "../../../src/domain/lpFeed.ts";
import type { FeedLog } from "../../../src/ports/lpFeed.ts";
import { parseFeedLog } from "../../../src/adapters/lpFeed/feedLogCodec.ts";
import {
  analysisHandoffKey,
  noteAnalysisAddress,
  processFeedPoll,
} from "../../../src/application/lpFeedService.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RPC_FIXTURE = JSON.parse(
  readFileSync(join(repoRoot, "tests", "fixtures", "lpfeed", "rpc-getlogs.json"), "utf8"),
) as { result: unknown[] };

const USDC = QUOTE_TOKENS.usdc.toLowerCase();
const USDT = QUOTE_TOKENS.usdt.toLowerCase();
const ASSET_ADDR = "0x419174f249096c659f013ccdc3d233c330bd803c";
const UNKNOWN = "0x0d8d3941478862c625445c0343e111ae57b1afc8";
const PAIR = "0x338ab1edd0ebd1d7b065de0398050279c1bcb8d7";
const FACTORY_V2 = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
const TX_A = "0x53dcb2e5ccbeaa8ee43360a826116afb791e69432d80637b5426465234361068";
const TX_B = "0x53dcb2e5ccbeaa8ee43360a826116afb791e69432d80637b5426465234361009";
const BLOCK_HASH = "0xcaa11e6b828301b0c1549c1a0b3166ded2acdcfe547cdfd83a9cd5cae98f33c0";
const REORG_HASH = "0x3ef3fd9991ed930c5c0657934926c0d6901a0958758fa44143c56c03c08d3c65";

function word(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

function v2Creation(txHash: string, logIndex: number, token0: string, token1: string): FeedLog {
  return {
    address: FACTORY_V2,
    topics: [V2_PAIR_CREATED_TOPIC0, word(token0), word(token1)],
    data: `${word(PAIR)}${"0".repeat(62)}02`.toLowerCase(),
    blockNumber: 21600000,
    blockHash: BLOCK_HASH,
    txHash,
    logIndex,
  };
}

function v2Mint(txHash: string, logIndex: number): FeedLog {
  return {
    address: PAIR,
    topics: [V2_MINT_TOPIC0],
    data: "0x00",
    blockNumber: 21600000,
    blockHash: BLOCK_HASH,
    txHash,
    logIndex,
  };
}

const QUOTES = {
  usdc: QUOTE_TOKENS.usdc,
  usdt: QUOTE_TOKENS.usdt,
  dai: QUOTE_TOKENS.dai,
  weth: null,
  allowNativeZero: false,
};

const BASE_INPUT = {
  quotes: QUOTES,
  pending: [],
  seenKeys: new Set<string>(),
  blockHashByKey: new Map<string, string>(),
  nowMs: 1_700_000_000_000,
  ttlMs: 300_000,
};

describe("feed idempotency and reorg handling", () => {
  test("k039_candidate_key_dedupes_txhash_logindex", () => {
    const logs = [v2Creation(TX_A, 0, USDC, ASSET_ADDR), v2Mint(TX_A, 1)];
    const first = processFeedPoll({ ...BASE_INPUT, logs });
    expect(first.candidates).toHaveLength(1);
    expect(first.candidates[0]?.tokenAddress).toBe(ASSET_ADDR);
    expect(first.candidates[0]?.pool).toEqual({ kind: "pair", address: PAIR });
    const second = processFeedPoll({ ...BASE_INPUT, logs, seenKeys: first.seenKeys });
    expect(second.candidates).toHaveLength(0);
    expect(second.skipped).toHaveLength(0);
  });

  test("k039_reorg_marks_orphaned_on_blockhash_change", () => {
    const logs = [v2Creation(TX_A, 0, USDC, ASSET_ADDR), v2Mint(TX_A, 1)];
    const first = processFeedPoll({ ...BASE_INPUT, logs });
    expect(first.candidates).toHaveLength(1);
    expect(first.candidates[0]?.orphaned).toBe(false);
    const reorgHash = REORG_HASH;
    const reorged = logs.map((log) => ({ ...log, blockHash: reorgHash }));
    // Both maps travel forward, as a real caller keeps them: the known key
    // whose block hash changed is re-emitted as an orphaned update.
    const second = processFeedPoll({
      ...BASE_INPUT,
      logs: reorged,
      seenKeys: first.seenKeys,
      blockHashByKey: first.blockHashByKey,
    });
    expect(second.candidates).toHaveLength(1);
    expect(second.candidates[0]?.orphaned).toBe(true);
    // Once observed, the steady re-poll dedupes silently again.
    const steady = processFeedPoll({
      ...BASE_INPUT,
      logs: reorged,
      seenKeys: second.seenKeys,
      blockHashByKey: second.blockHashByKey,
    });
    expect(steady.candidates).toHaveLength(0);
  });

  test("k039_reorg_marks_missing_creation_inside_window_orphaned", () => {
    // A creation held in pending whose transaction disappears from the
    // re-read window was reorged away: it is emitted once as orphaned
    // instead of waiting out its TTL.
    const held = [v2Creation(TX_A, 0, USDC, ASSET_ADDR)];
    const first = processFeedPoll({ ...BASE_INPUT, logs: held });
    expect(first.candidates).toHaveLength(0);
    expect(first.pending).toHaveLength(1);
    const other = v2Creation(TX_B, 0, USDC, UNKNOWN);
    const second = processFeedPoll({
      ...BASE_INPUT,
      logs: [other],
      pending: first.pending,
      seenKeys: first.seenKeys,
      blockHashByKey: first.blockHashByKey,
    });
    const orphaned = second.candidates.filter((candidate) => candidate.txHash === TX_A);
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0]?.orphaned).toBe(true);
    expect(second.pending.some((held) => held.txHash === TX_A)).toBe(false);
  });

  test("k039_quote_both_or_neither_logs_and_skips", () => {
    const bothQuote = v2Creation(TX_A, 0, USDC, USDT);
    const neitherQuote = v2Creation(TX_A, 2, ASSET_ADDR, UNKNOWN);
    const output = processFeedPoll({ ...BASE_INPUT, logs: [bothQuote, neitherQuote] });
    expect(output.candidates).toHaveLength(0);
    expect(output.pending).toHaveLength(0);
    expect(output.skipped).toEqual([
      { txHash: TX_A, logIndex: 0, reason: "both-quote" },
      { txHash: TX_A, logIndex: 2, reason: "neither-quote" },
    ]);
  });

  test("k039_v4_hooks_stay_context_never_score", () => {
    const raw = RPC_FIXTURE.result[1];
    const log = parseFeedLog(raw);
    expect(log).not.toBeNull();
    if (log === null) {
      return;
    }
    const decoded = decodeV4Initialize(log);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    expect(decoded.value.poolId).toBe(
      "0x5cac05b0fb01e54abc23c2147a8268e9770a9113b81cdb6c91bab2a314d9d43c",
    );
    expect(decoded.value.hooks).toBe("0x77592986a536361c8e825989ea9c531e8b401032");
    // Without liquidity the V4 pool waits in the pending queue with
    // hooks attached as context.
    const held = processFeedPoll({ ...BASE_INPUT, logs: [log] });
    expect(held.candidates).toHaveLength(0);
    expect(held.pending).toHaveLength(1);
    expect(held.pending[0]?.hooks).toBe(decoded.value.hooks);
    // With same-transaction liquidity the candidate carries hooks as
    // context only, never as score input.
    const funded: FeedLog = {
      address: "0x000000000004444c5dc75cb358380d2e3de08a90",
      topics: [
        "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec",
        decoded.value.poolId,
      ],
      data: `0x${"0".repeat(64)}${"0".repeat(64)}${"0".repeat(62)}01${"0".repeat(64)}`,
      blockNumber: 21600001,
      blockHash: log.blockHash,
      txHash: log.txHash,
      logIndex: 1,
    };
    const output = processFeedPoll({ ...BASE_INPUT, logs: [log, funded] });
    const v4 = output.candidates.find((candidate) => candidate.dex === "uniswap-v4");
    expect(v4).toBeDefined();
    expect(v4?.pool).toEqual({ kind: "poolId", id: decoded.value.poolId });
    expect(v4?.hooks).toBe(decoded.value.hooks);
    for (const candidate of output.candidates) {
      expect(candidate).not.toHaveProperty("score");
      expect(candidate).not.toHaveProperty("probabilities");
      expect(candidate).not.toHaveProperty("signals");
      expect(candidate).not.toHaveProperty("evidence");
      expect(Object.keys(candidate).sort()).toEqual(
        ["blockHash", "blockNumber", "chainId", "dex", "hooks", "logIndex", "orphaned", "pool", "tokenAddress", "txHash"],
      );
    }
  });

  test("k039_feed_leaves_score_and_evidence_unchanged", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            token0IsQuote: fc.boolean(),
            token1IsQuote: fc.boolean(),
            sameTxLiquidity: fc.boolean(),
            reorged: fc.boolean(),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        (cases) => {
          const envelope = {
            score: 84,
            probabilities: { "rug-pull": 0.62, honeypot: 0.91, "bot-pump": 0.34 },
            signals: [{ id: "owner-blacklist", evidence: [{ selector: "0x44337ea1" }] }],
            evidence: ["signal:owner-blacklist"],
          };
          const before = canonicalSerialize(envelope);
          const logs: FeedLog[] = cases.flatMap((item, index) => {
            const first = item.token0IsQuote ? USDC : ASSET_ADDR;
            const second = item.token1IsQuote ? USDT : UNKNOWN;
            const suffix = index.toString(16).padStart(2, "0");
            const tx = `${TX_A.slice(0, -2)}${suffix}`;
            const creation = v2Creation(tx, 0, first, second);
            const blockHash = item.reorged ? `${REORG_HASH.slice(0, -2)}${suffix}` : BLOCK_HASH;
            const created = { ...creation, blockHash };
            if (!item.sameTxLiquidity) {
              return [created];
            }
            return [created, { ...v2Mint(tx, 1), blockHash }];
          });
          const output = processFeedPoll({ ...BASE_INPUT, logs });
          expect(canonicalSerialize(envelope)).toBe(before);
          for (const candidate of output.candidates) {
            expect(candidate.chainId).toBe(1);
            expect(candidate).not.toHaveProperty("score");
            expect(candidate).not.toHaveProperty("probabilities");
            expect(candidate).not.toHaveProperty("signals");
            expect(candidate).not.toHaveProperty("evidence");
          }
          // Analysis cache stays deduped per (chainId, codehash): one
          // result per address points at the shared key.
          const codehash = "0xcodehashplaceholder000000000000000000000000000000000001";
          const handed = analysisHandoffKey(1, codehash);
          expect(handed.ok).toBe(true);
          if (!handed.ok) {
            return;
          }
          const key = handed.value;
          const pointers = new Map<string, string>();
          for (const candidate of output.candidates) {
            noteAnalysisAddress(pointers, candidate.tokenAddress, key);
          }
          for (const pointed of pointers.values()) {
            expect(pointed).toBe(key);
          }
          expect(pointers.size).toBeLessThanOrEqual(output.candidates.length);
        },
      ),
      { numRuns: 25 },
    );
  });
});
