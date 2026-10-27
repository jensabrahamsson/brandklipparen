// RpcPort: bytecode, storage, calls and block number against Ethereum
// mainnet (A-05, K-001, K-016, K-503, K-511). The port is owned by the core:
// the application talks solely with this interface and each adapter behind it
// validates external responses at the boundary (A-16). Error branches follow
// the catalogue in A-15; the no-code branch yields the no-contract outcome in
// the application instead of an error.
import type { Result } from "../domain/result.ts";
import type {
  Address as AddressType,
  BlockNumber as BlockNumberType,
  Bytecode as BytecodeType,
  CallData as CallDataType,
  RequestId as RequestIdType,
  Slot as SlotType,
  StorageWord as StorageWordType,
  Timestamp as TimestampType,
} from "../domain/types.ts";

// Correlation id, absolute deadline and block context per A-05.
export type CallContext = {
  readonly requestId: RequestIdType;
  readonly deadline: TimestampType;
  readonly block: BlockNumberType | "latest";
};

// Bytecode fetched for an address at the resolved block, so the response
// carries the block number for reproduction per K-102.
export type BytecodeResult = {
  readonly bytecode: BytecodeType;
  readonly block: BlockNumberType;
};

// Error union per A-15. invalid-response covers schema breaches in the node
// reply (K-511); no-code yields the no-contract branch in the application.
export type RpcError =
  | { kind: "timeout"; message: string }
  | { kind: "rate-limited"; message: string }
  | { kind: "node-error"; message: string }
  | { kind: "invalid-response"; message: string }
  | { kind: "no-code"; message: string };

// Per-port limits per A-17. Values come from the operational configuration
// (I-08, I-14); the port only names the fields.
export type RpcLimits = {
  readonly deadlineMs: number;
  readonly maxBytesIn: number;
  readonly maxBytesOut: number;
  readonly maxConcurrency: number;
  readonly retryBudget: number;
};

export interface RpcPort {
  getCode(address: AddressType, ctx: CallContext): Promise<Result<BytecodeResult, RpcError>>;
  getStorageAt(
    address: AddressType,
    slot: SlotType,
    ctx: CallContext,
  ): Promise<Result<StorageWordType, RpcError>>;
  call(
    to: AddressType,
    data: CallDataType,
    ctx: CallContext,
  ): Promise<Result<CallDataType, RpcError>>;
  getBlockNumber(ctx: CallContext): Promise<Result<BlockNumberType, RpcError>>;
}
