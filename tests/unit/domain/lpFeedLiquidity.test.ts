// Liquidity gate with same-transaction fast path and pending queue
// (S-089, K-039). Test-first: these tests fail until the decoders and
// the gate land in src/domain/lpFeed.ts. All addresses and hashes are
// synthetic; no live calls.
import { describe, expect, test } from "vitest";
import type { FeedLog } from "../../../src/ports/lpFeed.ts";
import {
  V2_MINT_TOPIC0,
  V2_PAIR_CREATED_TOPIC0,
  V2_SYNC_TOPIC0,
  V3_MINT_TOPIC0,
  V3_POOL_CREATED_TOPIC0,
  V4_INITIALIZE_TOPIC0,
  V4_MODIFY_LIQUIDITY_TOPIC0,
  decodeV2PairCreated,
  decodeV3PoolCreated,
  decodeV4Initialize,
  enqueuePending,
  gateCreation,
  isFirstLiquidityLog,
  sweepPending,
} from "../../../src/domain/lpFeed.ts";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const ASSET_ADDR = "0x419174f249096c659f013ccdc3d233c330bd803c";
const PAIR = "0x338ab1edd0ebd1d7b065de0398050279c1bcb8d7";
const FACTORY_V2 = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
const TX_A = "0x53dcb2e5ccbeaa8ee43360a826116afb791e69432d80637b5426465234361068";
const BLOCK_HASH = "0xcaa11e6b828301b0c1549c1a0b3166ded2acdcfe547cdfd83a9cd5cae98f33c0";

function word(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

function pairCreatedLog(txHash: string, logIndex: number): FeedLog {
  return {
    address: FACTORY_V2,
    topics: [V2_PAIR_CREATED_TOPIC0, word(USDC), word(ASSET_ADDR)],
    data: `${word(PAIR)}${"0".repeat(62)}02`.toLowerCase(),
    blockNumber: 21600000,
    blockHash: BLOCK_HASH,
    txHash,
    logIndex,
  };
}

function mintLog(txHash: string, logIndex: number): FeedLog {
  return {
    address: PAIR,
    topics: [V2_MINT_TOPIC0],
    data: "0xdeadbeef",
    blockNumber: 21600000,
    blockHash: BLOCK_HASH,
    txHash,
    logIndex,
  };
}

describe("liquidity gate", () => {
  test("k039_liquidity_gate_hands_to_analysis_only_after_first_liquidity", () => {
    const decoded = decodeV2PairCreated(pairCreatedLog(TX_A, 0));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    expect(decoded.value.token0).toBe(USDC.toLowerCase());
    expect(decoded.value.token1).toBe(ASSET_ADDR.toLowerCase());
    expect(decoded.value.pair).toBe(PAIR.toLowerCase());
    // No liquidity anywhere near this transaction: the gate holds.
    const gate = gateCreation(
      { kind: "pair", address: PAIR.toLowerCase() },
      [{ log: mintLog("0x07d83539997af0b620147b78fe38d8926def3dd49ae49c99fd4bc498f1fa43f4", 4), poolAddress: PAIR.toLowerCase() }],
      TX_A,
    );
    expect(gate).toBe("pending");
  });

  test("k039_same_tx_pair_plus_liquidity_passes_immediately", () => {
    const pairRef = { kind: "pair", address: PAIR.toLowerCase() } as const;
    // V2 Mint in the same transaction as the creation (the addLiquidityETH case).
    expect(gateCreation(pairRef, [{ log: mintLog(TX_A, 1), poolAddress: PAIR.toLowerCase() }], TX_A)).toBe("ready");
    // V2 Sync on the pair also counts as first liquidity.
    const sync: FeedLog = { ...mintLog(TX_A, 1), topics: [V2_SYNC_TOPIC0] };
    expect(gateCreation(pairRef, [{ log: sync, poolAddress: PAIR.toLowerCase() }], TX_A)).toBe("ready");
    // V3 pool Mint on the pool address.
    const v3Mint: FeedLog = { ...mintLog(TX_A, 2), topics: [V3_MINT_TOPIC0] };
    expect(isFirstLiquidityLog(v3Mint, pairRef)).toBe(true);
    // V3 Mint on another address is not this pool's liquidity.
    const elsewhere: FeedLog = {
      ...v3Mint,
      address: "0xa360215ae2d6a2d6a64cf157405e2642ce82430a",
    };
    expect(isFirstLiquidityLog(elsewhere, pairRef)).toBe(false);
    // V4 ModifyLiquidity with delta above zero filtered on topic1 equal to the pool id.
    const poolId = "0x5cac05b0fb01e54abc23c2147a8268e9770a9113b81cdb6c91bab2a314d9d43c";
    const manager = "0x000000000004444c5dc75cb358380d2e3de08a90";
    const positiveDelta = `0x${"0".repeat(62)}01`;
    const funded: FeedLog = {
      address: manager,
      topics: [V4_MODIFY_LIQUIDITY_TOPIC0, poolId, word(ASSET_ADDR)],
      data: `0x${"0".repeat(64)}${"0".repeat(64)}${positiveDelta.slice(2)}${"0".repeat(64)}`,
      blockNumber: 21600001,
      blockHash: BLOCK_HASH,
      txHash: TX_A,
      logIndex: 3,
    };
    expect(isFirstLiquidityLog(funded, { kind: "poolId", id: poolId })).toBe(true);
    // Zero delta is not liquidity.
    const zeroDelta: FeedLog = {
      ...funded,
      data: `0x${"0".repeat(64)}${"0".repeat(64)}${"0".repeat(64)}${"0".repeat(64)}`,
    };
    expect(isFirstLiquidityLog(zeroDelta, { kind: "poolId", id: poolId })).toBe(false);
    // Another pool id is not this pool's liquidity.
    const otherPool: FeedLog = {
      ...funded,
      topics: [
        V4_MODIFY_LIQUIDITY_TOPIC0,
        "0x4baf977baa817ce3e8df2383f5096dc635213ef75050dea19595e862971c4638",
        word(ASSET_ADDR),
      ],
    };
    expect(isFirstLiquidityLog(otherPool, { kind: "poolId", id: poolId })).toBe(false);
  });

  test("k039_pending_queue_expires_after_ttl", () => {
    const candidate = {
      chainId: 1 as const,
      tokenAddress: ASSET_ADDR.toLowerCase(),
      pool: { kind: "pair", address: PAIR.toLowerCase() } as const,
      blockNumber: 21600000,
      blockHash: BLOCK_HASH,
      txHash: TX_A,
      logIndex: 0,
      dex: "uniswap-v2" as const,
    };
    const queued = enqueuePending([], candidate, 1_700_000_000_000, 300_000);
    expect(queued).toHaveLength(1);
    expect(sweepPending(queued, 1_700_000_100_000, 300_000).active).toHaveLength(1);
    const swept = sweepPending(queued, 1_700_000_300_001, 300_000);
    expect(swept.active).toHaveLength(0);
    expect(swept.expired).toHaveLength(1);
    expect(decodeV3PoolCreated).toBeDefined();
    expect(decodeV4Initialize).toBeDefined();
    expect(V3_POOL_CREATED_TOPIC0.startsWith("0x")).toBe(true);
    expect(V4_INITIALIZE_TOPIC0.startsWith("0x")).toBe(true);
  });
});
