// Point-in-time on-chain feature orchestration (session A).
// Application service: drives the shared pure computation in
// src/domain/onchain through RpcPort. Two drivers share the computation:
// the offline extractor (point-in-time blocks T0 + W for training) and the
// serving path (current block for inference). Findings never enter the
// score: the service returns display data only, and the current artifact
// carries no weights for these features. Era confounding is recorded, not
// used: deployment and analysis blocks ride along so session B can measure
// how much of the signal is just the era; the absolute block number is
// never a model feature here.
import { analyzeOwnerControl } from "../domain/ownerControl.ts";
import { Address, BlockNumber, CallData, Slot } from "../domain/types.ts";
import type {
  Address as AddressType,
  BlockNumber as BlockNumberType,
  RequestId as RequestIdType,
  Timestamp as TimestampType,
} from "../domain/types.ts";
import {
  FIRST_LIQUIDITY_SEARCH_BLOCKS,
  T0_SEARCH_BLOCKS,
  decodeV2PairCreated,
  decodeV3PoolCreated,
  qualifyingFactories,
  qualifyingTokenSide,
  quoteSet,
} from "../domain/onchain/pools.ts";
import type { DecodableLog, PoolCandidate, QuoteSet } from "../domain/onchain/pools.ts";
import {
  DEFAULT_LOG_RANGE_BLOCKS,
  MIN_LOG_RANGE_BLOCKS,
} from "../domain/onchain/pools.ts";
import { TRANSFER_LOG_CAP } from "../domain/onchain/transfers.ts";
import type { ConcentrationResult, TransferEvent } from "../domain/onchain/transfers.ts";
import { FEATURE_W_VALUES } from "../domain/onchain/features.ts";
import { onchainAgePlugin } from "../plugins/onchain/age/index.ts";
import { onchainConcentrationPlugin } from "../plugins/onchain/concentration/index.ts";
import { onchainDeployerPlugin } from "../plugins/onchain/deployer/index.ts";
import { onchainLiquidityPlugin } from "../plugins/onchain/liquidity/index.ts";
import { onchainLpPlugin } from "../plugins/onchain/lp/index.ts";
import { onchainOwnerPlugin } from "../plugins/onchain/owner/index.ts";

const { lpBucketsOf } = onchainLpPlugin.compute;
const { liquidityOf } = onchainLiquidityPlugin.compute;
const { ownerFeatureOf, classifyOwner } = onchainOwnerPlugin.compute;
const { concentrationOf, decodeTransfer } = onchainConcentrationPlugin.compute;
const { analysisBlock } = onchainDeployerPlugin.compute;
const { tokenAgeBlocks } = onchainAgePlugin.compute;
import type {
  LiquidityFeature,
  LpBuckets,
  OwnerFeature,
  TokenFeatures,
  VariantFeatures,
} from "../domain/onchain/features.ts";
import { lockerAddresses } from "../domain/onchain/lockers.ts";
import {
  DECIMALS_SELECTOR,
  TRANSFER_TOPIC,
  V2_MINT_TOPIC,
  V2_PAIR_CREATED_TOPIC,
  V2_SYNC_TOPIC,
  V3_MINT_TOPIC,
  V3_POOL_CREATED_TOPIC,
  addressTopic,
} from "../domain/onchain/topics.ts";
import {
  balanceOfCallData,
  decodeAddressWord,
  decodeReserves,
  decodeUint256,
  getPairCallData,
  getReservesCallData,
  liquidityCallData,
  masterCopyCallData,
  ownerCallData,
  token0CallData,
  token1CallData,
  totalSupplyCallData,
} from "../domain/onchain/calls.ts";
import type {
  BlockReceipt,
  CallContext,
  ChainLog,
  RpcPort,
} from "../ports/rpc.ts";

export type OnchainReadMode = "point-in-time" | "serving";

export type OnchainReadInput = {
  readonly token: AddressType;
  readonly requestId: RequestIdType;
  readonly deadline: TimestampType;
  readonly mode: OnchainReadMode;
  readonly weth: string | null;
  readonly quoteOverrides?: QuoteSet | undefined;
  readonly headBlock?: number | undefined;
  readonly factoryGenesis?: ReadonlyMap<string, number> | undefined;
  // Injected clock reader for deadline checks: the application layer
  // never reads the system clock itself (A-32); driving adapters pass it.
  readonly nowMs: () => number;
};

export type LogRangeState = {
  rangeBlocks: number;
};

export function freshRangeState(): LogRangeState {
  return { rangeBlocks: DEFAULT_LOG_RANGE_BLOCKS };
}

function ctxFor(input: OnchainReadInput, block: BlockNumberType | "latest"): CallContext {
  return { requestId: input.requestId, deadline: input.deadline, block };
}

function blockOf(value: number): BlockNumberType | null {
  const parsed = BlockNumber.of(value);
  return parsed.ok ? parsed.value : null;
}

function deadlineExceeded(input: OnchainReadInput): boolean {
  const now = input.nowMs();
  return now >= (input.deadline as number);
}

// First block in [low, high] where the address carries code. Binary search
// over pinned getCode reads: "absent" when the head carries no code,
// "unknown" when a read fails or the deadline passes mid-search (the
// caller reports can't-tell rather than guessing from a half search).
export async function findDeploymentBlock(
  rpc: RpcPort,
  address: AddressType,
  low: number,
  high: number,
  input: OnchainReadInput,
): Promise<{ readonly kind: "found"; readonly block: number } | { readonly kind: "absent" } | { readonly kind: "unknown" }> {
  let floor = Math.max(0, Math.floor(low));
  const ceilingStart = Math.floor(high);
  const top = blockOf(ceilingStart);
  if (top === null) {
    return { kind: "unknown" };
  }
  const present = await rpc.getCode(address, ctxFor(input, top));
  if (!present.ok && present.error.kind === "no-code") {
    return { kind: "absent" };
  }
  if (!present.ok) {
    return { kind: "unknown" };
  }
  let ceiling = ceilingStart;
  let found = ceiling;
  while (floor < ceiling) {
    if (deadlineExceeded(input)) {
      return { kind: "unknown" };
    }
    const mid = Math.floor((floor + ceiling) / 2);
    const at = blockOf(mid);
    if (at === null) {
      return { kind: "unknown" };
    }
    const fetched = await rpc.getCode(address, ctxFor(input, at));
    if (fetched.ok) {
      found = mid;
      ceiling = mid;
    } else if (fetched.error.kind === "no-code") {
      floor = mid + 1;
    } else {
      return { kind: "unknown" };
    }
  }
  return { kind: "found", block: found };
}

// Deployer discovery: the sender of the top-level creation transaction at
// the deployment block. A token created by a factory internally carries no
// direct creation receipt; the factory is then recorded as the creator and
// the deployer stays can't-tell unless provable. Unreadable receipts give
// provenance unknown rather than a guessed factory claim.
export async function findDeployer(
  rpc: RpcPort,
  token: AddressType,
  deploymentBlock: number,
  input: OnchainReadInput,
): Promise<{ readonly deployer: string | null; readonly provenance: "creation-tx" | "factory-or-internal" | "unknown" }> {
  const at = blockOf(deploymentBlock);
  if (at === null) {
    return { deployer: null, provenance: "unknown" };
  }
  const receipts = await rpc.getBlockReceipts(at, ctxFor(input, at));
  if (!receipts.ok) {
    return { deployer: null, provenance: "unknown" };
  }
  const wanted = (token as string).toLowerCase();
  const match: BlockReceipt | undefined = receipts.value.find(
    (receipt) => (receipt.contractAddress ?? "").toLowerCase() === wanted,
  );
  if (match === undefined) {
    return { deployer: null, provenance: "factory-or-internal" };
  }
  return { deployer: match.from.toLowerCase(), provenance: "creation-tx" };
}

// Factory genesis blocks (first block carrying code per factory), resolved
// once per run and shared across tokens so the creation scan can start at
// the factory genesis instead of re-scanning empty history.
export async function resolveFactoryGenesis(
  rpc: RpcPort,
  head: number,
  input: OnchainReadInput,
): Promise<ReadonlyMap<string, number>> {
  const out = new Map<string, number>();
  for (const factory of qualifyingFactories()) {
    const parsed = Address.parse(factory.address);
    if (!parsed.ok) {
      continue;
    }
    const genesis = await findDeploymentBlock(rpc, parsed.value, 0, head, input);
    if (genesis.kind === "found") {
      out.set(factory.address.toLowerCase(), genesis.block);
    }
    if (deadlineExceeded(input)) {
      break;
    }
  }
  return out;
}

// Chunked historical log fetch with adaptive ranges: on range-too-large
// the chunk size halves (down to the documented minimum) and the chunk
// retries. A chunk returning suspiciously many logs refetches smaller, so
// a silent node-side truncation never becomes a truncated ranking.
export async function fetchLogsAdaptive(
  rpc: RpcPort,
  base: {
    readonly address?: readonly string[] | undefined;
    readonly topics?: readonly (readonly string[] | null)[] | undefined;
  },
  fromBlock: number,
  toBlock: number,
  input: OnchainReadInput,
  state: LogRangeState,
  perChunkSuspect = 5000,
): Promise<{ readonly logs: readonly ChainLog[]; readonly truncated: boolean }> {
  const out: ChainLog[] = [];
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    if (deadlineExceeded(input)) {
      return { logs: Object.freeze(out), truncated: true };
    }
    const size = Math.max(MIN_LOG_RANGE_BLOCKS, Math.floor(state.rangeBlocks));
    const end = Math.min(toBlock, cursor + size - 1);
    const from = blockOf(cursor);
    const to = blockOf(end);
    if (from === null || to === null) {
      return { logs: Object.freeze(out), truncated: true };
    }
    const fetched = await rpc.getLogs(
      { address: base.address, topics: base.topics, fromBlock: from, toBlock: to },
      ctxFor(input, to),
    );
    if (!fetched.ok) {
      if (fetched.error.kind === "range-too-large" && size > MIN_LOG_RANGE_BLOCKS) {
        state.rangeBlocks = Math.max(MIN_LOG_RANGE_BLOCKS, Math.floor(size / 2));
        continue;
      }
      return { logs: Object.freeze(out), truncated: true };
    }
    if (fetched.value.length >= perChunkSuspect && size > MIN_LOG_RANGE_BLOCKS) {
      state.rangeBlocks = Math.max(MIN_LOG_RANGE_BLOCKS, Math.floor(size / 2));
      continue;
    }
    out.push(...fetched.value);
    cursor = end + 1;
  }
  return { logs: Object.freeze(out), truncated: false };
}

function toDecodable(log: ChainLog): DecodableLog {
  return {
    address: log.address,
    topics: log.topics,
    data: log.data,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    txHash: log.txHash,
    logIndex: log.logIndex,
  };
}

// Pool creation scan: PairCreated/PoolCreated logs where the token is one
// side and a quote asset is the other, from the clamp block forward. The
// factories share one topic per kind, so both V2 factories (and both V3
// factories) are covered by two positional queries each.
export async function searchPoolCreations(
  rpc: RpcPort,
  token: AddressType,
  quotes: QuoteSet,
  fromBlock: number,
  input: OnchainReadInput,
  state: LogRangeState,
): Promise<readonly PoolCandidate[]> {
  const tokenWord = addressTopic(token as string);
  const quoteWords = [quotes.weth, quotes.usdc, quotes.usdt, quotes.dai]
    .filter((entry): entry is string => entry !== null)
    .map((entry) => addressTopic(entry));
  const v2Factories = qualifyingFactories()
    .filter((factory) => factory.kind === "v2")
    .map((factory) => factory.address);
  const v3Factories = qualifyingFactories()
    .filter((factory) => factory.kind === "v3")
    .map((factory) => factory.address);
  const queries: { readonly factories: readonly string[]; readonly topic: string; readonly kind: "v2" | "v3" }[] = [
    { factories: v2Factories, topic: V2_PAIR_CREATED_TOPIC, kind: "v2" },
    { factories: v3Factories, topic: V3_POOL_CREATED_TOPIC, kind: "v3" },
  ];
  const out: PoolCandidate[] = [];
  const toBlock = fromBlock + T0_SEARCH_BLOCKS;
  for (const query of queries) {
    if (query.factories.length === 0) {
      continue;
    }
    const dexOf = new Map(qualifyingFactories().map((factory) => [factory.address.toLowerCase(), factory.dex]));
    for (const positional of [
      { topics: [[query.topic], [tokenWord], quoteWords] as const, tokenFirst: true },
      { topics: [[query.topic], quoteWords, [tokenWord]] as const, tokenFirst: false },
    ]) {
      const fetched = await fetchLogsAdaptive(
        rpc,
        { address: query.factories, topics: positional.topics.map((position) => Object.freeze([...position])) },
        fromBlock,
        toBlock,
        input,
        state,
      );
      for (const log of fetched.logs) {
        const decoded =
          query.kind === "v2" ? decodeV2PairCreated(toDecodable(log)) : decodeV3PoolCreated(toDecodable(log));
        if (decoded === null) {
          continue;
        }
        const side = qualifyingTokenSide(decoded.token0, decoded.token1, quotes);
        if (side === null || side.token !== (token as string).toLowerCase()) {
          continue;
        }
        const address = query.kind === "v2" ? (decoded as { pair: string }).pair : (decoded as { pool: string }).pool;
        out.push(
          Object.freeze({
            kind: query.kind,
            dex: dexOf.get(log.address.toLowerCase()) ?? "unknown",
            address,
            quote: side.quote,
            creationBlock: log.blockNumber,
            creationLogIndex: log.logIndex,
            creationTxHash: log.txHash,
          }),
        );
      }
      if (fetched.truncated || deadlineExceeded(input)) {
        break;
      }
    }
  }
  out.sort((left, right) =>
    left.creationBlock !== right.creationBlock
      ? left.creationBlock - right.creationBlock
      : left.creationLogIndex - right.creationLogIndex,
  );
  return Object.freeze(out);
}

async function ethCallHex(
  rpc: RpcPort,
  to: AddressType,
  dataHex: string,
  at: BlockNumberType,
  input: OnchainReadInput,
): Promise<string | null> {
  const parsed = CallData.parse(dataHex);
  if (!parsed.ok) {
    return null;
  }
  const outcome = await rpc.call(to, parsed.value, ctxFor(input, at));
  if (!outcome.ok) {
    return null;
  }
  return `0x${Buffer.from(outcome.value).toString("hex")}`;
}

async function ethCallAddress(
  rpc: RpcPort,
  to: AddressType,
  dataHex: string,
  at: BlockNumberType,
  input: OnchainReadInput,
): Promise<string | null> {
  const hex = await ethCallHex(rpc, to, dataHex, at, input);
  return hex === null ? null : decodeAddressWord(hex);
}

async function ethCallUint(
  rpc: RpcPort,
  to: AddressType,
  dataHex: string,
  at: BlockNumberType,
  input: OnchainReadInput,
): Promise<bigint | null> {
  const hex = await ethCallHex(rpc, to, dataHex, at, input);
  return hex === null ? null : decodeUint256(hex);
}

function addressValue(raw: string): AddressType | null {
  const parsed = Address.parse(raw);
  return parsed.ok ? parsed.value : null;
}

// First-liquidity search for one candidate pool: the first Mint (V2/V3) or
// Sync (V2) log from its creation block whose reserves or liquidity verify
// non-zero at that block. Sync fires on every pool interaction, so the
// first verified log is the first block the pool holds value.
export async function findFirstLiquidity(
  rpc: RpcPort,
  candidate: PoolCandidate,
  input: OnchainReadInput,
  state: LogRangeState,
): Promise<number | null> {
  const pool = addressValue(candidate.address);
  const at = blockOf(candidate.creationBlock);
  if (pool === null || at === null) {
    return null;
  }
  const topics = candidate.kind === "v2" ? [[V2_MINT_TOPIC, V2_SYNC_TOPIC]] : [[V3_MINT_TOPIC]];
  const fetched = await fetchLogsAdaptive(
    rpc,
    { address: [candidate.address], topics: topics.map((position) => Object.freeze([...position])) },
    candidate.creationBlock,
    candidate.creationBlock + FIRST_LIQUIDITY_SEARCH_BLOCKS,
    input,
    state,
  );
  const ordered = [...fetched.logs].sort((left, right) =>
    left.blockNumber !== right.blockNumber ? left.blockNumber - right.blockNumber : left.logIndex - right.logIndex,
  );
  for (const log of ordered) {
    const verifyAt = blockOf(log.blockNumber);
    if (verifyAt === null) {
      continue;
    }
    if (candidate.kind === "v2") {
      const hex = await ethCallHex(rpc, pool, getReservesCallData(), verifyAt, input);
      const reserves = hex === null ? null : decodeReserves(hex);
      if (reserves !== null && (reserves.reserve0 > 0n || reserves.reserve1 > 0n)) {
        return log.blockNumber;
      }
    } else {
      const liquidity = await ethCallUint(rpc, pool, liquidityCallData(), verifyAt, input);
      if (liquidity !== null && liquidity > 0n) {
        return log.blockNumber;
      }
    }
    if (deadlineExceeded(input)) {
      return null;
    }
  }
  return null;
}

async function readOwner(
  rpc: RpcPort,
  token: AddressType,
  at: BlockNumberType,
  input: OnchainReadInput,
): Promise<{ readonly feature: OwnerFeature; readonly address: string | null }> {
  const code = await rpc.getCode(token, ctxFor(input, at));
  if (!code.ok) {
    return { feature: { status: "cant-tell", reason: "token code is unreadable" }, address: null };
  }
  const view = analyzeOwnerControl(code.value.bytecode);
  let ownerWord: string | null = null;
  let slotProven = false;
  if (view.ownerSlot !== null) {
    const slot = Slot.parse(`0x${view.ownerSlot.toString(16).padStart(64, "0")}`);
    if (slot.ok) {
      const stored = await rpc.getStorageAt(token, slot.value, ctxFor(input, at));
      if (stored.ok) {
        ownerWord = (stored.value as string).toLowerCase();
        slotProven = true;
      }
    }
  }
  if (ownerWord === null) {
    ownerWord = await ethCallAddress(rpc, token, ownerCallData(), at, input);
  }
  if (ownerWord === null) {
    return { feature: { status: "cant-tell", reason: "no proven owner slot and no owner() answer" }, address: null };
  }
  const holder = addressValue(ownerWord);
  let hasCode = false;
  if (holder !== null) {
    const holderCode = await rpc.getCode(holder, ctxFor(input, at));
    hasCode = holderCode.ok;
  }
  let masterCopy: string | null = null;
  if (hasCode && holder !== null) {
    masterCopy = await ethCallAddress(rpc, holder, masterCopyCallData(), at, input);
  }
  const feature = ownerFeatureOf({ ownerWord, ownerHasCode: hasCode, masterCopy, slotProven });
  const proved = classifyOwner({ ownerWord, ownerHasCode: hasCode, masterCopy });
  const address = feature.status === "ok" && (proved.kind === "eoa" || proved.kind === "contract" || proved.kind === "safe")
    ? proved.address
    : null;
  return { feature, address };
}

async function readVariant(
  rpc: RpcPort,
  token: AddressType,
  deploymentBlock: number,
  deployer: string | null,
  t0Pool: PoolCandidate | null,
  poolAddresses: readonly string[],
  quotes: QuoteSet,
  decimalsCache: Map<string, number>,
  window: number,
  t0: number,
  head: number,
  input: OnchainReadInput,
  state: LogRangeState,
): Promise<VariantFeatures> {
  const atNumber = analysisBlock(t0, window);
  const fail = (reason: string): VariantFeatures => {
    const cantTell = { status: "cant-tell", reason } as const;
    const cantTellTransfers = { kind: "cant-tell", reason } as const;
    return Object.freeze({
      window,
      analysisBlock: atNumber,
      owner: cantTell,
      lp: cantTell,
      concentration: cantTellTransfers,
      liquidity: cantTell,
      tokenAgeBlocks: null,
    });
  };
  if (atNumber > head) {
    return fail("analysis block is beyond the head");
  }
  const at = blockOf(atNumber);
  if (at === null) {
    return fail("analysis block is out of range");
  }
  const { feature: owner, address: ownerAddress } = await readOwner(rpc, token, at, input);
  const tokenTotalSupply = await ethCallUint(rpc, token, totalSupplyCallData(), at, input);

  let lp: LpBuckets;
  if (t0Pool === null || t0Pool.kind !== "v2") {
    lp = t0Pool === null
      ? { status: "cant-tell", reason: "no qualifying v2 pool" }
      : { status: "cant-tell", reason: "v3 position ownership is too costly to prove" };
  } else {
    lp = await readLpBuckets(rpc, t0Pool, deployer, ownerAddress, at, input);
  }

  let concentration: ConcentrationResult;
  const transfers = await fetchLogsAdaptive(
    rpc,
    { address: [token as string], topics: [[TRANSFER_TOPIC]] },
    deploymentBlock,
    atNumber,
    input,
    state,
  );
  if (transfers.truncated) {
    concentration = { kind: "cant-tell", reason: "transfer log scan truncated" };
  } else if (transfers.logs.length > TRANSFER_LOG_CAP) {
    concentration = { kind: "cant-tell", reason: "transfer log volume exceeds the documented cap" };
  } else {
    const decoded: TransferEvent[] = [];
    for (const log of transfers.logs) {
      const event = decodeTransfer(toDecodable(log));
      if (event !== null) {
        decoded.push(event);
      }
    }
    concentration = concentrationOf({
      transfers: decoded,
      excluded: poolAddresses,
      totalSupply: tokenTotalSupply,
      deployer,
      owner: ownerAddress,
    });
  }
  let liquidity: LiquidityFeature;
  if (t0Pool === null || t0Pool.kind !== "v2") {
    liquidity = { status: "cant-tell", reason: "no qualifying v2 pool for size" };
  } else {
    liquidity = await readLiquidity(rpc, t0Pool, quotes, decimalsCache, at, input);
  }
  return Object.freeze({
    window,
    analysisBlock: atNumber,
    owner,
    lp,
    concentration,
    liquidity,
    tokenAgeBlocks: tokenAgeBlocks(atNumber, deploymentBlock),
  });
}

async function readLpBuckets(
  rpc: RpcPort,
  pool: PoolCandidate,
  deployer: string | null,
  owner: string | null,
  at: BlockNumberType,
  input: OnchainReadInput,
): Promise<LpBuckets> {
  const pair = addressValue(pool.address);
  if (pair === null) {
    return { status: "cant-tell", reason: "pool address is malformed" };
  }
  const lpTotalSupply = await ethCallUint(rpc, pair, totalSupplyCallData(), at, input);
  if (lpTotalSupply === null) {
    return { status: "cant-tell", reason: "lp total supply is unreadable" };
  }
  const holders = ["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"];
  for (const locker of lockerAddresses()) {
    holders.push(locker);
  }
  if (deployer !== null) {
    holders.push(deployer);
  }
  if (owner !== null) {
    holders.push(owner);
  }
  const balances: Record<string, bigint> = {};
  for (const holder of holders) {
    const holderAddress = addressValue(holder);
    if (holderAddress === null) {
      return { status: "cant-tell", reason: "lp holder address is malformed" };
    }
    const balance = await ethCallUint(rpc, pair, balanceOfCallData(holderAddress as string), at, input);
    if (balance === null) {
      return { status: "cant-tell", reason: "lp balance read failed" };
    }
    balances[holder.toLowerCase()] = balance;
  }
  return lpBucketsOf({
    kind: "v2",
    lpTotalSupply,
    balances,
    deployer,
    owner,
  });
}

async function readDecimals(
  rpc: RpcPort,
  holder: string,
  at: BlockNumberType,
  input: OnchainReadInput,
  cache: Map<string, number>,
): Promise<number | null> {
  const key = holder.toLowerCase();
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const holderAddress = addressValue(holder);
  if (holderAddress === null) {
    return null;
  }
  const hex = await ethCallHex(rpc, holderAddress, DECIMALS_SELECTOR, at, input);
  const value = hex === null ? null : decodeUint256(hex);
  if (value === null || value > 77n) {
    return null;
  }
  const decimals = Number(value);
  cache.set(key, decimals);
  return decimals;
}

// Canonical WETH-per-stable rate at the same block through the V2 factory
// getPair: the deterministic conversion for stablecoin liquidity into WETH
// terms. Amounts normalize by token decimals, so 6-decimal stables compare
// against 18-decimal WETH.
async function readWethPerStable(
  rpc: RpcPort,
  quotes: QuoteSet,
  at: BlockNumberType,
  input: OnchainReadInput,
  cache: Map<string, number>,
): Promise<number | null> {
  if (quotes.weth === null) {
    return null;
  }
  const v2Factory = qualifyingFactories().find((factory) => factory.kind === "v2");
  const factory = v2Factory === undefined ? null : addressValue(v2Factory.address);
  if (factory === null) {
    return null;
  }
  const pairHex = await ethCallHex(
    rpc,
    factory,
    getPairCallData(quotes.weth, quotes.usdc),
    at,
    input,
  );
  const pairAddress = pairHex === null ? null : decodeAddressWord(pairHex);
  const pair = pairAddress === null ? null : addressValue(pairAddress);
  if (pair === null) {
    return null;
  }
  const [token0, reserves] = await Promise.all([
    ethCallAddress(rpc, pair, token0CallData(), at, input),
    (async () => {
      const hex = await ethCallHex(rpc, pair, getReservesCallData(), at, input);
      return hex === null ? null : decodeReserves(hex);
    })(),
  ]);
  if (token0 === null || reserves === null) {
    return null;
  }
  const [wethDecimals, usdcDecimals] = await Promise.all([
    readDecimals(rpc, quotes.weth, at, input, cache),
    readDecimals(rpc, quotes.usdc, at, input, cache),
  ]);
  if (wethDecimals === null || usdcDecimals === null) {
    return null;
  }
  const wethIsToken0 = token0.toLowerCase() === quotes.weth.toLowerCase();
  const wethReserve = Number(wethIsToken0 ? reserves.reserve0 : reserves.reserve1) / 10 ** wethDecimals;
  const usdcReserve = Number(wethIsToken0 ? reserves.reserve1 : reserves.reserve0) / 10 ** usdcDecimals;
  if (!(wethReserve > 0) || !(usdcReserve > 0)) {
    return null;
  }
  return wethReserve / usdcReserve;
}

async function readLiquidity(
  rpc: RpcPort,
  pool: PoolCandidate,
  quotes: QuoteSet,
  decimalsCache: Map<string, number>,
  at: BlockNumberType,
  input: OnchainReadInput,
): Promise<LiquidityFeature> {
  const pair = addressValue(pool.address);
  if (pair === null) {
    return { status: "cant-tell", reason: "pool address is malformed" };
  }
  const [token0, token1, reservesHex] = await Promise.all([
    ethCallAddress(rpc, pair, token0CallData(), at, input),
    ethCallAddress(rpc, pair, token1CallData(), at, input),
    ethCallHex(rpc, pair, getReservesCallData(), at, input),
  ]);
  const reserves = reservesHex === null ? null : decodeReserves(reservesHex);
  if (token0 === null || token1 === null || reserves === null) {
    return { status: "cant-tell", reason: "pool reserves are unreadable" };
  }
  const quoteLower = pool.quote.toLowerCase();
  const quoteIsToken0 = token0.toLowerCase() === quoteLower;
  const quoteReserve = quoteIsToken0 ? reserves.reserve0 : reserves.reserve1;
  const wethLower = quotes.weth === null ? null : quotes.weth.toLowerCase();
  const quoteIsWeth = wethLower !== null && quoteLower === wethLower;
  const quoteIsStable = [quotes.usdc, quotes.usdt, quotes.dai].some(
    (stable) => stable.toLowerCase() === quoteLower,
  );
  const decimals = await readDecimals(rpc, pool.quote, at, input, decimalsCache);
  let wethPerStable: number | null = null;
  if (quoteIsStable && decimals !== null) {
    wethPerStable = await readWethPerStable(rpc, quotes, at, input, decimalsCache);
  }
  return liquidityOf({
    kind: "v2",
    quote: pool.quote,
    quoteIsWeth,
    quoteIsStable,
    quoteReserve,
    quoteDecimals: decimals,
    wethPerStable,
  });
}

function variantReasons(variant: VariantFeatures): string[] {
  const out: string[] = [];
  if (variant.owner.status === "cant-tell") {
    out.push(`w${variant.window} owner: ${variant.owner.reason}`);
  }
  if (variant.lp.status === "cant-tell") {
    out.push(`w${variant.window} lp: ${variant.lp.reason}`);
  }
  if (variant.concentration.kind === "cant-tell") {
    out.push(`w${variant.window} concentration: ${variant.concentration.reason}`);
  }
  if (variant.liquidity.status === "cant-tell") {
    out.push(`w${variant.window} liquidity: ${variant.liquidity.reason}`);
  }
  return out;
}

function noPoolVariant(window: number): VariantFeatures {
  const cantTell = { status: "cant-tell", reason: "no qualifying pool" } as const;
  const cantTellTransfers = { kind: "cant-tell", reason: "no qualifying pool" } as const;
  return Object.freeze({
    window,
    analysisBlock: null,
    owner: cantTell,
    lp: cantTell,
    concentration: cantTellTransfers,
    liquidity: cantTell,
    tokenAgeBlocks: null,
  });
}

// Main entry: point-in-time features for training (T0 + W) or serving
// features at the current block ("now"). Training discovers T0 from pool
// creation and first-liquidity logs; serving skips discovery and reads at
// the head. The absolute block number is recorded for era analysis and is
// never a model feature.
export async function readOnchainFeatures(rpc: RpcPort, input: OnchainReadInput): Promise<TokenFeatures> {
  const noContract = (reason: string): TokenFeatures => ({
    deploymentBlock: null,
    deployer: null,
    deployerProvenance: "unknown",
    t0: null,
    t0Pool: null,
    blocksToT0: null,
    status: "no-pool",
    reasons: Object.freeze([reason]),
    variants: Object.freeze(FEATURE_W_VALUES.map(noPoolVariant)),
  });
  const headNumber = input.headBlock ?? null;
  let head = headNumber;
  if (head === null) {
    const fetched = await rpc.getBlockNumber(ctxFor(input, "latest"));
    if (!fetched.ok) {
      return noContract("head block is unreadable");
    }
    head = fetched.value as number;
  }
  const deployed = await findDeploymentBlock(rpc, input.token, 0, head, input);
  if (deployed.kind === "absent") {
    return noContract("no contract code at the head");
  }
  if (deployed.kind === "unknown") {
    return noContract("deployment block is unreadable");
  }
  const deploymentBlock = deployed.block;
  const { deployer, provenance } = await findDeployer(rpc, input.token, deploymentBlock, input);
  const quotes = input.quoteOverrides ?? quoteSet(input.weth);
  const state = freshRangeState();
  const decimalsCache = new Map<string, number>();
  const genesisValues = input.factoryGenesis === undefined ? [] : [...input.factoryGenesis.values()];
  const clamp = genesisValues.length === 0 ? deploymentBlock : Math.max(deploymentBlock, Math.min(...genesisValues));
  const candidates = await searchPoolCreations(rpc, input.token, quotes, clamp, input, state);
  const poolAddresses = [...new Set(candidates.map((candidate) => candidate.address.toLowerCase()))];
  let t0: number | null = null;
  let t0Pool: PoolCandidate | null = null;
  for (const candidate of candidates) {
    const first = await findFirstLiquidity(rpc, candidate, input, state);
    if (first !== null) {
      t0 = first;
      t0Pool = candidate;
      break;
    }
    if (deadlineExceeded(input)) {
      break;
    }
  }
  if (input.mode === "serving") {
    const reasons: string[] = [];
    if (provenance !== "creation-tx") {
      reasons.push("deployer: created by a factory or internally, deployer is can't tell");
    }
    if (t0 === null || t0Pool === null) {
      reasons.push("no qualifying pool holds liquidity: pool-relative features are can't tell");
    }
    const finalPool: PoolCandidate | null = t0Pool;
    const variant = await readVariant(
      rpc,
      input.token,
      deploymentBlock,
      deployer,
      finalPool,
      poolAddresses,
      quotes,
      decimalsCache,
      0,
      head,
      head,
      input,
      state,
    );
    reasons.push(...variantReasons(variant));
    return {
      deploymentBlock,
      deployer,
      deployerProvenance: provenance,
      t0,
      t0Pool: finalPool === null ? null : Object.freeze({ kind: finalPool.kind, dex: finalPool.dex }),
      blocksToT0: t0 === null ? null : t0 - deploymentBlock,
      status: reasons.length === 0 ? "ok" : "partial",
      reasons: Object.freeze(reasons),
      variants: Object.freeze([{ ...variant, window: 0, analysisBlock: head }]),
    };
  }
  if (t0 === null || t0Pool === null) {
    const reasons = candidates.length === 0
      ? ["no qualifying pool against a quote asset within the search window"]
      : ["no qualifying pool holds liquidity within the search window"];
    if (provenance !== "creation-tx") {
      reasons.push("deployer: created by a factory or internally, deployer is can't tell");
    }
    return {
      deploymentBlock,
      deployer,
      deployerProvenance: provenance,
      t0: null,
      t0Pool: null,
      blocksToT0: null,
      status: "no-pool",
      reasons: Object.freeze(reasons),
      variants: Object.freeze(FEATURE_W_VALUES.map(noPoolVariant)),
    };
  }
  const finalPool: PoolCandidate = t0Pool;
  const variants: VariantFeatures[] = [];
  for (const window of FEATURE_W_VALUES) {
    variants.push(
      await readVariant(
        rpc,
        input.token,
        deploymentBlock,
        deployer,
        finalPool,
        poolAddresses,
        quotes,
        decimalsCache,
        window,
        t0,
        head,
        input,
        state,
      ),
    );
    if (deadlineExceeded(input)) {
      break;
    }
  }
  const reasons: string[] = [];
  if (provenance !== "creation-tx") {
    reasons.push("deployer: created by a factory or internally, deployer is can't tell");
  }
  for (const variant of variants) {
    reasons.push(...variantReasons(variant));
  }
  const complete = variants.length === FEATURE_W_VALUES.length && reasons.length === 0;
  return {
    deploymentBlock,
    deployer,
    deployerProvenance: provenance,
    t0,
    t0Pool: Object.freeze({ kind: finalPool.kind, dex: finalPool.dex }),
    blocksToT0: t0 - deploymentBlock,
    status: complete ? "ok" : "partial",
    reasons: Object.freeze(reasons),
    variants: Object.freeze(variants),
  };
}
