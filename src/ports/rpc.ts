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
  | { kind: "range-too-large"; message: string }
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
  getLogs(query: LogsQuery, ctx: CallContext): Promise<Result<readonly ChainLog[], RpcError>>;
  getBlockReceipts(block: BlockNumberType, ctx: CallContext): Promise<Result<readonly BlockReceipt[], RpcError>>;
}

// Historical log filter for eth_getLogs: optional address list, topic
// filters with per-position OR lists (null matches any), and an inclusive
// block range. Values travel as 0x hex, validated at the adapter boundary.
export type LogsQuery = {
  readonly address?: readonly string[] | undefined;
  readonly topics?: readonly (readonly string[] | null)[] | undefined;
  readonly fromBlock: BlockNumberType;
  readonly toBlock: BlockNumberType;
};

// One decoded chain log: the minimal structural view the on-chain
// features read. Hash fields stay hex strings; numbers are integers.
export type ChainLog = {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly txHash: string;
  readonly logIndex: number;
};

// One transaction receipt in a block: the sender and the created contract
// (null for non-creation), used for deployer discovery.
export type BlockReceipt = {
  readonly txHash: string;
  readonly from: string;
  readonly to: string | null;
  readonly contractAddress: string | null;
  readonly status: boolean;
};
