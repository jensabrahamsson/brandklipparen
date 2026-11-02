// Proxy resolution service for the shared application layer (S-006, S-007,
// K-002, K-004, K-005, K-007, A-02). Reads EIP-1967 storage slots through
// RpcPort at the pinned block, decodes them with the pure domain module,
// detects EIP-1167 minimal-proxy bytecode and EIP-7702 delegation
// designators from the fetched code, and classifies the admin and the
// upgrade authority with slot and block evidence. Storage slots are read
// once at the entry address only: in a delegatecall chain every hop runs
// against the entry storage, so a later hop's own storage is attacker
// controlled and never consulted. Code hops are followed solely through
// code-embedded pointers (EIP-1167, EIP-7702) with the outer admin kept,
// up to a configured bound, and cycles terminate through a visited set.
// This module performs no I/O of its own; every external call goes through
// the port, and the module imports solely domain and ports.
import {
  ADMIN_SLOT,
  BEACON_SLOT,
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
  SlotAddress,
  UpgradeAuthority,
} from "../domain/proxy.ts";
import { err, ok } from "../domain/result.ts";
import type { Result } from "../domain/result.ts";
import { extractSelectors } from "../domain/selectors.ts";
import { CallData, CodeHash, StorageWord, keccak256HexOfUtf8 } from "../domain/types.ts";
import type {
  Address as AddressType,
  BlockNumber as BlockNumberType,
  Bytecode as BytecodeType,
  CallData as CallDataType,
  CodeHash as CodeHashType,
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

// Beacon proxy entry points (C-11): `implementation()` reports the logic
// contract, `owner()` reports who can replace the beacon target.
function beaconSelectorOf(signature: string): string {
  return `0x${keccak256HexOfUtf8(signature).slice(2, 10)}`;
}
const IMPLEMENTATION_ABI_SELECTOR = beaconSelectorOf("implementation()");
const BEACON_OWNER_ABI_SELECTOR = beaconSelectorOf("owner()");

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
  const entry = input.address;

  const entryCode = await readCode(ports, codeCache, entry, ctx);
  if (entryCode === null) {
    // No code at the entry address: an EOA carries no proxy info.
    return ok({ resolution: NONE_RESOLUTION, block });
  }
  if (entryCode === undefined) {
    const failed = await readCodeError(ports, codeCache, entry, ctx);
    if (failed !== null) {
      return rpcError(input, failed);
    }
    return ok({ resolution: NONE_RESOLUTION, block });
  }
  // Code-embedded pointers come first: EIP-7702 and EIP-1167 targets live
  // in the bytecode, so no slot read applies. A chain that starts in code
  // stays in code: storage is never consulted after a code hop.
  if (parseEip7702Delegation(entryCode) !== null || parseEip1167Target(entryCode) !== null) {
    return followCodeChain(ports, codeCache, input, block, ctx, entry, entryCode, maxDepth);
  }

  // Storage slots are read once at the entry address only. Every delegate
  // hop executes against the entry storage, so the implementation's own
  // storage is attacker controlled and never consulted.
  const implWord = await ports.rpc.getStorageAt(entry, IMPLEMENTATION_SLOT, ctx);
  if (!implWord.ok) {
    return rpcError(input, implWord.error);
  }
  let decoded = decodeSlotAddress(implWord.value);
  let implSlot = IMPLEMENTATION_SLOT;
  let adminSlot = ADMIN_SLOT;
  let isZos = false;
  if (decoded.kind !== "address") {
    const zosWord = await ports.rpc.getStorageAt(entry, ZOS_IMPLEMENTATION_SLOT, ctx);
    if (!zosWord.ok) {
      return rpcError(input, zosWord.error);
    }
    const zosDecoded = decodeSlotAddress(zosWord.value);
    if (zosDecoded.kind !== "address") {
      // No implementation slot is set: the beacon slot is the last storage
      // pointer (C-11). The implementation slot wins over the beacon slot.
      const beaconWord = await ports.rpc.getStorageAt(entry, BEACON_SLOT, ctx);
      if (!beaconWord.ok) {
        return rpcError(input, beaconWord.error);
      }
      const beaconDecoded = decodeSlotAddress(beaconWord.value);
      if (beaconDecoded.kind === "address") {
        return resolveBeacon(ports, codeCache, input, block, ctx, entry, beaconDecoded.address, maxDepth);
      }
      if (entryLooksLikeUnknownProxy(entryCode)) {
        return unresolvedProxy(input, "code delegates but matches no known proxy template");
      }
      return ok({ resolution: NONE_RESOLUTION, block });
    }
    decoded = zosDecoded;
    implSlot = ZOS_IMPLEMENTATION_SLOT;
    adminSlot = ZOS_ADMIN_SLOT;
    isZos = true;
  }
  const implementation = decoded.address;
  // BK-02: a populated slot alone does not prove a proxy. Without a
  // DELEGATECALL in the entry code nothing forwards to the slot, so the
  // entry code stands as the analysis target.
  if (!containsDelegateCall(entryCode)) {
    return ok({ resolution: NONE_RESOLUTION, block });
  }
  const implCode = await readCode(ports, codeCache, implementation, ctx);
  if (implCode === null || implCode === undefined) {
    if (implCode === undefined) {
      const failed = await readCodeError(ports, codeCache, implementation, ctx);
      if (failed !== null) {
        return rpcError(input, failed);
      }
    }
    return ok({ resolution: NONE_RESOLUTION, block });
  }
  const hash = CodeHash.of(implCode);
  if (!hash.ok) {
    return ok({ resolution: NONE_RESOLUTION, block });
  }
  const adminWord = await ports.rpc.getStorageAt(entry, adminSlot, ctx);
  if (!adminWord.ok) {
    return rpcError(input, adminWord.error);
  }
  const classified = await classifyAdmin(ports, codeCache, adminWord.value, ctx);
  if (classified === undefined) {
    const decodedAdmin = decodeSlotAddress(adminWord.value);
    const holder = decodedAdmin.kind === "address" ? decodedAdmin.address : entry;
    const failed = await readCodeError(ports, codeCache, holder, ctx);
    if (failed !== null) {
      return rpcError(input, failed);
    }
    return ok({ resolution: NONE_RESOLUTION, block });
  }
  const resolvedAdmin = classified;
  const selector = proxiableUUIDSelector();
  let outer: ProxyResolution;
  if (isZos) {
    outer = Object.freeze({
      kind: "zos",
      implementation,
      implementationCodeHash: hash.value,
      implementationSlot: implSlot,
      adminSlot,
      block,
      admin: resolvedAdmin.admin,
      upgradeAuthority: resolvedAdmin.authority,
    });
  } else if (bytecodeHasSelector(entryCode, selector) || bytecodeHasSelector(implCode, selector)) {
    const offset =
      selectorOffsetInBytecode(entryCode, selector) ?? selectorOffsetInBytecode(implCode, selector);
    // A UUPS proxy without an admin word gates upgrades inside the
    // implementation itself (_authorizeUpgrade); only an admin-slot address
    // keeps its holder classification (a hybrid proxy, C-11, F-27).
    const authority: UpgradeAuthority =
      decodeSlotAddress(adminWord.value).kind === "address"
        ? resolvedAdmin.authority
        : Object.freeze({ kind: "implementation" });
    outer = Object.freeze({
      kind: "uups",
      implementation,
      implementationCodeHash: hash.value,
      implementationSlot: IMPLEMENTATION_SLOT,
      block,
      upgradeFunction: selector,
      ...(offset === null ? {} : { upgradeFunctionOffset: offset }),
      upgradeAuthority: authority,
    });
  } else {
    outer = Object.freeze({
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

  // Follow code-embedded pointers from the implementation onward. The outer
  // storage hop stays upgradeable and keeps its admin; only the effective
  // code target advances.
  return advanceThroughCodePointers(
    ports,
    codeCache,
    input,
    block,
    ctx,
    outer,
    implementation,
    implCode,
    hash.value,
    [(entry as string).toLowerCase(), (implementation as string).toLowerCase()],
    1,
    maxDepth,
  );
}

// Follow code-embedded pointers (EIP-1167, EIP-7702) from a resolved
// implementation onward. The outer storage or beacon hop keeps its kind,
// slots, admin and upgrade authority; only the effective code target
// advances. Cycles stop through the visited set, and a hop past maxDepth
// is not followed.
async function advanceThroughCodePointers(
  ports: ResolveProxyPorts,
  codeCache: Map<string, BytecodeType>,
  input: ResolveProxyInput,
  block: BlockNumberType,
  ctx: CallContext,
  outer: ProxyResolution,
  start: AddressType,
  startCode: BytecodeType,
  startHash: CodeHashType,
  visited: string[],
  depth: number,
  maxDepth: number,
): Promise<Result<ResolveProxySuccess, ResolveProxyError>> {
  let finalAddress = start;
  let finalCode = startCode;
  let finalHash = startHash;
  for (;;) {
    if (depth > maxDepth) {
      break;
    }
    const next = parseEip7702Delegation(finalCode) ?? parseEip1167Target(finalCode);
    if (next === null) {
      break;
    }
    const nextKey = (next as string).toLowerCase();
    if (visited.includes(nextKey)) {
      break;
    }
    visited.push(nextKey);
    const targetCode = await readCode(ports, codeCache, next, ctx);
    if (targetCode === null || targetCode === undefined) {
      if (targetCode === undefined) {
        const failed = await readCodeError(ports, codeCache, next, ctx);
        if (failed !== null) {
          return rpcError(input, failed);
        }
      }
      break;
    }
    const targetHash = CodeHash.of(targetCode);
    if (!targetHash.ok) {
      break;
    }
    finalAddress = next;
    finalCode = targetCode;
    finalHash = targetHash.value;
    depth += 1;
  }
  return ok({ resolution: withFinalTarget(outer, finalAddress, finalHash), block });
}

// Beacon proxy resolution (C-11, F-4): the beacon at B reports the
// implementation through `implementation()`. A failed call, a non-32-byte
// answer, a non-address or zero word, missing beacon code, or a beacon
// cycle is a typed error (never none) so the unresolved path fires. The
// beacon hop counts against maxDepth and joins the visited set; code
// pointers are followed afterwards exactly as for the storage hops.
async function resolveBeacon(
  ports: ResolveProxyPorts,
  codeCache: Map<string, BytecodeType>,
  input: ResolveProxyInput,
  block: BlockNumberType,
  ctx: CallContext,
  entry: AddressType,
  beacon: AddressType,
  maxDepth: number,
): Promise<Result<ResolveProxySuccess, ResolveProxyError>> {
  const visited: string[] = [(entry as string).toLowerCase(), (beacon as string).toLowerCase()];
  const beaconCode = await readCode(ports, codeCache, beacon, ctx);
  if (beaconCode === null) {
    return unresolvedProxy(input, "beacon has no code");
  }
  if (beaconCode === undefined) {
    const failed = await readCodeError(ports, codeCache, beacon, ctx);
    if (failed !== null) {
      return rpcError(input, failed);
    }
    return unresolvedProxy(input, "beacon code is unreadable");
  }
  const beaconHash = CodeHash.of(beaconCode);
  if (!beaconHash.ok) {
    return unresolvedProxy(input, "beacon code hash is undecodable");
  }
  const callData = CallData.parse(IMPLEMENTATION_ABI_SELECTOR);
  if (!callData.ok) {
    return unresolvedProxy(input, "implementation() calldata is unencodable");
  }
  const called = await ports.rpc.call(beacon, callData.value, ctx);
  if (!called.ok) {
    return rpcError(input, called.error);
  }
  const decoded = decodeCallAddress(called.value);
  if (decoded === null || decoded.kind !== "address") {
    return unresolvedProxy(input, "beacon implementation() answer is not an address");
  }
  const implementation = decoded.address;
  if (visited.includes((implementation as string).toLowerCase())) {
    return unresolvedProxy(input, "beacon implementation points back into the visited chain");
  }
  visited.push((implementation as string).toLowerCase());
  const implCode = await readCode(ports, codeCache, implementation, ctx);
  if (implCode === null) {
    return unresolvedProxy(input, "beacon implementation has no code");
  }
  if (implCode === undefined) {
    const failed = await readCodeError(ports, codeCache, implementation, ctx);
    if (failed !== null) {
      return rpcError(input, failed);
    }
    return unresolvedProxy(input, "beacon implementation code is unreadable");
  }
  const implHash = CodeHash.of(implCode);
  if (!implHash.ok) {
    return unresolvedProxy(input, "beacon implementation code hash is undecodable");
  }
  const authority = await classifyBeaconOwner(ports, codeCache, beacon, ctx);
  const outer: ProxyResolution = Object.freeze({
    kind: "beacon",
    beacon,
    beaconCodeHash: beaconHash.value,
    implementation,
    implementationCodeHash: implHash.value,
    beaconSlot: BEACON_SLOT,
    block,
    upgradeAuthority: authority,
  });
  return advanceThroughCodePointers(
    ports,
    codeCache,
    input,
    block,
    ctx,
    outer,
    implementation,
    implCode,
    implHash.value,
    visited,
    1,
    maxDepth,
  );
}

// Beacon upgrade authority through `owner()` on the beacon: an address
// holder with no code is a single key, one with code is a contract, and
// anything else (a failed call, a non-address answer, a zero word, or an
// unreadable holder) is unknown (C-11). Authority reads never fail the
// resolution: the implementation is already proven.
async function classifyBeaconOwner(
  ports: ResolveProxyPorts,
  codeCache: Map<string, BytecodeType>,
  beacon: AddressType,
  ctx: CallContext,
): Promise<UpgradeAuthority> {
  const unknown: UpgradeAuthority = Object.freeze({ kind: "unknown" });
  const data = CallData.parse(BEACON_OWNER_ABI_SELECTOR);
  if (!data.ok) {
    return unknown;
  }
  const called = await ports.rpc.call(beacon, data.value, ctx);
  if (!called.ok) {
    return unknown;
  }
  const decoded = decodeCallAddress(called.value);
  if (decoded === null || decoded.kind !== "address") {
    return unknown;
  }
  const holder = decoded.address;
  const code = await readCode(ports, codeCache, holder, ctx);
  if (code === null) {
    return Object.freeze({ kind: "single-key", holder });
  }
  if (code === undefined) {
    return unknown;
  }
  const hash = CodeHash.of(code);
  if (!hash.ok) {
    return Object.freeze({ kind: "single-key", holder });
  }
  return Object.freeze({ kind: "contract", holder, codeHash: hash.value });
}

// Strict 32-byte address decoding of an eth_call answer: anything else is
// not an address word.
function decodeCallAddress(answer: CallDataType): SlotAddress | null {
  if (answer.length !== 32) {
    return null;
  }
  let hex = "";
  for (let i = 0; i < answer.length; i += 1) {
    const byte = answer[i] ?? 0;
    hex += byte.toString(16).padStart(2, "0");
  }
  const word = StorageWord.parse(`0x${hex}`);
  if (!word.ok) {
    return null;
  }
  return decodeSlotAddress(word.value);
}

// A typed proxy failure that must never degrade to none: the unresolved
// path (C-10) fires on the typed error instead of scoring the stub.
function unresolvedProxy(
  input: ResolveProxyInput,
  message: string,
): Result<ResolveProxySuccess, ResolveProxyError> {
  return err({
    kind: "rpc-error",
    requestId: input.requestId,
    error: { kind: "invalid-response", message: `proxy-unresolved: ${message}` },
  });
}

// Code with no paired dispatcher entries that still delegates matches no
// known clone template, so scoring it as-is would score the stub (C-11,
// F-4). A push-aware sweep keeps PUSH-data bytes from counting as opcodes.
function entryLooksLikeUnknownProxy(entryCode: BytecodeType): boolean {
  let paired = false;
  for (const entry of extractSelectors(entryCode)) {
    if (entry.kind === "paired") {
      paired = true;
      break;
    }
  }
  return !paired && containsDelegateCall(entryCode);
}

function containsDelegateCall(code: BytecodeType): boolean {
  const raw = code as Uint8Array;
  let pc = 0;
  while (pc < raw.length) {
    const op = raw[pc] ?? 0;
    if (op === 0xf4) {
      return true;
    }
    if (op >= 0x60 && op <= 0x7f) {
      pc += op - 0x5f + 1;
    } else {
      pc += 1;
    }
  }
  return false;
}

// Code-pointer chain from an entry whose bytecode already carries the hop
// (EIP-7702 or EIP-1167): every further hop comes from bytecode as well,
// never from storage.
async function followCodeChain(
  ports: ResolveProxyPorts,
  codeCache: Map<string, BytecodeType>,
  input: ResolveProxyInput,
  block: BlockNumberType,
  ctx: CallContext,
  entry: AddressType,
  entryCode: BytecodeType,
  maxDepth: number,
): Promise<Result<ResolveProxySuccess, ResolveProxyError>> {
  const visited: string[] = [];
  let current = entry;
  let currentCode = entryCode;
  let depth = 0;
  let last: ProxyResolution = NONE_RESOLUTION;

  for (;;) {
    const key = (current as string).toLowerCase();
    if (visited.includes(key) || depth > maxDepth) {
      return ok({ resolution: last, block });
    }
    visited.push(key);
    // EIP-7702 comes first: delegated EOA code carries the 0xef0100 prefix
    // with the delegation address inline, so no slot read applies.
    const delegated = parseEip7702Delegation(currentCode);
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
      currentCode = targetCode;
      depth += 1;
      continue;
    }
    // EIP-1167 follows: the minimal-proxy bytecode embeds the fixed target
    // address inline, so no slot read applies.
    const minimalTarget = parseEip1167Target(currentCode);
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
      currentCode = targetCode;
      depth += 1;
      continue;
    }
    return ok({ resolution: last, block });
  }
}

// Substitute the final code target into an outer storage-hop resolution.
// The outer kind, slots, block, admin and upgrade authority are unchanged:
// the outermost admin wins and the outer hop already marks upgradeability.
function withFinalTarget(
  outer: ProxyResolution,
  implementation: AddressType,
  implementationCodeHash: CodeHashType,
): ProxyResolution {
  switch (outer.kind) {
    case "beacon":
      return Object.freeze({ ...outer, implementation, implementationCodeHash });
    case "eip1967":
      return Object.freeze({ ...outer, implementation, implementationCodeHash });
    case "zos":
      return Object.freeze({ ...outer, implementation, implementationCodeHash });
    case "uups":
      return Object.freeze({ ...outer, implementation, implementationCodeHash });
    case "eip1167":
    case "eip7702":
    case "none":
      return outer;
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
// means an EOA holder, code means a contract holder with its code hash. A
// zero word reports the zero admin with a locked authority; an undecodable
// word (dirty high bits) reports an unknown holder and authority, since a
// working admin may hide in the low 160 bits (C-11, F-27). Returns
// undefined solely on a typed RPC failure while reading the admin code, so
// the caller can map the port error.
async function classifyAdmin(
  ports: ResolveProxyPorts,
  codeCache: Map<string, BytecodeType>,
  word: StorageWordType,
  ctx: CallContext,
): Promise<AdminClassification | undefined> {
  const decoded = decodeSlotAddress(word);
  if (decoded.kind === "empty") {
    const admin: AdminKind = Object.freeze({ kind: "zero" });
    const authority: UpgradeAuthority = Object.freeze({ kind: "locked" });
    return { admin, authority };
  }
  if (decoded.kind === "garbage") {
    const admin: AdminKind = Object.freeze({ kind: "unknown" });
    const authority: UpgradeAuthority = Object.freeze({ kind: "unknown" });
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
