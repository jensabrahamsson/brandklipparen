// Fake RpcPort for tests (A-23, K-001): in-memory bytecode map with call counts.
// The fake returns the configured bytecode for known checksummed addresses and
// the typed no-code branch otherwise, so tests verify validation happens before
// any port call and cache behaviour without network access.
import { err, ok } from "../../src/domain/result.ts";
import type { Result } from "../../src/domain/result.ts";
import { Bytecode, CallData, StorageWord } from "../../src/domain/types.ts";
import type {
  Address as AddressType,
  BlockNumber as BlockNumberType,
  CallData as CallDataType,
  Slot as SlotType,
  StorageWord as StorageWordType,
} from "../../src/domain/types.ts";
import type {
  BlockReceipt,
  BytecodeResult,
  CallContext,
  ChainLog,
  LogsQuery,
  RpcError,
  RpcPort,
} from "../../src/ports/rpc.ts";

export type FakeCodeHistory = {
  readonly code: string;
  readonly fromBlock: number;
};

export class FakeRpcAdapter implements RpcPort {
  readonly getCodeCalls: string[] = [];
  readonly getStorageAtCalls: Array<{ address: string; slot: string }> = [];
  readonly getLogsCalls: LogsQuery[] = [];
  readonly getBlockReceiptsCalls: number[] = [];
  getBlockNumberCalls = 0;

  private readonly codes: ReadonlyMap<string, string>;
  private readonly headBlock: BlockNumberType;
  private readonly storage: ReadonlyMap<string, ReadonlyMap<string, string>>;
  private readonly history: ReadonlyMap<string, FakeCodeHistory>;
  private readonly logs: readonly ChainLog[];
  private readonly receipts: ReadonlyMap<number, readonly BlockReceipt[]>;

  constructor(
    codes: ReadonlyMap<string, string>,
    headBlock: BlockNumberType,
    storage: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(),
    extra: {
      readonly history?: ReadonlyMap<string, FakeCodeHistory> | undefined;
      readonly logs?: readonly ChainLog[] | undefined;
      readonly receipts?: ReadonlyMap<number, readonly BlockReceipt[]> | undefined;
      // Stubbed eth_call answers by lowercase 0x-prefixed calldata hex.
      // Absent stubs (and an absent map) answer the typed error, so
      // metadata reads stay absent unless the test provides them.
      readonly calls?: ReadonlyMap<string, string> | undefined;
    } = {},
  ) {
    this.codes = codes;
    this.headBlock = headBlock;
    this.storage = storage;
    this.history = extra.history ?? new Map();
    this.logs = extra.logs ?? [];
    this.receipts = extra.receipts ?? new Map();
    this.calls = extra.calls ?? new Map();
  }

  private readonly calls: ReadonlyMap<string, string>;

  async getCode(address: AddressType, ctx: CallContext): Promise<Result<BytecodeResult, RpcError>> {
    this.getCodeCalls.push(address as string);
    const block = ctx.block === "latest" ? this.headBlock : ctx.block;
    const history = this.history.get(address as string);
    if (history !== undefined && (block as number) < history.fromBlock) {
      return err({ kind: "no-code", message: `no code at address ${address as string}` });
    }
    const raw = history?.code ?? this.codes.get(address as string);
    if (raw === undefined) {
      return err({ kind: "no-code", message: `no code at address ${address as string}` });
    }
    const parsed = Bytecode.parse(raw);
    if (!parsed.ok) {
      return err({ kind: "invalid-response", message: parsed.error.message });
    }
    return ok({ bytecode: parsed.value, block });
  }

  async getStorageAt(
    address: AddressType,
    slot: SlotType,
  ): Promise<Result<StorageWordType, RpcError>> {
    this.getStorageAtCalls.push({ address: address as string, slot: slot as string });
    // Unwritten slots read as zero, matching chain behaviour; configured
    // entries replay their frozen word.
    const raw =
      this.storage.get(address as string)?.get((slot as string).toLowerCase()) ??
      `0x${"0".repeat(64)}`;
    const parsed = StorageWord.parse(raw);
    if (!parsed.ok) {
      return err({ kind: "invalid-response", message: parsed.error.message });
    }
    return ok(parsed.value);
  }

  async call(
    to: AddressType,
    data: CallDataType,
    ctx: CallContext,
  ): Promise<Result<CallDataType, RpcError>> {
    void to;
    void ctx;
    const key = `0x${Buffer.from(data).toString("hex").toLowerCase()}`;
    const raw = this.calls.get(key);
    if (raw === undefined) {
      return err({ kind: "invalid-response", message: "fake rpc carries no call support" });
    }
    const parsed = CallData.parse(raw);
    if (!parsed.ok) {
      return err({ kind: "invalid-response", message: parsed.error.message });
    }
    return ok(parsed.value);
  }

  async getBlockNumber(): Promise<Result<BlockNumberType, RpcError>> {
    this.getBlockNumberCalls += 1;
    return ok(this.headBlock);
  }

  async getLogs(query: LogsQuery): Promise<Result<readonly ChainLog[], RpcError>> {
    this.getLogsCalls.push(query);
    const from = query.fromBlock as number;
    const to = query.toBlock as number;
    const addresses = query.address === undefined ? null : new Set(query.address.map((entry) => entry.toLowerCase()));
    const filtered = this.logs.filter((log) => {
      if (log.blockNumber < from || log.blockNumber > to) {
        return false;
      }
      if (addresses !== null && !addresses.has(log.address.toLowerCase())) {
        return false;
      }
      const wanted = query.topics ?? [];
      for (let index = 0; index < wanted.length; index += 1) {
        const position = wanted[index];
        if (position === null || position === undefined) {
          continue;
        }
        if (!position.map((entry) => entry.toLowerCase()).includes((log.topics[index] ?? "").toLowerCase())) {
          return false;
        }
      }
      return true;
    });
    return ok(Object.freeze(filtered.slice()));
  }

  async getBlockReceipts(block: BlockNumberType): Promise<Result<readonly BlockReceipt[], RpcError>> {
    this.getBlockReceiptsCalls.push(block as number);
    return ok(this.receipts.get(block as number) ?? Object.freeze([]));
  }
}
