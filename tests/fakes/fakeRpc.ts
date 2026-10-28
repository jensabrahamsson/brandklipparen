// Fake RpcPort for tests (A-23, K-001): in-memory bytecode map with call counts.
// The fake returns the configured bytecode for known checksummed addresses and
// the typed no-code branch otherwise, so tests verify validation happens before
// any port call and cache behaviour without network access.
import { err, ok } from "../../src/domain/result.ts";
import type { Result } from "../../src/domain/result.ts";
import { Bytecode, StorageWord } from "../../src/domain/types.ts";
import type {
  Address as AddressType,
  BlockNumber as BlockNumberType,
  CallData as CallDataType,
  Slot as SlotType,
  StorageWord as StorageWordType,
} from "../../src/domain/types.ts";
import type {
  BytecodeResult,
  CallContext,
  RpcError,
  RpcPort,
} from "../../src/ports/rpc.ts";

export class FakeRpcAdapter implements RpcPort {
  readonly getCodeCalls: string[] = [];
  readonly getStorageAtCalls: Array<{ address: string; slot: string }> = [];
  getBlockNumberCalls = 0;

  private readonly codes: ReadonlyMap<string, string>;
  private readonly headBlock: BlockNumberType;
  private readonly storage: ReadonlyMap<string, ReadonlyMap<string, string>>;

  constructor(
    codes: ReadonlyMap<string, string>,
    headBlock: BlockNumberType,
    storage: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(),
  ) {
    this.codes = codes;
    this.headBlock = headBlock;
    this.storage = storage;
  }

  async getCode(address: AddressType, ctx: CallContext): Promise<Result<BytecodeResult, RpcError>> {
    this.getCodeCalls.push(address as string);
    const raw = this.codes.get(address as string);
    if (raw === undefined) {
      return err({ kind: "no-code", message: `no code at address ${address as string}` });
    }
    const parsed = Bytecode.parse(raw);
    if (!parsed.ok) {
      return err({ kind: "invalid-response", message: parsed.error.message });
    }
    const block = ctx.block === "latest" ? this.headBlock : ctx.block;
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

  async call(): Promise<Result<CallDataType, RpcError>> {
    return err({ kind: "invalid-response", message: "fake rpc carries no call support" });
  }

  async getBlockNumber(): Promise<Result<BlockNumberType, RpcError>> {
    this.getBlockNumberCalls += 1;
    return ok(this.headBlock);
  }
}
