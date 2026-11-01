// JSON-RPC adapter behind RpcPort (S-005, K-001, K-503, K-511).
// The adapter speaks eth_getCode at a pinned block plus the block lookup
// the application service requires (eth_blockNumber), with storage and
// call reads on the same pipeline for later stories. The transport is
// injected, so tests replay recorded fixtures and never touch the network;
// production passes the fetch-based transport. RPC URL and key travel
// solely as a SecretString from the validated configuration and never
// appear in errors or logs: every error message names the method only.
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import { BlockNumber, Bytecode, CallData, StorageWord } from "../../domain/types.ts";
import type {
  Address as AddressType,
  BlockNumber as BlockNumberType,
  Bytecode as BytecodeType,
  CallData as CallDataType,
  Slot as SlotType,
  StorageWord as StorageWordType,
} from "../../domain/types.ts";
import type { ConfigError, SecretString } from "../../ports/config.ts";
import type {
  BlockReceipt,
  BytecodeResult,
  CallContext,
  ChainLog,
  LogsQuery,
  RpcError,
  RpcLimits,
  RpcPort,
} from "../../ports/rpc.ts";
import { SafeFetchError, safeFetchText } from "../http/safeFetch.ts";

// Single JSON-RPC round trip over an injected byte channel. The signal
// aborts the underlying request on timeout; transports that ignore the
// signal are still bounded by the adapter's timeout race.
export type RpcTransportResponse = {
  readonly status: number;
  readonly bodyText: string;
};

export type RpcTransport = (
  url: string,
  body: string,
  signal: AbortSignal,
) => Promise<RpcTransportResponse>;

// Production transport over the built-in fetch of Node (C-24, F-28). The URL
// (which may carry the provider key) is used solely as the request target
// and is never logged or copied into errors. The bounded fetch refuses
// redirects, streams the reply through the adapter cap instead of buffering
// it whole, and combines the caller signal with its own deadline.
export async function fetchRpcTransport(
  url: string,
  body: string,
  signal: AbortSignal,
): Promise<RpcTransportResponse> {
  return safeFetchText(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    timeoutMs: DEFAULT_RPC_TIMEOUT_MS,
    maxBytes: DEFAULT_RPC_MAX_RESPONSE_BYTES,
    signal,
  });
}

// Placeholder operational limits for tests and offline use (A-17, I-11).
// Production passes the versioned values from the validated configuration
// through createRpcAdapterFromConfig; the adapter never invents its own.
export const DEFAULT_RPC_TIMEOUT_MS = 10000;
export const DEFAULT_RPC_MAX_RESPONSE_BYTES = 1048576;

export function resolveRpcTimeoutMs(value: number | undefined): number {
  return value ?? DEFAULT_RPC_TIMEOUT_MS;
}

export function resolveRpcMaxResponseBytes(value: number | undefined): number {
  return value ?? DEFAULT_RPC_MAX_RESPONSE_BYTES;
}

export type JsonRpcAdapterOptions = {
  readonly endpoint: SecretString;
  readonly timeoutMs?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
  readonly transport?: RpcTransport | undefined;
  // SEC-1 S-3: when set to a positive interval, eth_chainId is
  // re-checked lazily at most once per interval before a call and a
  // non-mainnet answer fails the call closed. Unset disables the
  // periodic re-check (the startup check in main still runs).
  readonly chainRecheckIntervalMs?: number | undefined;
  readonly nowMs?: (() => number) | undefined;
};

export const DEFAULT_CHAIN_RECHECK_INTERVAL_MS = 10 * 60_000;

const RPC_URLS_VARIABLE = "BRANDKLIPPAREN_RPC_URLS";

// The subset of the validated configuration the adapter reads (K-503,
// M-07). Optional fields accept an explicit undefined, so a missing value
// in a partial test configuration maps to the typed startup error below.
export type RpcAdapterConfig = {
  readonly rpcUrls: readonly SecretString[] | undefined;
  readonly rpcDeadlineMs: number | undefined;
  readonly rpcMaxResponseBytes: number | undefined;
  readonly chainRecheckIntervalMs?: number | undefined;
  readonly nowMs?: (() => number) | undefined;
};

// The RPC endpoint comes solely from the validated configuration (K-503,
// M-07): the first allowlisted URL. User input becomes address, slot and
// call-data values in the request body and never the request target.
// Chain id the process requires (S-108, K-001): Ethereum mainnet only,
// verified once against the live endpoint at startup.
export const REQUIRED_MAINNET_CHAIN_ID = "0x1";

export type ChainIdVerificationError =
  | { kind: "chain-mismatch"; message: string }
  | { kind: "unavailable"; message: string };

// Startup chain check (S-108): one `eth_chainId` round trip over the
// injected transport, requiring exactly `0x1`. Any other answer, or a
// failed round trip, fails typed so the process blocks before serving.
// The endpoint URL travels only as the request target, never into errors.
export async function verifyMainnetChainId(
  url: string,
  transport: RpcTransport,
  timeoutMs: number,
): Promise<Result<null, ChainIdVerificationError>> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  let response: RpcTransportResponse;
  try {
    response = await transport(url, body, controller.signal);
  } catch {
    clearTimeout(deadline);
    return err({ kind: "unavailable", message: "the chain id check could not reach the endpoint" });
  }
  clearTimeout(deadline);
  if (response.status === 429) {
    return err({ kind: "unavailable", message: "the chain id check was rate limited" });
  }
  if (response.status < 200 || response.status >= 300) {
    return err({ kind: "unavailable", message: "the chain id check received an error status" });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.bodyText) as unknown;
  } catch {
    return err({ kind: "unavailable", message: "the chain id check received no JSON document" });
  }
  const result =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)["result"]
      : undefined;
  if (typeof result !== "string" || result.toLowerCase() !== REQUIRED_MAINNET_CHAIN_ID) {
    return err({ kind: "chain-mismatch", message: "the endpoint is not Ethereum mainnet" });
  }
  return ok(null);
}

export function createRpcAdapterFromConfig(
  config: RpcAdapterConfig,
  transport?: RpcTransport | undefined,
): Result<JsonRpcAdapter, ConfigError> {
  const urls = config.rpcUrls;
  if (urls === undefined || urls.length === 0) {
    return err({ kind: "missing-variable", variable: RPC_URLS_VARIABLE });
  }
  const first = urls[0];
  if (first === undefined) {
    return err({ kind: "missing-variable", variable: RPC_URLS_VARIABLE });
  }
  return ok(
    new JsonRpcAdapter({
      endpoint: first,
      timeoutMs: config.rpcDeadlineMs,
      maxResponseBytes: config.rpcMaxResponseBytes,
      transport,
      chainRecheckIntervalMs: config.chainRecheckIntervalMs,
      nowMs: config.nowMs,
    }),
  );
}

function recordOf(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  return raw as Record<string, unknown>;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function bytesToHex(bytes: Uint8Array): string {
  const digits = "0123456789abcdef";
  let out = "";
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    out += (digits[(byte >> 4) & 15] ?? "0") + (digits[byte & 15] ?? "0");
  }
  return out;
}

function blockParam(block: BlockNumberType | "latest"): string {
  if (block === "latest") {
    return "latest";
  }
  return `0x${(block as number).toString(16)}`;
}

function invalidResponse(method: string, reason: string): RpcError {
  return { kind: "invalid-response", message: `rpc response for ${method} ${reason}` };
}

// Range errors name the range, the limit or too many blocks; anything
// else stays a plain node error. The driver halves its chunk size solely
// on this kind, so the match stays narrow.
function isRangeError(raw: unknown): boolean {
  const record = recordOf(raw);
  if (record === null) {
    return false;
  }
  const message = record["message"];
  if (typeof message !== "string") {
    return false;
  }
  return /block range|range too|too many blocks|exceeds.*range|range.*exceed|query limit/i.test(message);
}

function parseQuantity(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]+$/.test(raw)) {
    return null;
  }
  const value = Number.parseInt(raw, 16);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Validated chain log: every field keeps its hex shape and block and log
// indexes become integers. Anything else is a malformed log.
function parseChainLog(raw: unknown): ChainLog | null {
  const record = recordOf(raw);
  if (record === null) {
    return null;
  }
  const address = record["address"];
  const topics = record["topics"];
  const data = record["data"];
  const blockNumber = parseQuantity(record["blockNumber"]);
  const logIndex = parseQuantity(record["logIndex"]);
  const txHash = record["transactionHash"];
  const blockHash = record["blockHash"];
  if (
    typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address) ||
    !Array.isArray(topics) || !topics.every((topic) => typeof topic === "string" && /^0x[0-9a-fA-F]{64}$/.test(topic)) ||
    typeof data !== "string" || !/^0x[0-9a-fA-F]*$/.test(data) ||
    blockNumber === null || logIndex === null ||
    typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash) ||
    typeof blockHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(blockHash)
  ) {
    return null;
  }
  return Object.freeze({
    address: address.toLowerCase(),
    topics: Object.freeze(topics.map((topic) => (topic as string).toLowerCase())),
    data: (data as string).toLowerCase(),
    blockNumber,
    blockHash: (blockHash as string).toLowerCase(),
    txHash: (txHash as string).toLowerCase(),
    logIndex,
  });
}

// Validated block receipt: the sender, the recipient (null for creation)
// and the created contract (null unless this receipt created one).
function parseBlockReceipt(raw: unknown): BlockReceipt | null {
  const record = recordOf(raw);
  if (record === null) {
    return null;
  }
  const txHash = record["transactionHash"];
  const from = record["from"];
  const to = record["to"];
  const created = record["contractAddress"];
  const status = record["status"];
  if (
    typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash) ||
    typeof from !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(from) ||
    (to !== null && (typeof to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(to))) ||
    (created !== null && (typeof created !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(created))) ||
    typeof status !== "string" || !/^0x[0-9a-fA-F]+$/.test(status)
  ) {
    return null;
  }
  return Object.freeze({
    txHash: txHash.toLowerCase(),
    from: from.toLowerCase(),
    to: to === null ? null : (to as string).toLowerCase(),
    contractAddress: created === null ? null : (created as string).toLowerCase(),
    status: (status as string).toLowerCase() !== "0x0",
  });
}

// Module-private timeout marker: only the adapter's own timeout race
// produces it, so a transport failure never maps to a timeout by accident.
class RpcTimeout {
  readonly marker = "rpc-timeout";
}

export class JsonRpcAdapter implements RpcPort {
  private readonly endpoint: SecretString;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly transport: RpcTransport;
  private readonly chainRecheckIntervalMs: number;
  private readonly nowMs: () => number;
  private lastChainVerifiedAtMs: number | null = null;
  private nextId = 1;

  constructor(options: JsonRpcAdapterOptions) {
    this.endpoint = options.endpoint;
    this.timeoutMs = resolveRpcTimeoutMs(options.timeoutMs);
    this.maxResponseBytes = resolveRpcMaxResponseBytes(options.maxResponseBytes);
    this.transport = options.transport ?? fetchRpcTransport;
    this.chainRecheckIntervalMs =
      options.chainRecheckIntervalMs !== undefined &&
      Number.isSafeInteger(options.chainRecheckIntervalMs) &&
      options.chainRecheckIntervalMs > 0
        ? options.chainRecheckIntervalMs
        : 0;
    this.nowMs = options.nowMs ?? Date.now;
  }

  // Periodic mainnet re-check (S-3): at most one eth_chainId round
  // trip per interval, cached between calls. A failed or non-mainnet
  // answer fails closed with a typed error and no call is sent.
  private async ensureMainnet(method: string): Promise<Result<null, RpcError>> {
    if (this.chainRecheckIntervalMs <= 0) {
      return ok(null);
    }
    const now = this.nowMs();
    if (
      this.lastChainVerifiedAtMs !== null &&
      now - this.lastChainVerifiedAtMs < this.chainRecheckIntervalMs
    ) {
      return ok(null);
    }
    const allowed = this.allowlistedUrl(method);
    if (!allowed.ok) {
      return allowed;
    }
    const verified = await verifyMainnetChainId(allowed.value, this.transport, this.timeoutMs);
    if (!verified.ok) {
      this.lastChainVerifiedAtMs = null;
      return err({
        kind: "node-error",
        message:
          verified.error.kind === "chain-mismatch"
            ? `rpc call ${method} blocked: the endpoint is not Ethereum mainnet`
            : `rpc call ${method} blocked: the chain id re-check could not reach the endpoint`,
      });
    }
    this.lastChainVerifiedAtMs = this.nowMs();
    return ok(null);
  }

  limits(): RpcLimits {
    return {
      deadlineMs: this.timeoutMs,
      maxBytesIn: this.maxResponseBytes,
      maxBytesOut: this.maxResponseBytes,
      maxConcurrency: 1,
      retryBudget: 0,
    };
  }

  async getCode(address: AddressType, ctx: CallContext): Promise<Result<BytecodeResult, RpcError>> {
    const pinned = await this.pinnedBlock(ctx);
    if (!pinned.ok) {
      return pinned;
    }
    const block = pinned.value;
    const fetched = await this.callMethod(
      "eth_getCode",
      [address as string, blockParam(block)],
      ctx,
      (result): Result<BytecodeType, RpcError> => {
        if (typeof result !== "string") {
          return err(invalidResponse("eth_getCode", "holds no hex result"));
        }
        const parsed = Bytecode.parse(result);
        if (!parsed.ok) {
          return err(invalidResponse("eth_getCode", "holds no valid bytecode"));
        }
        return ok(parsed.value);
      },
    );
    if (!fetched.ok) {
      return fetched;
    }
    if (fetched.value.length === 0) {
      return err({ kind: "no-code", message: `no contract code at address ${address as string}` });
    }
    return ok({ bytecode: fetched.value, block });
  }

  async getStorageAt(
    address: AddressType,
    slot: SlotType,
    ctx: CallContext,
  ): Promise<Result<StorageWordType, RpcError>> {
    const pinned = await this.pinnedBlock(ctx);
    if (!pinned.ok) {
      return pinned;
    }
    return this.callMethod(
      "eth_getStorageAt",
      [address as string, slot as string, blockParam(pinned.value)],
      ctx,
      (result): Result<StorageWordType, RpcError> => {
        if (typeof result !== "string") {
          return err(invalidResponse("eth_getStorageAt", "holds no hex result"));
        }
        const parsed = StorageWord.parse(result);
        if (!parsed.ok) {
          return err(invalidResponse("eth_getStorageAt", "holds no valid storage word"));
        }
        return ok(parsed.value);
      },
    );
  }

  async call(
    to: AddressType,
    data: CallDataType,
    ctx: CallContext,
  ): Promise<Result<CallDataType, RpcError>> {
    const pinned = await this.pinnedBlock(ctx);
    if (!pinned.ok) {
      return pinned;
    }
    return this.callMethod(
      "eth_call",
      [{ to: to as string, data: `0x${bytesToHex(data)}` }, blockParam(pinned.value)],
      ctx,
      (result): Result<CallDataType, RpcError> => {
        if (typeof result !== "string") {
          return err(invalidResponse("eth_call", "holds no hex result"));
        }
        const parsed = CallData.parse(result);
        if (!parsed.ok) {
          return err(invalidResponse("eth_call", "holds no valid call data"));
        }
        return ok(parsed.value);
      },
    );
  }

  async getBlockNumber(ctx: CallContext): Promise<Result<BlockNumberType, RpcError>> {
    return this.callMethod("eth_blockNumber", [], ctx, (result): Result<
      BlockNumberType,
      RpcError
    > => {
      if (typeof result !== "string" || !/^0x[0-9a-fA-F]+$/.test(result)) {
        return err(invalidResponse("eth_blockNumber", "holds no hex quantity"));
      }
      const parsed = BlockNumber.of(Number.parseInt(result, 16));
      if (!parsed.ok) {
        return err(invalidResponse("eth_blockNumber", "holds no valid block number"));
      }
      return ok(parsed.value);
    });
  }

  async getLogs(query: LogsQuery, ctx: CallContext): Promise<Result<readonly ChainLog[], RpcError>> {
    const filter: Record<string, unknown> = {
      fromBlock: blockParam(query.fromBlock),
      toBlock: blockParam(query.toBlock),
    };
    if (query.address !== undefined) {
      filter["address"] = query.address;
    }
    if (query.topics !== undefined) {
      filter["topics"] = query.topics.map((position) => (position === null ? null : [...position]));
    }
    return this.callMethod("eth_getLogs", [filter], ctx, (result): Result<readonly ChainLog[], RpcError> => {
      if (!Array.isArray(result)) {
        return err(invalidResponse("eth_getLogs", "holds no log array"));
      }
      const out: ChainLog[] = [];
      for (const entry of result) {
        const parsed = parseChainLog(entry);
        if (parsed === null) {
          return err(invalidResponse("eth_getLogs", "holds a malformed log"));
        }
        out.push(parsed);
      }
      return ok(Object.freeze(out));
    });
  }

  async getBlockReceipts(
    block: BlockNumberType,
    ctx: CallContext,
  ): Promise<Result<readonly BlockReceipt[], RpcError>> {
    const direct = await this.callMethod(
      "eth_getBlockReceipts",
      [blockParam(block)],
      ctx,
      (result): Result<readonly BlockReceipt[], RpcError> => {
        if (!Array.isArray(result)) {
          return err(invalidResponse("eth_getBlockReceipts", "holds no receipt array"));
        }
        const out: BlockReceipt[] = [];
        for (const entry of result) {
          const parsed = parseBlockReceipt(entry);
          if (parsed === null) {
            return err(invalidResponse("eth_getBlockReceipts", "holds a malformed receipt"));
          }
          out.push(parsed);
        }
        return ok(Object.freeze(out));
      },
    );
    if (direct.ok) {
      return direct;
    }
    if (direct.error.kind !== "node-error") {
      return direct;
    }
    return this.creationReceiptsFallback(block, ctx);
  }

  // Fallback for endpoints without eth_getBlockReceipts: list the block's
  // transactions once and fetch receipts solely for top-level creations
  // (to is null). A token created by a factory internally carries no
  // top-level creation receipt, so an empty match honestly reports no
  // direct creator instead of guessing one.
  private async creationReceiptsFallback(
    block: BlockNumberType,
    ctx: CallContext,
  ): Promise<Result<readonly BlockReceipt[], RpcError>> {
    const fetched = await this.callMethod(
      "eth_getBlockByNumber",
      [blockParam(block), true],
      ctx,
      (result): Result<readonly { hash: string; to: string | null }[], RpcError> => {
        const record = recordOf(result);
        if (record === null) {
          return err(invalidResponse("eth_getBlockByNumber", "holds no block"));
        }
        const rawTxs = record["transactions"];
        if (!Array.isArray(rawTxs)) {
          return err(invalidResponse("eth_getBlockByNumber", "holds no transaction list"));
        }
        const out: { hash: string; to: string | null }[] = [];
        for (const raw of rawTxs) {
          const tx = recordOf(raw);
          if (tx === null || typeof tx["hash"] !== "string") {
            return err(invalidResponse("eth_getBlockByNumber", "holds a malformed transaction"));
          }
          const to = tx["to"];
          out.push({ hash: tx["hash"], to: typeof to === "string" ? to : null });
        }
        return ok(out);
      },
    );
    if (!fetched.ok) {
      return fetched;
    }
    const creations = fetched.value.filter((tx) => tx.to === null);
    const out: BlockReceipt[] = [];
    for (const tx of creations) {
      const receipt = await this.callMethod(
        "eth_getTransactionReceipt",
        [tx.hash],
        ctx,
        (result): Result<BlockReceipt | null, RpcError> => {
          if (result === null) {
            return ok(null);
          }
          const parsed = parseBlockReceipt(result);
          if (parsed === null) {
            return err(invalidResponse("eth_getTransactionReceipt", "holds a malformed receipt"));
          }
          return ok(parsed);
        },
      );
      if (!receipt.ok) {
        return receipt;
      }
      if (receipt.value !== null) {
        out.push(receipt.value);
      }
    }
    return ok(Object.freeze(out));
  }

  // A "latest" context pins the current head block first, so every
  // bytecode read binds to a concrete block number (K-102). A concrete
  // context passes through with zero extra calls.
  private async pinnedBlock(ctx: CallContext): Promise<Result<BlockNumberType, RpcError>> {
    if (ctx.block !== "latest") {
      return ok(ctx.block);
    }
    return this.getBlockNumber(ctx);
  }

  private effectiveTimeoutMs(ctx: CallContext): Result<number, RpcError> {
    const remaining = (ctx.deadline as number) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      return err({ kind: "timeout", message: "rpc call deadline already passed" });
    }
    return ok(Math.min(this.timeoutMs, Math.floor(remaining)));
  }

  // Call-time allowlist guard (K-503, M-07): the request target comes
  // solely from the validated configuration, so an adapter constructed
  // with a non-https endpoint fails with a typed error before any byte
  // leaves the process. The endpoint value never enters the error text.
  private allowlistedUrl(method: string): Result<string, RpcError> {
    const url = this.endpoint.reveal();
    if (!url.startsWith("https://")) {
      return err({ kind: "node-error", message: `rpc call ${method} target is outside the allowlist` });
    }
    return ok(url);
  }

  private async invoke(
    method: string,
    params: readonly unknown[],
    ctx: CallContext,
  ): Promise<Result<{ id: number; response: RpcTransportResponse }, RpcError>> {
    if (method !== "eth_chainId") {
      const chain = await this.ensureMainnet(method);
      if (!chain.ok) {
        return chain;
      }
    }
    const timeout = this.effectiveTimeoutMs(ctx);
    if (!timeout.ok) {
      return timeout;
    }
    const id = this.nextId;
    this.nextId += 1;
    const allowed = this.allowlistedUrl(method);
    if (!allowed.ok) {
      return allowed;
    }
    const url = allowed.value;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = this.transport(url, body, controller.signal);
      const onTimeout = new Promise<RpcTransportResponse>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new RpcTimeout());
        }, timeout.value);
      });
      const response = await Promise.race([pending, onTimeout]);
      return ok({ id, response });
    } catch (error) {
      // The bounded production transport reports its own deadline as a
      // timeout kind; without this branch a slow body would surface as a
      // node error instead of the timeout the caller contracted.
      if (
        error instanceof RpcTimeout ||
        controller.signal.aborted ||
        (error instanceof SafeFetchError && error.kind === "timeout")
      ) {
        return err({ kind: "timeout", message: `rpc call ${method} timed out` });
      }
      return err({ kind: "node-error", message: `rpc call ${method} failed` });
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private async callMethod<T>(
    method: string,
    params: readonly unknown[],
    ctx: CallContext,
    validate: (result: unknown) => Result<T, RpcError>,
  ): Promise<Result<T, RpcError>> {
    const sent = await this.invoke(method, params, ctx);
    if (!sent.ok) {
      return sent;
    }
    const { id, response } = sent.value;
    if (response.status === 429) {
      return err({ kind: "rate-limited", message: `rpc call ${method} was rate limited` });
    }
    if (response.status < 200 || response.status >= 300) {
      return err({ kind: "node-error", message: `rpc call ${method} failed` });
    }
    if (byteLength(response.bodyText) > this.maxResponseBytes) {
      return err(invalidResponse(method, "exceeded the response size limit"));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.bodyText) as unknown;
    } catch {
      return err(invalidResponse(method, "was not valid JSON-RPC"));
    }
    const record = recordOf(parsed);
    if (record === null || record["jsonrpc"] !== "2.0" || record["id"] !== id) {
      return err(invalidResponse(method, "carries a mismatched envelope"));
    }
    if (record["error"] !== undefined) {
      if (isRangeError(record["error"])) {
        return err({ kind: "range-too-large", message: `rpc call ${method} exceeded the log range` });
      }
      return err({ kind: "node-error", message: `rpc call ${method} failed` });
    }
    if (!("result" in record)) {
      return err(invalidResponse(method, "holds no result"));
    }
    return validate(record["result"]);
  }
}
