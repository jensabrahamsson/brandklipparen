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
  LP_FEED_REORG_WINDOW_BLOCKS,
  V2_MINT_TOPIC0,
  V2_PAIR_CREATED_TOPIC0,
  V2_SYNC_TOPIC0,
  V3_MINT_TOPIC0,
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
import type { FeedCallContext, FeedLog, LpFeedError, LpFeedPort } from "../ports/lpFeed.ts";
import { err, ok } from "../domain/result.ts";
import type { Result } from "../domain/result.ts";

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

  type EmitEntry = {
    tokenAddress: string;
    pool: PoolPointer;
    blockNumber: number;
    blockHash: string;
    txHash: string;
    logIndex: number;
    dex: FeedDexId;
    hooks?: string | undefined;
  };
  const pushCandidate = (entry: EmitEntry, orphaned: boolean): void => {
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
  const emit = (entry: EmitEntry, orphanedOverride?: boolean | undefined): void => {
    const key = candidateKeyOf(entry.txHash, entry.logIndex);
    const stored = blockHashByKey.get(key);
    const changed = stored !== undefined && stored !== entry.blockHash;
    if (seenKeys.has(key)) {
      // A known key whose block hash changed was reorged: re-emit it as an
      // orphaned update so the caller can mark the earlier candidate,
      // instead of dropping it silently behind the seen check.
      if (changed) {
        blockHashByKey.set(key, entry.blockHash);
        pushCandidate(entry, true);
      }
      return;
    }
    seenKeys.add(key);
    blockHashByKey.set(key, entry.blockHash);
    pushCandidate(entry, orphanedOverride ?? changed);
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
  // Held creations inside the re-read window whose transaction no longer
  // appears in the fetched logs were reorged away: emit them once as
  // orphaned instead of letting them wait out their TTL.
  const maxObservedBlock = input.logs.reduce(
    (max, log) => Math.max(max, log.blockNumber),
    Number.NEGATIVE_INFINITY,
  );
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
      const inWindow =
        held.blockNumber <= maxObservedBlock &&
        held.blockNumber >= maxObservedBlock - LP_FEED_REORG_WINDOW_BLOCKS;
      const creationGone =
        inWindow &&
        !input.logs.some((log) => log.txHash.toLowerCase() === held.txHash.toLowerCase());
      if (creationGone) {
        emit(
          {
            tokenAddress: held.tokenAddress,
            pool: held.pool,
            blockNumber: held.blockNumber,
            blockHash: held.blockHash,
            txHash: held.txHash,
            logIndex: held.logIndex,
            dex: held.dex,
            hooks: held.hooks,
          },
          true,
        );
      } else {
        stillPending.push(held);
      }
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

// Liquidity topic0 values for the pair/pool retrieval (S-103): V2 Mint or Sync
// on the pair and V3 Mint on the pool. The address poll returns every log
// for the pair, so the fetch keeps solely these topic0 values and drops
// transfers, approvals and unrelated events before gating.
const LIQUIDITY_TOPIC0S: ReadonlySet<string> = Object.freeze(
  new Set(
    [V2_MINT_TOPIC0, V2_SYNC_TOPIC0, V3_MINT_TOPIC0].map((topic) => topic.toLowerCase()),
  ),
);

// Default cap on pair-address polls per cycle (S-103): one factory poll
// plus at most this many pair polls, so a creation burst cannot exhaust
// the free-tier daily budget in one cycle.
export const DEFAULT_MAX_PAIR_POLLS_PER_CYCLE = 25;

// Pair addresses decoded from creation logs (S-103): V2 pair and V3 pool
// addresses are pollable log addresses, while V4 pool ids are not, so
// only V2/V3 creations contribute fetch targets.
function pairAddressesOfCreations(logs: readonly FeedLog[]): readonly string[] {
  const addresses: string[] = [];
  const seen = new Set<string>();
  for (const log of logs) {
    const v2 = decodeV2PairCreated(log);
    if (v2.ok) {
      const address = v2.value.pair.toLowerCase();
      if (!seen.has(address)) {
        seen.add(address);
        addresses.push(address);
      }
      continue;
    }
    const v3 = decodeV3PoolCreated(log);
    if (v3.ok) {
      const address = v3.value.pool.toLowerCase();
      if (!seen.has(address)) {
        seen.add(address);
        addresses.push(address);
      }
    }
  }
  return Object.freeze(addresses);
}

// Liquidity fetch for fresh pair addresses (S-103): one port poll per new
// pair or pool address over the same block range, keeping solely
// Mint/Sync topic0 logs. A failed pair poll is recorded and skipped, so
// one quiet or erroring pair never blocks the rest of the cycle; a failed
// factory poll fails the cycle with the typed port error instead.
export async function fetchLiquidityLogs(
  feed: LpFeedPort,
  pairs: readonly string[],
  fromBlock: number,
  toBlock: number,
  ctx: FeedCallContext,
): Promise<{ readonly logs: readonly FeedLog[]; readonly failed: readonly string[] }> {
  const logs: FeedLog[] = [];
  const failed: string[] = [];
  for (const pair of pairs) {
    const polled = await feed.pollLogs({ factory: pair, fromBlock, toBlock }, ctx);
    if (!polled.ok) {
      failed.push(pair);
      continue;
    }
    for (const log of polled.value.logs) {
      if (LIQUIDITY_TOPIC0S.has((log.topics[0] ?? "").toLowerCase())) {
        logs.push(log);
      }
    }
  }
  return Object.freeze({ logs: Object.freeze(logs), failed: Object.freeze(failed) });
}

export type FeedCycleInput = {
  readonly feed: LpFeedPort;
  readonly factories: readonly string[];
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly ctx: FeedCallContext;
  readonly quotes: QuoteSet;
  readonly pending: readonly PendingCandidate[];
  readonly seenKeys: ReadonlySet<string>;
  readonly blockHashByKey: ReadonlyMap<string, string>;
  readonly nowMs: number;
  readonly ttlMs: number;
  readonly maxPairPolls?: number | undefined;
};

export type FeedCycleOutput = {
  readonly output: FeedPollOutput;
  readonly failedPairs: readonly string[];
  // Block cursor for the persisted feed state (S-103): the caller stores
  // this beside the pending queue and resumes the next poll from it.
  readonly cursorBlock: number;
};

// Composed feed poll with the liquidity retrieval (S-103, K-039): factory
// polls first, then Mint/Sync polls for the decoded V2/V3 pair addresses
// over the same range, then the shared gate over the combined logs, so a
// same-transaction funded creation promotes immediately instead of
// waiting in the pending queue for a later poll.
export async function pollFeedWithLiquidity(
  input: FeedCycleInput,
): Promise<Result<FeedCycleOutput, LpFeedError>> {
  const creationLogs: FeedLog[] = [];
  let coveredToBlock = input.toBlock;
  for (const factory of input.factories) {
    const polled = await input.feed.pollLogs(
      { factory, fromBlock: input.fromBlock, toBlock: input.toBlock },
      input.ctx,
    );
    if (!polled.ok) {
      return err(polled.error);
    }
    creationLogs.push(...polled.value.logs);
    coveredToBlock = Math.min(coveredToBlock, polled.value.coveredToBlock);
  }
  const pairs = pairAddressesOfCreations(creationLogs).slice(
    0,
    input.maxPairPolls ?? DEFAULT_MAX_PAIR_POLLS_PER_CYCLE,
  );
  const fetched = await fetchLiquidityLogs(
    input.feed,
    pairs,
    input.fromBlock,
    input.toBlock,
    input.ctx,
  );
  const output = processFeedPoll({
    logs: [...creationLogs, ...fetched.logs],
    quotes: input.quotes,
    pending: input.pending,
    seenKeys: input.seenKeys,
    blockHashByKey: input.blockHashByKey,
    nowMs: input.nowMs,
    ttlMs: input.ttlMs,
  });
  return ok(
    Object.freeze({
      output,
      failedPairs: fetched.failed,
      cursorBlock: coveredToBlock,
    }),
  );
}
