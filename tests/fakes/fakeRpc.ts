// Fake RpcPort for tests (A-23, K-001): in-memory bytecode map with call counts.
// The fake returns the configured bytecode for known checksummed addresses and
// the typed no-code branch otherwise, so tests verify validation happens before
// any port call and cache behaviour without network access.
import { err, ok } from "../../src/domain/result.ts";
import type { Result } from "../../src/domain/result.ts";
import { Bytecode } from "../../src/domain/types.ts";
import type {
  Address as AddressType,
  BlockNumber as BlockNumberType,
  CallData as CallDataType,
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
  getBlockNumberCalls = 0;

  constructor(
    private readonly codes: ReadonlyMap<string, string>,
    private readonly headBlock: BlockNumberType,
  ) {}

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

  async getStorageAt(): Promise<Result<StorageWordType, RpcError>> {
    return err({ kind: "invalid-response", message: "fake rpc carries no storage" });
  }

  async call(): Promise<Result<CallDataType, RpcError>> {
    return err({ kind: "invalid-response", message: "fake rpc carries no call support" });
  }

  async getBlockNumber(): Promise<Result<BlockNumberType, RpcError>> {
    this.getBlockNumberCalls += 1;
    return ok(this.headBlock);
  }
}
