// Live new-tokens application service (E-11 follow-up). Polls the LP
// feed politely, keeps the newest-first list and runs the bounded
// deterministic analysis queue. Started only by the REST/demo runtime
// (never by tests or CLI one-shots) and stops cleanly on demand.
//
// Budget: one cycle per LIVE_TOKENS_POLL_INTERVAL_MS (15 s) is 5,760
// cycles/day. Each cycle costs two factory polls plus at most
// maxPairPollsPerCycle pair-address polls and one latest-block read,
// so a quiet day costs about 17k Etherscan calls and a busy one stays
// under ~63k — far below the 100k/day free cap, with the adapter token
// bucket and the backoff here absorbing bursts and 429 answers.
import {
  decodeV2PairCreated,
  decodeV3PoolCreated,
  resolveNewToken,
} from "../domain/lpFeed.ts";
import type { FeedDexId, FeedFactory, QuoteSet } from "../domain/lpFeed.ts";
import {
  LIVE_TOKENS_BACKOFF_BASE_MS,
  LIVE_TOKENS_LOOKBACK_BLOCKS,
  LIVE_TOKENS_MAX_ITEMS,
  LIVE_TOKENS_MAX_QUEUE,
  LIVE_TOKENS_MAX_SPAN_PER_CYCLE,
  LIVE_TOKENS_POLL_INTERVAL_MS,
  ageSeconds,
  enforceQueueBound,
  nextBackoffMs,
  requeueInterrupted,
  upsertLiveToken,
  wethLiquidityFromLog,
} from "../domain/liveTokens.ts";
import type {
  LiveTokenDex,
  LiveTokenItem,
  LiveTokenRiskBand,
  LiveTokensDoc,
} from "../domain/liveTokens.ts";
import { fetchLiquidityLogs } from "./lpFeedService.ts";
import type { FeedCallContext, FeedLog, LpFeedPort } from "../ports/lpFeed.ts";
import type {
  LiveTokenView,
  LiveTokensMetadata,
  LiveTokensSnapshot,
  LiveTokensSource,
  LiveTokensStatus,
  LiveTokensTimers,
} from "../ports/liveTokens.ts";
import { candidateKeyOf } from "../domain/lpFeed.ts";

export type LiveTokensAnalyzeResult =
  | { readonly kind: "done"; readonly score: number; readonly riskBand: LiveTokenRiskBand }
  | { readonly kind: "cant-tell"; readonly reason: string }
  | { readonly kind: "error"; readonly reason: string };

export type LiveTokensStore = {
  readonly load: () => LiveTokensDoc | null;
  readonly save: (doc: LiveTokensDoc) => void;
};

export type LiveTokensServiceOptions = {
  readonly primary: LpFeedPort;
  readonly fallback: LpFeedPort;
  readonly quotes: QuoteSet;
  readonly factories: readonly FeedFactory[];
  readonly getLatestBlock: () => Promise<number | null>;
  readonly analyze: (tokenAddress: string) => Promise<LiveTokensAnalyzeResult>;
  readonly readMetadata?: ((tokenAddress: string) => Promise<LiveTokensMetadata | null>) | undefined;
  readonly store?: LiveTokensStore | undefined;
  readonly timers: LiveTokensTimers;
  // Overrides timers.now for the list's own time stamps.
  readonly now?: (() => number) | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly lookbackBlocks?: number | undefined;
  readonly maxQueued?: number | undefined;
  readonly maxPairPollsPerCycle?: number | undefined;
  readonly concurrency?: 1 | 2 | undefined;
};

export type LiveTokensService = {
  readonly snapshot: (sinceMs?: number | undefined) => LiveTokensSnapshot;
  readonly pollOnce: () => Promise<void>;
  readonly settled: (timeoutMs?: number) => Promise<boolean>;
  readonly start: () => void;
  readonly stop: () => void;
};

// Product risk bands (30/60, mirroring the web risk display): score
// under 30 reads Low, under 60 Elevated, the rest High.
export function bandForScore(score: number): LiveTokenRiskBand {
  if (score < 30) {
    return "Low";
  }
  if (score < 60) {
    return "Elevated";
  }
  return "High";
}

function dexDisplayName(dex: FeedDexId): LiveTokenDex | null {
  if (dex === "uniswap-v2") {
    return "Uniswap V2";
  }
  if (dex === "uniswap-v3") {
    return "Uniswap V3";
  }
  return null;
}

export function createLiveTokensService(options: LiveTokensServiceOptions): LiveTokensService {
  const timers = options.timers;
  const now = options.now ?? ((): number => timers.now());
  const pollIntervalMs = options.pollIntervalMs ?? LIVE_TOKENS_POLL_INTERVAL_MS;
  const lookbackBlocks = options.lookbackBlocks ?? LIVE_TOKENS_LOOKBACK_BLOCKS;
  const maxQueued = options.maxQueued ?? LIVE_TOKENS_MAX_QUEUE;
  const maxPairPolls = options.maxPairPollsPerCycle ?? 8;
  const concurrency = options.concurrency ?? 1;

  let items: readonly LiveTokenItem[] = Object.freeze([]);
  let cursorBlock: number | null = null;
  let source: LiveTokensSource = "none";
  let status: LiveTokensStatus = "live";
  let message: string | undefined;
  let updatedAt = now();
  let seenKeys = new Set<string>();
  let pollInFlight = false;
  let analyzing = 0;
  let running = false;
  let backoffMs = LIVE_TOKENS_BACKOFF_BASE_MS;
  let notBeforeMs = 0;
  let cycles = 0;
  let loaded = false;
  let cancelTimer: (() => void) | null = null;

  const factoryByAddress = new Map<string, FeedFactory>();
  for (const factory of options.factories) {
    factoryByAddress.set(factory.address.toLowerCase(), factory);
  }

  function persist(): void {
    if (cursorBlock === null || options.store === undefined) {
      return;
    }
    try {
      options.store.save({ version: 1, cursorBlock, items });
    } catch {
      // Persistence is best effort: the in-memory list keeps serving.
    }
  }

  function load(): void {
    if (options.store === undefined) {
      return;
    }
    let doc: LiveTokensDoc | null = null;
    try {
      doc = options.store.load();
    } catch {
      doc = null;
    }
    if (doc === null) {
      return;
    }
    cursorBlock = doc.cursorBlock;
    items = requeueInterrupted(doc.items.slice(0, LIVE_TOKENS_MAX_ITEMS));
    const keys = new Set<string>();
    for (const entry of items) {
      keys.add(candidateKeyOf(entry.txHash, entry.logIndex));
    }
    seenKeys = keys;
  }

  function snapshot(sinceMs?: number | undefined): LiveTokensSnapshot {
    const at = now();
    const rows: LiveTokenView[] = [];
    for (const entry of items) {
      if (sinceMs !== undefined && !(entry.createdAt > sinceMs)) {
        continue;
      }
      rows.push({ ...entry, ageSeconds: ageSeconds(entry.blockTimestampMs, at) });
    }
    return {
      source,
      status,
      ...(message === undefined ? {} : { message }),
      updatedAt,
      items: Object.freeze(rows),
    };
  }

  function takeNewestQueued(): LiveTokenItem | null {
    for (const entry of items) {
      if (entry.state === "queued") {
        return entry;
      }
    }
    return null;
  }

  function replace(entry: LiveTokenItem): void {
    const key = entry.pairAddress.toLowerCase();
    items = Object.freeze(items.map((held) => (held.pairAddress.toLowerCase() === key ? entry : held)));
  }

  async function analyzeOne(entry: LiveTokenItem): Promise<void> {
    analyzing += 1;
    replace({ ...entry, state: "analyzing" });
    persist();
    try {
      const result = await options.analyze(entry.tokenAddress);
      if (result.kind === "done") {
        replace({ ...entry, state: "done", score: result.score, riskBand: result.riskBand });
      } else if (result.kind === "cant-tell") {
        replace({
          ...entry,
          state: "cant-tell",
          reason: result.reason,
          score: undefined,
          riskBand: undefined,
        });
      } else {
        replace({
          ...entry,
          state: "error",
          reason: result.reason,
          score: undefined,
          riskBand: undefined,
        });
      }
    } catch {
      replace({ ...entry, state: "error", reason: "analysis failed" });
    } finally {
      analyzing -= 1;
      persist();
      void pump();
    }
  }

  function pump(): void {
    if (!running && analyzing > 0) {
      // Draining after stop still finishes in-flight work only.
    }
    while (analyzing < concurrency) {
      const next = takeNewestQueued();
      if (next === null) {
        return;
      }
      void analyzeOne(next);
    }
  }

  async function cycle(): Promise<void> {
    const at = now();
    if (at < notBeforeMs) {
      return;
    }
    cycles += 1;
    let latest: number | null = null;
    try {
      latest = await options.getLatestBlock();
    } catch {
      latest = null;
    }
    if (latest === null || !Number.isSafeInteger(latest) || latest < 0) {
      message = "latest block unavailable";
      updatedAt = at;
      return;
    }
    const fromBlock = cursorBlock === null ? Math.max(0, latest - lookbackBlocks) : cursorBlock + 1;
    if (fromBlock > latest) {
      updatedAt = at;
      return;
    }
    // One cycle never asks for more than the bounded per-cycle span: a
    // far-behind cursor catches up in bounded steps, advancing after
    // each successful step, instead of repeating one failing giant range
    // forever.
    const toBlock = Math.min(latest, fromBlock + LIVE_TOKENS_MAX_SPAN_PER_CYCLE - 1);
    const ctx: FeedCallContext = { requestId: `live-${at}-${cycles}`, deadlineMs: at + 30_000 };
    const primaryOutcome = await pollSource(options.primary, fromBlock, toBlock, ctx, at);
    if (primaryOutcome.kind === "served") {
      return;
    }
    const fallbackOutcome = await pollSource(options.fallback, fromBlock, toBlock, ctx, at, true);
    if (fallbackOutcome.kind === "served") {
      return;
    }
    if (primaryOutcome.kind === "not-configured") {
      status = "not-configured";
      source = "none";
      message = "set an Etherscan key to see new tokens";
      notBeforeMs = at + backoffMs;
      backoffMs = nextBackoffMs(backoffMs);
      updatedAt = at;
      return;
    }
    if (
      primaryOutcome.kind === "local" &&
      (fallbackOutcome.kind === "local" || fallbackOutcome.kind === "not-configured")
    ) {
      // Our own budget pacing is not a provider failure: keep the cursor
      // and wait for the next cycle instead of failing the range, with no
      // backoff escalation.
      message = "the token feed is pacing its requests";
      updatedAt = at;
      return;
    }
    const reason =
      fallbackOutcome.kind === "error"
        ? fallbackOutcome.message
        : primaryOutcome.kind === "error"
          ? primaryOutcome.message
          : "the token feed is pacing its requests";
    message = reason;
    notBeforeMs = at + backoffMs;
    backoffMs = nextBackoffMs(backoffMs);
    updatedAt = at;
  }

  // Polls one source over the factory set for one bounded span. "served"
  // covers full and partial coverage alike: the cursor moves to the last
  // block every factory fully covered and the next cycle retries the
  // rest. A `local` outcome means our own budget pacing (never a
  // provider refusal): the caller waits for the next cycle.
  async function pollSource(
    feed: LpFeedPort,
    fromBlock: number,
    toBlock: number,
    ctx: FeedCallContext,
    at: number,
    isFallback = false,
  ): Promise<
    | { kind: "served"; coveredToBlock: number }
    | { kind: "not-configured"; message: string }
    | { kind: "local"; message: string }
    | { kind: "error"; message: string }
  > {
    const creationLogs: FeedLog[] = [];
    let covered = toBlock;
    for (const factory of options.factories) {
      let polled;
      try {
        polled = await feed.pollLogs({ factory: factory.address, fromBlock, toBlock }, ctx);
      } catch {
        return { kind: "error", message: "the token feed is unavailable" };
      }
      if (!polled.ok) {
        if (polled.error.kind === "not-configured") {
          return { kind: "not-configured", message: polled.error.message };
        }
        if (polled.error.kind === "rate-limited" && polled.error.scope === "local") {
          return { kind: "local", message: "the token feed is pacing its requests" };
        }
        if (polled.error.kind === "rate-limited") {
          return { kind: "error", message: "the token feed is rate limited" };
        }
        return { kind: "error", message: polled.error.message };
      }
      creationLogs.push(...polled.value.logs);
      covered = Math.min(covered, polled.value.coveredToBlock);
    }
    if (covered < fromBlock) {
      return { kind: "local", message: "the token feed is pacing its requests" };
    }
    const inSpan = creationLogs.filter((log) => log.blockNumber <= covered);
    await absorbCreations(feed, inSpan, fromBlock, covered, ctx, at);
    cursorBlock = covered;
    source = isFallback ? "rpc" : "etherscan";
    status = "live";
    message = isFallback ? "using RPC fallback" : undefined;
    backoffMs = LIVE_TOKENS_BACKOFF_BASE_MS;
    updatedAt = at;
    persist();
    pump();
    return { kind: "served", coveredToBlock: covered };
  }

  async function absorbCreations(
    feed: LpFeedPort,
    creationLogs: readonly FeedLog[],
    fromBlock: number,
    toBlock: number,
    ctx: FeedCallContext,
    at: number,
  ): Promise<void> {
    type Pending = {
      tokenAddress: string;
      pairAddress: string;
      token0: string;
      token1: string;
      dex: LiveTokenDex;
      feeTier?: number | undefined;
      block: number;
      txHash: string;
      logIndex: number;
      blockTimestampMs: number | null;
    };
    const pending: Pending[] = [];
    for (const log of creationLogs) {
      const factory = factoryByAddress.get(log.address.toLowerCase());
      if (factory === undefined) {
        continue;
      }
      const key = candidateKeyOf(log.txHash, log.logIndex);
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
      if (factory.kind === "v2") {
        const decoded = decodeV2PairCreated(log);
        if (!decoded.ok) {
          continue;
        }
        const resolved = resolveNewToken(decoded.value.token0, decoded.value.token1, options.quotes);
        if (resolved.kind === "skipped") {
          continue;
        }
        const dex = dexDisplayName(factory.dex);
        if (dex === null) {
          continue;
        }
        pending.push({
          tokenAddress: resolved.tokenAddress,
          pairAddress: decoded.value.pair,
          token0: decoded.value.token0,
          token1: decoded.value.token1,
          dex,
          block: log.blockNumber,
          txHash: log.txHash.toLowerCase(),
          logIndex: log.logIndex,
          blockTimestampMs: log.blockTimestampMs ?? null,
        });
      } else if (factory.kind === "v3") {
        const decoded = decodeV3PoolCreated(log);
        if (!decoded.ok) {
          continue;
        }
        const resolved = resolveNewToken(decoded.value.token0, decoded.value.token1, options.quotes);
        if (resolved.kind === "skipped") {
          continue;
        }
        const dex = dexDisplayName(factory.dex);
        if (dex === null) {
          continue;
        }
        pending.push({
          tokenAddress: resolved.tokenAddress,
          pairAddress: decoded.value.pool,
          token0: decoded.value.token0,
          token1: decoded.value.token1,
          dex,
          feeTier: decoded.value.fee,
          block: log.blockNumber,
          txHash: log.txHash.toLowerCase(),
          logIndex: log.logIndex,
          blockTimestampMs: log.blockTimestampMs ?? null,
        });
      }
    }
    const pairAddresses = [...new Set(pending.map((entry) => entry.pairAddress))].slice(0, maxPairPolls);
    let liquidity: readonly FeedLog[] = Object.freeze([]);
    if (pairAddresses.length > 0) {
      try {
        const fetched = await fetchLiquidityLogs(feed, pairAddresses, fromBlock, toBlock, ctx);
        liquidity = fetched.logs;
      } catch {
        liquidity = Object.freeze([]);
      }
    }
    const weth = options.quotes.weth;
    for (const entry of pending) {
      let initialLiquidityWeth: string | null = null;
      if (weth !== null) {
        for (const log of liquidity) {
          if (log.address.toLowerCase() !== entry.pairAddress.toLowerCase()) {
            continue;
          }
          const parsed = wethLiquidityFromLog(
            { topic0: log.topics[0] ?? "", data: log.data },
            entry.token0,
            entry.token1,
            weth,
          );
          if (parsed !== null) {
            initialLiquidityWeth = parsed;
            break;
          }
        }
      }
      let metadata: LiveTokensMetadata | null = null;
      if (options.readMetadata !== undefined) {
        try {
          metadata = await options.readMetadata(entry.tokenAddress);
        } catch {
          metadata = null;
        }
      }
      const item: LiveTokenItem = Object.freeze({
        chainId: 1 as const,
        tokenAddress: entry.tokenAddress,
        symbol: metadata?.symbol ?? null,
        name: metadata?.name ?? null,
        pairAddress: entry.pairAddress,
        dex: entry.dex,
        ...(entry.feeTier === undefined ? {} : { feeTier: entry.feeTier }),
        block: entry.block,
        txHash: entry.txHash,
        logIndex: entry.logIndex,
        createdAt: at,
        blockTimestampMs: entry.blockTimestampMs,
        initialLiquidityWeth,
        state: "queued" as const,
      });
      items = upsertLiveToken(items, item);
    }
    items = enforceQueueBound(items, maxQueued);
  }

  async function pollOnce(): Promise<void> {
    if (!loaded) {
      loaded = true;
      load();
    }
    if (pollInFlight) {
      return;
    }
    pollInFlight = true;
    try {
      await cycle();
    } finally {
      pollInFlight = false;
    }
  }

  async function settled(timeoutMs = 5000): Promise<boolean> {
    const deadline = timers.now() + timeoutMs;
    for (;;) {
      const quiet =
        !pollInFlight &&
        analyzing === 0 &&
        !items.some((entry) => entry.state === "queued" || entry.state === "analyzing");
      if (quiet) {
        return true;
      }
      if (timers.now() >= deadline) {
        return false;
      }
      await timers.sleep(5);
    }
  }

  function start(): void {
    if (cancelTimer !== null) {
      return;
    }
    running = true;
    void pollOnce();
    cancelTimer = timers.every(pollIntervalMs, () => {
      void pollOnce();
    });
  }

  function stop(): void {
    running = false;
    if (cancelTimer !== null) {
      cancelTimer();
      cancelTimer = null;
    }
  }

  return Object.freeze({ snapshot, pollOnce, settled, start, stop });
}
