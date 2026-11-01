// Proxy resolution service for the shared application layer (S-006, S-007,
// K-002, K-004, K-005, K-007, A-02). Reads EIP-1967 storage slots through
// RpcPort at the pinned block, decodes them with the pure domain module,
// detects EIP-1167 minimal-proxy bytecode and EIP-7702 delegation
// designators from the fetched code, and classifies the admin and the
// upgrade authority with slot and block evidence. Proxy chains are followed
// up to a configured bound, and cycles terminate through a visited set.
// This module performs no I/O of its own; every external call goes through
// the port, and the module imports solely domain and ports.
import {
  ADMIN_SLOT,
  IMPLEMENTATION_SLOT,
  ZOS_ADMIN_SLOT,
  ZOS_IMPLEMENTATION_SLOT,
  bytecodeHasSelector,
  decodeSlotAddress,
  parseEip1167Target,
  parseEip7702Delegation,
  proxiableUUIDSelector,
  selectorOffsetInBytecode,
} from "../domain/proxy.ts";
import type {
  AdminKind,
  ProxyResolution,
  UpgradeAuthority,
} from "../domain/proxy.ts";
import { err, ok } from "../domain/result.ts";
import type { Result } from "../domain/result.ts";
import { CodeHash } from "../domain/types.ts";
import type {
  Address as AddressType,
  BlockNumber as BlockNumberType,
  Bytecode as BytecodeType,
  RequestId as RequestIdType,
  StorageWord as StorageWordType,
  Timestamp as TimestampType,
} from "../domain/types.ts";
import type { CallContext, RpcError, RpcPort } from "../ports/rpc.ts";

// Placeholder default for the proxy chain bound (K-002, K-005): the
// versioned operational configuration carries the running value and the
// application passes it as maxDepth; tests and offline use fall back to
// this default. Detection thresholds and model weights stay out of here:
// they live solely in the versioned model artifact per K-210.
export const DEFAULT_PROXY_MAX_DEPTH = 5;
const MAX_PROXY_MAX_DEPTH = 32;

export function resolveProxyMaxDepth(configured: number | undefined): number {
  if (
    configured === undefined ||
    !Number.isSafeInteger(configured) ||
    configured < 1 ||
    configured > MAX_PROXY_MAX_DEPTH
  ) {
    return DEFAULT_PROXY_MAX_DEPTH;
  }
  return configured;
}

export type ResolveProxyPorts = {
  readonly rpc: RpcPort;
};

export type ResolveProxyInput = {
  readonly address: AddressType;
  readonly block: BlockNumberType | "latest";
  readonly requestId: RequestIdType;
  readonly deadline: TimestampType;
  readonly maxDepth?: number | undefined;
};

export type ResolveProxySuccess = {
  readonly resolution: ProxyResolution;
  readonly block: BlockNumberType;
};

export type ResolveProxyError = {
  readonly kind: "rpc-error";
  readonly requestId: RequestIdType;
  readonly error: RpcError;
};

const NONE_RESOLUTION: ProxyResolution = Object.freeze({ kind: "none" });

function rpcError(
  input: ResolveProxyInput,
  error: RpcError,
): Result<ResolveProxySuccess, ResolveProxyError> {
  return err({ kind: "rpc-error", requestId: input.requestId, error });
}

export async function resolveProxy(
  ports: ResolveProxyPorts,
  input: ResolveProxyInput,
): Promise<Result<ResolveProxySuccess, ResolveProxyError>> {
  const maxDepth = resolveProxyMaxDepth(input.maxDepth);
  const baseCtx: CallContext = {
    requestId: input.requestId,
    deadline: input.deadline,
    block: input.block,
  };
  let block: BlockNumberType;
  if (input.block === "latest") {
    const head = await ports.rpc.getBlockNumber(baseCtx);
    if (!head.ok) {
      return rpcError(input, head.error);
    }
    block = head.value;
  } else {
    block = input.block;
  }
  const ctx: CallContext = { requestId: input.requestId, deadline: input.deadline, block };
  const codeCache = new Map<string, BytecodeType>();
  const visited: string[] = [];
  let current = input.address;
  let depth = 0;
  let last: ProxyResolution = NONE_RESOLUTION;

  for (;;) {
    const key = (current as string).toLowerCase();
    if (visited.includes(key) || depth > maxDepth) {
      return ok({ resolution: last, block });
    }
    visited.push(key);
    const proxyCode = await readCode(ports, codeCache, current, ctx);
    if (proxyCode === null) {
      // No code at the entry address: an EOA carries no proxy info.
      // A broken implementation pointer deeper in the chain ends the
      // walk at the last good resolution.
      return ok({ resolution: last, block });
    }
    if (proxyCode === undefined) {
      const failed = await readCodeError(ports, codeCache, current, ctx);
      if (failed !== null) {
        return rpcError(input, failed);
      }
      return ok({ resolution: last, block });
    }
    // EIP-7702 comes first: delegated EOA code carries the 0xef0100 prefix
    // with the delegation address inline, so no slot read applies.
    const delegated = parseEip7702Delegation(proxyCode);
    if (delegated !== null) {
      const targetCode = await readCode(ports, codeCache, delegated, ctx);
      if (targetCode === null || targetCode === undefined) {
        if (targetCode === undefined) {
          const failed = await readCodeError(ports, codeCache, delegated, ctx);
          if (failed !== null) {
            return rpcError(input, failed);
          }
        }
        return ok({ resolution: last, block });
      }
      const targetHash = CodeHash.of(targetCode);
      if (!targetHash.ok) {
        return ok({ resolution: last, block });
      }
      last = Object.freeze({
        kind: "eip7702",
        delegation: delegated,
        delegationCodeHash: targetHash.value,
        mutability: "changeable-by-new-authorization",
      });
      current = delegated;
      depth += 1;
      continue;
    }
    // EIP-1167 follows: the minimal-proxy bytecode embeds the fixed target
    // address inline, so no slot read applies.
    const minimalTarget = parseEip1167Target(proxyCode);
    if (minimalTarget !== null) {
      const targetCode = await readCode(ports, codeCache, minimalTarget, ctx);
      if (targetCode === null || targetCode === undefined) {
        if (targetCode === undefined) {
          const failed = await readCodeError(ports, codeCache, minimalTarget, ctx);
          if (failed !== null) {
            return rpcError(input, failed);
          }
        }
        return ok({ resolution: last, block });
      }
      const targetHash = CodeHash.of(targetCode);
      if (!targetHash.ok) {
        return ok({ resolution: last, block });
      }
      last = Object.freeze({
        kind: "eip1167",
        target: minimalTarget,
        targetCodeHash: targetHash.value,
        mutability: "fixed",
      });
      current = minimalTarget;
      depth += 1;
      continue;
    }
    const implWord = await ports.rpc.getStorageAt(current, IMPLEMENTATION_SLOT, ctx);
    if (!implWord.ok) {
      return rpcError(input, implWord.error);
    }
    let decoded = decodeSlotAddress(implWord.value);
    let implSlot = IMPLEMENTATION_SLOT;
    let adminSlot = ADMIN_SLOT;
    let isZos = false;
    if (decoded.kind !== "address") {
      const zosWord = await ports.rpc.getStorageAt(current, ZOS_IMPLEMENTATION_SLOT, ctx);
      if (!zosWord.ok) {
        return rpcError(input, zosWord.error);
      }
      const zosDecoded = decodeSlotAddress(zosWord.value);
      if (zosDecoded.kind !== "address") {
        return ok({ resolution: last, block });
      }
      decoded = zosDecoded;
      implSlot = ZOS_IMPLEMENTATION_SLOT;
      adminSlot = ZOS_ADMIN_SLOT;
      isZos = true;
    }
    const implementation = decoded.address;
    const implCode = await readCode(ports, codeCache, implementation, ctx);
    if (implCode === null || implCode === undefined) {
      if (implCode === undefined) {
        const failed = await readCodeError(ports, codeCache, implementation, ctx);
        if (failed !== null) {
          return rpcError(input, failed);
        }
      }
      return ok({ resolution: last, block });
    }
    const hash = CodeHash.of(implCode);
    if (!hash.ok) {
      return ok({ resolution: last, block });
    }
    const adminWord = await ports.rpc.getStorageAt(current, adminSlot, ctx);
    if (!adminWord.ok) {
      return rpcError(input, adminWord.error);
    }
    const classified = await classifyAdmin(ports, codeCache, adminWord.value, ctx);
    if (classified === undefined) {
      const decodedAdmin = decodeSlotAddress(adminWord.value);
      const holder =
        decodedAdmin.kind === "address" ? decodedAdmin.address : current;
      const failed = await readCodeError(ports, codeCache, holder, ctx);
      if (failed !== null) {
        return rpcError(input, failed);
      }
      return ok({ resolution: last, block });
    }
    const resolvedAdmin = classified;
    const selector = proxiableUUIDSelector();
    if (isZos) {
      last = Object.freeze({
        kind: "zos",
        implementation,
        implementationCodeHash: hash.value,
        implementationSlot: implSlot,
        adminSlot,
        block,
        admin: resolvedAdmin.admin,
        upgradeAuthority: resolvedAdmin.authority,
      });
    } else if (bytecodeHasSelector(proxyCode, selector) || bytecodeHasSelector(implCode, selector)) {
      const offset =
        selectorOffsetInBytecode(proxyCode, selector) ??
        selectorOffsetInBytecode(implCode, selector);
      last = Object.freeze({
        kind: "uups",
        implementation,
        implementationCodeHash: hash.value,
        implementationSlot: IMPLEMENTATION_SLOT,
        block,
        upgradeFunction: selector,
        ...(offset === null ? {} : { upgradeFunctionOffset: offset }),
        upgradeAuthority: resolvedAdmin.authority,
      });
    } else {
      last = Object.freeze({
        kind: "eip1967",
        implementation,
        implementationCodeHash: hash.value,
        implementationSlot: implSlot,
        adminSlot,
        block,
        admin: resolvedAdmin.admin,
        upgradeAuthority: resolvedAdmin.authority,
      });
    }
    current = implementation;
    depth += 1;
  }
}

// Cached code fetch: null means no code at the address, undefined means a
// typed RPC failure the caller maps through a second read. The second read
// replays from the port so the error branch is observed exactly once.
async function readCode(
  ports: ResolveProxyPorts,
  cache: Map<string, BytecodeType>,
  address: AddressType,
  ctx: CallContext,
): Promise<BytecodeType | null | undefined> {
  const key = (address as string).toLowerCase();
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const fetched = await ports.rpc.getCode(address, ctx);
  if (!fetched.ok) {
    if (fetched.error.kind === "no-code") {
      return null;
    }
    return undefined;
  }
  cache.set(key, fetched.value.bytecode);
  return fetched.value.bytecode;
}

async function readCodeError(
  ports: ResolveProxyPorts,
  _cache: Map<string, BytecodeType>,
  address: AddressType,
  ctx: CallContext,
): Promise<RpcError | null> {
  const fetched = await ports.rpc.getCode(address, ctx);
  if (fetched.ok || fetched.error.kind === "no-code") {
    return null;
  }
  return fetched.error;
}

type AdminClassification = {
  readonly admin: AdminKind;
  readonly authority: UpgradeAuthority;
};

// Admin classification through a code read at the pinned block: no code
// means an EOA holder, code means a contract holder with its code hash.
// A zero or undecodable admin word reports the zero admin with a locked
// authority. Returns undefined solely on a typed RPC failure while reading
// the admin code, so the caller can map the port error.
async function classifyAdmin(
  ports: ResolveProxyPorts,
  codeCache: Map<string, BytecodeType>,
  word: StorageWordType,
  ctx: CallContext,
): Promise<AdminClassification | undefined> {
  const decoded = decodeSlotAddress(word);
  if (decoded.kind === "empty" || decoded.kind === "garbage") {
    const admin: AdminKind = Object.freeze({ kind: "zero" });
    const authority: UpgradeAuthority = Object.freeze({ kind: "locked" });
    return { admin, authority };
  }
  const holder = decoded.address;
  const code = await readCode(ports, codeCache, holder, ctx);
  if (code === null) {
    const admin: AdminKind = Object.freeze({ kind: "eoa", address: holder });
    const authority: UpgradeAuthority = Object.freeze({ kind: "single-key", holder });
    return { admin, authority };
  }
  if (code === undefined) {
    return undefined;
  }
  const hash = CodeHash.of(code);
  if (!hash.ok) {
    const admin: AdminKind = Object.freeze({ kind: "eoa", address: holder });
    const authority: UpgradeAuthority = Object.freeze({ kind: "single-key", holder });
    return { admin, authority };
  }
  const admin: AdminKind = Object.freeze({
    kind: "contract",
    address: holder,
    codeHash: hash.value,
  });
  const authority: UpgradeAuthority = Object.freeze({
    kind: "contract",
    holder,
    codeHash: hash.value,
  });
  return { admin, authority };
}
