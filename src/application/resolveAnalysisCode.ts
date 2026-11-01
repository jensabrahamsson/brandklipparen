// Resolved analysis code shared by analyzeToken and the code routes
// (C-4, F-6): one resolution path for the scored implementation. Reads the
// entry code, resolves the proxy on the pinned block through RpcPort, then
// fetches the implementation code when resolution yields one. An unreadable
// implementation degrades to the entry bytecode, matching analyzeToken.
// This module performs no I/O of its own; every external call goes through
// the port, and the module imports solely domain and ports.
import { noneProxyResolution } from "../domain/proxy.ts";
import type { ProxyResolution } from "../domain/proxy.ts";
import { err, ok } from "../domain/result.ts";
import type { Result } from "../domain/result.ts";
import { CodeHash } from "../domain/types.ts";
import type {
  Address as AddressType,
  BlockNumber as BlockNumberType,
  Bytecode as BytecodeType,
  CodeHash as CodeHashType,
  DomainError,
  RequestId as RequestIdType,
  Timestamp as TimestampType,
} from "../domain/types.ts";
import type { CallContext, RpcError, RpcPort } from "../ports/rpc.ts";
import { resolveProxy } from "./resolveProxy.ts";

export type ResolveAnalysisCodePorts = {
  readonly rpc: RpcPort;
};

export type ResolveAnalysisCodeInput = {
  readonly address: AddressType;
  readonly block: BlockNumberType | "latest";
  readonly requestId: RequestIdType;
  readonly deadline: TimestampType;
  readonly maxDepth?: number | undefined;
};

export type ResolveAnalysisCodeSuccess = {
  readonly bytecode: BytecodeType;
  readonly codeHash: CodeHashType;
  readonly codeAddress: AddressType;
  readonly proxy: ProxyResolution;
  readonly block: BlockNumberType;
};

export type ResolveAnalysisCodeError =
  | { readonly kind: "no-contract"; readonly target: AddressType; readonly block: BlockNumberType }
  | { readonly kind: "rpc-error"; readonly requestId: RequestIdType; readonly error: RpcError }
  | { readonly kind: "domain-error"; readonly requestId: RequestIdType; readonly error: DomainError };

// Implementation address behind a resolved proxy: the EIP-1967 or UUPS
// implementation, the EIP-1167 target or the EIP-7702 delegation, or null
// when the address holds no recognised proxy pointer.
export function implementationOfProxy(proxy: ProxyResolution): AddressType | null {
  switch (proxy.kind) {
    case "eip1967":
      return proxy.implementation;
    case "zos":
      return proxy.implementation;
    case "uups":
      return proxy.implementation;
    case "eip1167":
      return proxy.target;
    case "eip7702":
      return proxy.delegation;
    case "none":
      return null;
  }
}

export async function resolveAnalysisCode(
  ports: ResolveAnalysisCodePorts,
  input: ResolveAnalysisCodeInput,
): Promise<Result<ResolveAnalysisCodeSuccess, ResolveAnalysisCodeError>> {
  const preCtx: CallContext = { requestId: input.requestId, deadline: input.deadline, block: input.block };
  let block: BlockNumberType;
  if (input.block === "latest") {
    const head = await ports.rpc.getBlockNumber(preCtx);
    if (!head.ok) {
      return err({ kind: "rpc-error", requestId: input.requestId, error: head.error });
    }
    block = head.value;
  } else {
    block = input.block;
  }
  const blockCtx: CallContext = { requestId: input.requestId, deadline: input.deadline, block };
  const fetched = await ports.rpc.getCode(input.address, blockCtx);
  if (!fetched.ok) {
    if (fetched.error.kind === "no-code") {
      return err({ kind: "no-contract", target: input.address, block });
    }
    return err({ kind: "rpc-error", requestId: input.requestId, error: fetched.error });
  }
  const resolved = await resolveProxy(ports, {
    address: input.address,
    block,
    requestId: input.requestId,
    deadline: input.deadline,
    ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
  });
  const proxy: ProxyResolution = resolved.ok ? resolved.value.resolution : noneProxyResolution();
  const implementation = implementationOfProxy(proxy);
  let bytecode = fetched.value.bytecode;
  let codeAddress = input.address;
  if (implementation !== null) {
    const implFetched = await ports.rpc.getCode(implementation, blockCtx);
    if (implFetched.ok) {
      bytecode = implFetched.value.bytecode;
      codeAddress = implementation;
    }
  }
  const codeHash = CodeHash.of(bytecode);
  if (!codeHash.ok) {
    return err({ kind: "domain-error", requestId: input.requestId, error: codeHash.error });
  }
  return ok({ bytecode, codeHash: codeHash.value, codeAddress, proxy, block });
}
