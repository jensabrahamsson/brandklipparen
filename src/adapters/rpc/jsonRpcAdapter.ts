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
  BytecodeResult,
  CallContext,
  RpcError,
  RpcLimits,
  RpcPort,
} from "../../ports/rpc.ts";

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

// Production transport over the built-in fetch of Node. The URL (which may
// carry the provider key) is used solely as the request target and is never
// logged or copied into errors.
export async function fetchRpcTransport(
  url: string,
  body: string,
  signal: AbortSignal,
): Promise<RpcTransportResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal,
  });
  return { status: response.status, bodyText: await response.text() };
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
};

const RPC_URLS_VARIABLE = "BRANDKLIPPAREN_RPC_URLS";

// The subset of the validated configuration the adapter reads (K-503,
// M-07). Optional fields accept an explicit undefined, so a missing value
// in a partial test configuration maps to the typed startup error below.
export type RpcAdapterConfig = {
  readonly rpcUrls: readonly SecretString[] | undefined;
  readonly rpcDeadlineMs: number | undefined;
  readonly rpcMaxResponseBytes: number | undefined;
};

// The RPC endpoint comes solely from the validated configuration (K-503,
// M-07): the first allowlisted URL. User input becomes address, slot and
// call-data values in the request body and never the request target.
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
  private nextId = 1;

  constructor(options: JsonRpcAdapterOptions) {
    this.endpoint = options.endpoint;
    this.timeoutMs = resolveRpcTimeoutMs(options.timeoutMs);
    this.maxResponseBytes = resolveRpcMaxResponseBytes(options.maxResponseBytes);
    this.transport = options.transport ?? fetchRpcTransport;
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
      if (error instanceof RpcTimeout || controller.signal.aborted) {
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
      return err({ kind: "node-error", message: `rpc call ${method} failed` });
    }
    if (!("result" in record)) {
      return err(invalidResponse(method, "holds no result"));
    }
    return validate(record["result"]);
  }
}
