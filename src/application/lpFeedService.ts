// LP pairs feed service: one poll over fetched logs (S-090, K-039,
// K-102). Application service per A-02: it decodes creation events from
// the known factories, resolves the quote side, applies the liquidity
// gate with the same-transaction fast path, holds unfunded pairs in a
// TTL pending queue, dedupes on the candidate key (txHash, logIndex),
// marks `orphaned` on block-hash change, and records quote skips. The
// feed emits only (chainId, tokenAddress, pool, block, tx, logIndex,
// dex) plus blockHash and V4 hooks as operational context; it never
// touches score, probabilities, signals or evidence (K-307). The
// analysis cache stays deduped per (chainId, codehash) with one result
// per address pointing at the shared handoff key.
import {
  FEED_FACTORIES,
  V2_PAIR_CREATED_TOPIC0,
  V3_POOL_CREATED_TOPIC0,
  V4_INITIALIZE_TOPIC0,
  candidateKeyOf,
  decodeV2PairCreated,
  decodeV3PoolCreated,
  decodeV4Initialize,
  enqueuePending,
  gateCreation,
  isFirstLiquidityLog,
  resolveNewToken,
  sweepPending,
} from "../domain/lpFeed.ts";
import type {
  FeedDexId,
  PendingCandidate,
  PoolPointer,
  PoolRef,
  QuoteSet,
} from "../domain/lpFeed.ts";
import type { FeedLog } from "../ports/lpFeed.ts";

// Emitted candidate (K-039): the feed envelope carries no score,
// probabilities, signals or evidence by construction.
export type LpCandidate = {
  readonly chainId: 1;
  readonly tokenAddress: string;
  readonly pool: PoolPointer;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly txHash: string;
  readonly logIndex: number;
  readonly dex: FeedDexId;
  readonly hooks?: string | undefined;
  readonly orphaned: boolean;
};

export type FeedSkip = {
  readonly txHash: string;
  readonly logIndex: number;
  readonly reason: "both-quote" | "neither-quote" | "decode";
};

export type FeedPollInput = {
  readonly logs: readonly FeedLog[];
  readonly quotes: QuoteSet;
  readonly pending: readonly PendingCandidate[];
  readonly seenKeys: ReadonlySet<string>;
  readonly blockHashByKey: ReadonlyMap<string, string>;
  readonly nowMs: number;
  readonly ttlMs: number;
};

export type FeedPollOutput = {
  readonly candidates: readonly LpCandidate[];
  readonly pending: readonly PendingCandidate[];
  readonly expired: readonly PendingCandidate[];
  readonly skipped: readonly FeedSkip[];
  readonly seenKeys: ReadonlySet<string>;
  readonly blockHashByKey: ReadonlyMap<string, string>;
};

type DecodedCreation = {
  readonly dex: FeedDexId;
  readonly token0: string;
  readonly token1: string;
  readonly pool: PoolPointer;
  readonly poolRef: PoolRef;
  readonly hooks?: string | undefined;
  readonly allowNativeZero: boolean;
};

function decodeCreation(log: FeedLog, dex: FeedDexId, kind: string): DecodedCreation | null {
  const topic0 = (log.topics[0] ?? "").toLowerCase();
  if (kind === "v2" && topic0 === V2_PAIR_CREATED_TOPIC0.toLowerCase()) {
    const decoded = decodeV2PairCreated(log);
    if (!decoded.ok) {
      return null;
    }
    const pool: PoolPointer = { kind: "pair", address: decoded.value.pair };
    return {
      dex,
      token0: decoded.value.token0,
      token1: decoded.value.token1,
      pool,
      poolRef: { kind: "pair", address: decoded.value.pair },
      allowNativeZero: false,
    };
  }
  if (kind === "v3" && topic0 === V3_POOL_CREATED_TOPIC0.toLowerCase()) {
    const decoded = decodeV3PoolCreated(log);
    if (!decoded.ok) {
      return null;
    }
    const pool: PoolPointer = { kind: "pair", address: decoded.value.pool };
    return {
      dex,
      token0: decoded.value.token0,
      token1: decoded.value.token1,
      pool,
      poolRef: { kind: "pair", address: decoded.value.pool },
      allowNativeZero: false,
    };
  }
  if (kind === "v4" && topic0 === V4_INITIALIZE_TOPIC0.toLowerCase()) {
    const decoded = decodeV4Initialize(log);
    if (!decoded.ok) {
      return null;
    }
    const pool: PoolPointer = { kind: "poolId", id: decoded.value.poolId };
    return {
      dex,
      token0: decoded.value.currency0,
      token1: decoded.value.currency1,
      pool,
      poolRef: { kind: "poolId", id: decoded.value.poolId },
      hooks: decoded.value.hooks,
      allowNativeZero: true,
    };
  }
  return null;
}

function poolMatchesLiquidity(pool: PoolRef, log: FeedLog): boolean {
  return isFirstLiquidityLog(log, pool);
}

export function processFeedPoll(input: FeedPollInput): FeedPollOutput {
  const factoryByAddress = new Map<string, { dex: FeedDexId; kind: string }>();
  for (const factory of FEED_FACTORIES) {
    if (factory.enabledByDefault) {
      factoryByAddress.set(factory.address.toLowerCase(), { dex: factory.dex, kind: factory.kind });
    }
  }
  const hints = input.logs.map((log) => ({ log, poolAddress: log.address }));
  const seenKeys = new Set<string>(input.seenKeys);
  const blockHashByKey = new Map<string, string>(input.blockHashByKey);
  const candidates: LpCandidate[] = [];
  const skipped: FeedSkip[] = [];
  let pending: readonly PendingCandidate[] = input.pending.slice();

  const emit = (entry: {
    tokenAddress: string;
    pool: PoolPointer;
    blockNumber: number;
    blockHash: string;
    txHash: string;
    logIndex: number;
    dex: FeedDexId;
    hooks?: string | undefined;
  }): void => {
    const key = candidateKeyOf(entry.txHash, entry.logIndex);
    if (seenKeys.has(key)) {
      return;
    }
    seenKeys.add(key);
    const stored = blockHashByKey.get(key);
    const orphaned = stored !== undefined && stored !== entry.blockHash;
    blockHashByKey.set(key, entry.blockHash);
    const candidate: LpCandidate = {
      chainId: 1,
      tokenAddress: entry.tokenAddress,
      pool: entry.pool,
      blockNumber: entry.blockNumber,
      blockHash: entry.blockHash,
      txHash: entry.txHash.toLowerCase(),
      logIndex: entry.logIndex,
      dex: entry.dex,
      orphaned,
      ...(entry.hooks === undefined ? {} : { hooks: entry.hooks }),
    };
    candidates.push(candidate);
  };

  for (const log of input.logs) {
    const factory = factoryByAddress.get(log.address.toLowerCase());
    if (factory === undefined) {
      continue;
    }
    const created = decodeCreation(log, factory.dex, factory.kind);
    if (created === null) {
      continue;
    }
    const resolved = resolveNewToken(created.token0, created.token1, {
      ...input.quotes,
      allowNativeZero: created.allowNativeZero,
    });
    if (resolved.kind === "skipped") {
      skipped.push({ txHash: log.txHash.toLowerCase(), logIndex: log.logIndex, reason: resolved.reason });
      continue;
    }
    const gate = gateCreation(created.poolRef, hints, log.txHash);
    if (gate === "ready") {
      emit({
        tokenAddress: resolved.tokenAddress,
        pool: created.pool,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        txHash: log.txHash,
        logIndex: log.logIndex,
        dex: created.dex,
        hooks: created.hooks,
      });
    } else {
      pending = enqueuePending(
        pending,
        {
          chainId: 1,
          tokenAddress: resolved.tokenAddress,
          pool: created.pool,
          blockNumber: log.blockNumber,
          blockHash: log.blockHash,
          txHash: log.txHash.toLowerCase(),
          logIndex: log.logIndex,
          dex: created.dex,
          hooks: created.hooks,
        },
        input.nowMs,
        input.ttlMs,
      );
    }
  }

  // Later polls promote held candidates once first liquidity appears.
  const stillPending: PendingCandidate[] = [];
  for (const held of pending) {
    const poolRef: PoolRef =
      held.pool.kind === "pair" ? { kind: "pair", address: held.pool.address } : { kind: "poolId", id: held.pool.id };
    const funded = input.logs.some((log) => poolMatchesLiquidity(poolRef, log));
    if (funded) {
      emit({
        tokenAddress: held.tokenAddress,
        pool: held.pool,
        blockNumber: held.blockNumber,
        blockHash: held.blockHash,
        txHash: held.txHash,
        logIndex: held.logIndex,
        dex: held.dex,
        hooks: held.hooks,
      });
    } else {
      stillPending.push(held);
    }
  }
  const swept = sweepPending(stillPending, input.nowMs, input.ttlMs);

  return {
    candidates: Object.freeze(candidates),
    pending: swept.active,
    expired: swept.expired,
    skipped: Object.freeze(skipped),
    seenKeys,
    blockHashByKey,
  };
}

// Analysis handoff key (S-090): deduped per (chainId, codehash) with one
// result per address pointing at it. Non-mainnet chain ids are turned
// away with a typed error (S-091).
export function analysisHandoffKey(
  chainId: number,
  codehash: string,
): { ok: true; value: string } | { ok: false; error: { kind: "invalid-chain"; message: string } } {
  if (chainId !== 1) {
    return { ok: false, error: { kind: "invalid-chain", message: "the feed runs on Ethereum mainnet only" } };
  }
  if (codehash.length === 0) {
    return { ok: false, error: { kind: "invalid-chain", message: "codehash must not be empty" } };
  }
  return { ok: true, value: `feed-analysis|${chainId}|${codehash.toLowerCase()}` };
}

// One result per address pointing at the shared handoff key: the first
// address wins its slot and every address resolves to the same key, so
// repeated candidates with one codehash share one analysis entry.
export function noteAnalysisAddress(pointers: Map<string, string>, address: string, key: string): void {
  const slot = address.toLowerCase();
  if (!pointers.has(slot)) {
    pointers.set(slot, key);
  }
}
