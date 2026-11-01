// Proxy resolution: EIP-1967, UUPS, EIP-1167 and EIP-7702 detection
// (K-002, K-004, K-005, K-007, S-006, S-007).
// Pure domain module: slot definitions are derived from the public spec
// formula (keccak256 of the documented label minus 1) through the shared
// Keccak implementation, and slot decoding is a total function of the
// storage word. Byte-pattern detection for EIP-1167 and EIP-7702 is a
// total function of the bytecode. Reading storage slots goes through
// RpcPort in the application service; this module performs no I/O.
// Beacon and diamond branches arrive in later stories (S-008, S-009).
import { extractSelectors } from "./selectors.ts";
import { Address, keccak256HexOfUtf8 } from "./types.ts";
import type {
  Address as AddressType,
  BlockNumber as BlockNumberType,
  Bytecode as BytecodeType,
  CodeHash as CodeHashType,
  PcOffset as PcOffsetType,
  Selector as SelectorType,
  Slot as SlotType,
  StorageWord as StorageWordType,
} from "./types.ts";
import type { CanonicalValue } from "./serialize.ts";

// Documented labels from the public EIP-1967 specification. The slots are
// derived below as keccak256(label) minus 1, so the values follow the
// formula instead of being copied from elsewhere.
export const IMPLEMENTATION_LABEL = "eip1967.proxy.implementation";
export const ADMIN_LABEL = "eip1967.proxy.admin";
export const BEACON_LABEL = "eip1967.proxy.beacon";
export const ZOS_IMPLEMENTATION_LABEL = "org.zeppelinos.proxy.implementation";
export const ZOS_ADMIN_LABEL = "org.zeppelinos.proxy.admin";

// UUPS (ERC-1822) upgrade entry point signature. The selector is derived
// from this signature through the shared Keccak implementation.
export const PROXIABLE_UUID_SIGNATURE = "proxiableUUID()";

// Storage slot for a documented label: keccak256 of the label minus 1 as a
// 256-bit unsigned value. Total: the digest is always 32 bytes, so the
// decremented value always formats as exactly 64 hex characters and the
// Slot invariant holds by construction.
export function slotForLabel(label: string): SlotType {
  const digest = BigInt(keccak256HexOfUtf8(label));
  const slot = (digest - 1n).toString(16).padStart(64, "0");
  return `0x${slot}` as SlotType;
}

export const IMPLEMENTATION_SLOT: SlotType = slotForLabel(IMPLEMENTATION_LABEL);
export const ADMIN_SLOT: SlotType = slotForLabel(ADMIN_LABEL);
export const BEACON_SLOT: SlotType = slotForLabel(BEACON_LABEL);

// Legacy ZeppelinOS slots are keccak256(label) with no minus-one step.
export function slotForLabelRaw(label: string): SlotType {
  return keccak256HexOfUtf8(label) as SlotType;
}

export const ZOS_IMPLEMENTATION_SLOT: SlotType = slotForLabelRaw(ZOS_IMPLEMENTATION_LABEL);
export const ZOS_ADMIN_SLOT: SlotType = slotForLabelRaw(ZOS_ADMIN_LABEL);

// First four bytes of keccak256 of the function signature, 0x-prefixed
// lowercase, so the Selector invariant holds by construction.
export function proxiableUUIDSelector(): SelectorType {
  return `0x${keccak256HexOfUtf8(PROXIABLE_UUID_SIGNATURE).slice(2, 10)}` as SelectorType;
}

// Whether the bytecode exposes the selector in its dispatcher scan.
export function bytecodeHasSelector(bytecode: BytecodeType, selector: SelectorType): boolean {
  const wanted = selector as string;
  for (const entry of extractSelectors(bytecode)) {
    if ((entry.selector as string) === wanted) {
      return true;
    }
  }
  return false;
}

// Jump-target PC offset paired with the selector in the dispatcher scan,
// or null when the offset is not derivable (unknown entry or absent).
export function selectorOffsetInBytecode(
  bytecode: BytecodeType,
  selector: SelectorType,
): PcOffsetType | null {
  const wanted = selector as string;
  for (const entry of extractSelectors(bytecode)) {
    if ((entry.selector as string) === wanted && entry.kind === "paired") {
      return entry.target;
    }
  }
  return null;
}

// Typed decoding of a 32-byte storage word as an address field: the zero
// word is empty, a word with nonzero upper padding bytes is garbage, and a
// correctly padded word carries the checksummed address. Total: every word
// maps to exactly one branch, never throws.
export type SlotAddress =
  | { readonly kind: "empty" }
  | { readonly kind: "address"; readonly address: AddressType }
  | { readonly kind: "garbage"; readonly word: StorageWordType };

export function decodeSlotAddress(word: StorageWordType): SlotAddress {
  const hex = (word as string).slice(2).toLowerCase();
  if (/^0+$/.test(hex)) {
    return Object.freeze({ kind: "empty" }) as SlotAddress;
  }
  const padding = hex.slice(0, 24);
  const body = hex.slice(24);
  if (!/^0+$/.test(padding)) {
    return Object.freeze({ kind: "garbage", word }) as SlotAddress;
  }
  const parsed = Address.parse(`0x${body}`);
  if (!parsed.ok) {
    return Object.freeze({ kind: "garbage", word }) as SlotAddress;
  }
  return Object.freeze({ kind: "address", address: parsed.value }) as SlotAddress;
}

// Who can change the proxy target (A-12). Single key is an EOA holder, a
// contract holder carries its code hash, and locked means no upgrade path
// is reachable (zero admin). Unknown means the admin word carries dirty
// high bits, so no holder can be proven (C-11, F-27); implementation means
// upgrades are gated inside the implementation itself (UUPS without an
// admin word, C-11).
export type AdminKind =
  | { readonly kind: "eoa"; readonly address: AddressType }
  | { readonly kind: "contract"; readonly address: AddressType; readonly codeHash: CodeHashType }
  | { readonly kind: "zero" }
  | { readonly kind: "unknown" };

export type UpgradeAuthority =
  | { readonly kind: "single-key"; readonly holder: AddressType }
  | { readonly kind: "contract"; readonly holder: AddressType; readonly codeHash: CodeHashType }
  | { readonly kind: "implementation" }
  | { readonly kind: "locked" }
  | { readonly kind: "unknown" };

// EIP-1167 minimal proxy runtime shape (public EIP-1167 pattern): 45 bytes
// with a 10-byte prefix, the 20-byte embedded target, and a 15-byte suffix.
// Clones with immutable args (Solady/OZ) append the args after the final
// RETURN, so longer code with the same 45-byte head keeps the same target.
export const EIP1167_BYTE_LENGTH = 45;
const EIP1167_PREFIX: readonly number[] = Object.freeze([
  0x36, 0x3d, 0x3d, 0x37, 0x3d, 0x3d, 0x3d, 0x36, 0x3d, 0x73,
]);
const EIP1167_SUFFIX: readonly number[] = Object.freeze([
  0x5a, 0xf4, 0x3d, 0x82, 0x80, 0x3e, 0x90, 0x3d, 0x91, 0x60, 0x2b, 0x57, 0xfd, 0x5b, 0xf3,
]);

// Solady PUSH0 clone runtime shape (LibClone clone_PUSH0): 45 bytes with a
// 9-byte prefix, the 20-byte embedded target, and a 16-byte suffix. The
// JUMPI operand 0x29 (= 41) points at the 0x5b byte, which sits at index
// 41. Clones with immutable args append the args after the final RETURN.
export const PUSH0_CLONE_BYTE_LENGTH = 45;
const PUSH0_CLONE_PREFIX: readonly number[] = Object.freeze([
  0x5f, 0x5f, 0x36, 0x5f, 0x5f, 0x37, 0x36, 0x5f, 0x73,
]);
const PUSH0_CLONE_SUFFIX: readonly number[] = Object.freeze([
  0x5a, 0xf4, 0x3d, 0x5f, 0x5f, 0x3e, 0x60, 0x29, 0x57, 0x3d, 0x5f, 0xfd, 0x5b, 0x3d, 0x5f, 0xf3,
]);

// EIP-7702 delegation designator prefix on EOA code: 0xef0100 followed by
// the 20-byte delegation address (23 bytes total).
export const EIP7702_BYTE_LENGTH = 23;
const EIP7702_PREFIX: readonly number[] = Object.freeze([0xef, 0x01, 0x00]);

const HEX_DIGITS_LOWER = "0123456789abcdef";

function bytesToHexLower(slice: Uint8Array): string {
  let out = "";
  for (let i = 0; i < slice.length; i += 1) {
    const byte = slice[i] ?? 0;
    out += HEX_DIGITS_LOWER[(byte >> 4) & 15] ?? "0";
    out += HEX_DIGITS_LOWER[byte & 15] ?? "0";
  }
  return out;
}

function addressOfSlice(slice: Uint8Array): AddressType | null {
  const parsed = Address.parse(`0x${bytesToHexLower(slice)}`);
  if (!parsed.ok) {
    return null;
  }
  return parsed.value;
}

// Embedded clone target, or null when the bytecode matches no known clone
// template. Total: every bytecode maps to exactly one branch, never throws.
// Accepts the standard EIP-1167 runtime (with optional trailing immutable
// args, which sit after the final RETURN and never execute) and the Solady
// PUSH0 clone runtime (likewise with optional trailing args).
export function parseEip1167Target(bytecode: BytecodeType): AddressType | null {
  const raw = bytecode as Uint8Array;
  if (raw.length >= EIP1167_BYTE_LENGTH && matchesAt(raw, EIP1167_PREFIX, 0)) {
    const suffixStart = EIP1167_BYTE_LENGTH - EIP1167_SUFFIX.length;
    if (matchesAt(raw, EIP1167_SUFFIX, suffixStart)) {
      return addressOfSlice(raw.slice(EIP1167_PREFIX.length, suffixStart));
    }
  }
  if (raw.length >= PUSH0_CLONE_BYTE_LENGTH && matchesAt(raw, PUSH0_CLONE_PREFIX, 0)) {
    const suffixStart = PUSH0_CLONE_BYTE_LENGTH - PUSH0_CLONE_SUFFIX.length;
    if (matchesAt(raw, PUSH0_CLONE_SUFFIX, suffixStart)) {
      return addressOfSlice(raw.slice(PUSH0_CLONE_PREFIX.length, suffixStart));
    }
  }
  return null;
}

function matchesAt(raw: Uint8Array, pattern: readonly number[], start: number): boolean {
  for (let i = 0; i < pattern.length; i += 1) {
    if ((raw[start + i] ?? -1) !== (pattern[i] ?? -2)) {
      return false;
    }
  }
  return true;
}

// Delegated EIP-7702 target, or null when the code carries another prefix.
// Total: every bytecode maps to exactly one branch, never throws.
export function parseEip7702Delegation(bytecode: BytecodeType): AddressType | null {
  const raw = bytecode as Uint8Array;
  if (raw.length !== EIP7702_BYTE_LENGTH) {
    return null;
  }
  for (let i = 0; i < EIP7702_PREFIX.length; i += 1) {
    if ((raw[i] ?? -1) !== (EIP7702_PREFIX[i] ?? -2)) {
      return null;
    }
  }
  return addressOfSlice(raw.slice(EIP7702_PREFIX.length));
}

// Proxy resolution branches (A-12 subset). Each branch that
// reports an implementation carries the evidence the requirement names:
// the storage slot, the pinned block, and the selector with its PC offset
// where derivable for EIP-1967/UUPS. The EIP-1167 target is fixed
// (logic locked) and the EIP-7702 delegation can change by new
// authorization per K-004 and K-007. The beacon branch (C-11) names the
// beacon beside the implementation it reports; the beacon slot wins only
// when no implementation slot is set. Diamond branches arrive in their own
// story and extend this union.
export type ProxyResolution =
  | { readonly kind: "none" }
  | {
      readonly kind: "beacon";
      readonly beacon: AddressType;
      readonly beaconCodeHash: CodeHashType;
      readonly implementation: AddressType;
      readonly implementationCodeHash: CodeHashType;
      readonly beaconSlot: SlotType;
      readonly block: BlockNumberType;
      readonly upgradeAuthority: UpgradeAuthority;
    }
  | {
      readonly kind: "eip1967";
      readonly implementation: AddressType;
      readonly implementationCodeHash: CodeHashType;
      readonly implementationSlot: SlotType;
      readonly adminSlot: SlotType;
      readonly block: BlockNumberType;
      readonly admin: AdminKind;
      readonly upgradeAuthority: UpgradeAuthority;
    }
  | {
      readonly kind: "uups";
      readonly implementation: AddressType;
      readonly implementationCodeHash: CodeHashType;
      readonly implementationSlot: SlotType;
      readonly block: BlockNumberType;
      readonly upgradeFunction: SelectorType;
      readonly upgradeFunctionOffset?: PcOffsetType;
      readonly upgradeAuthority: UpgradeAuthority;
    }
  | {
      readonly kind: "zos";
      readonly implementation: AddressType;
      readonly implementationCodeHash: CodeHashType;
      readonly implementationSlot: SlotType;
      readonly adminSlot: SlotType;
      readonly block: BlockNumberType;
      readonly admin: AdminKind;
      readonly upgradeAuthority: UpgradeAuthority;
    }
  | {
      readonly kind: "eip1167";
      readonly target: AddressType;
      readonly targetCodeHash: CodeHashType;
      readonly mutability: "fixed";
    }
  | {
      readonly kind: "eip7702";
      readonly delegation: AddressType;
      readonly delegationCodeHash: CodeHashType;
      readonly mutability: "changeable-by-new-authorization";
    };

// The empty proxy outcome: the address holds no recognised proxy pointer.
export function noneProxyResolution(): ProxyResolution {
  return Object.freeze({ kind: "none" });
}

// Canonical mapping for the assessment envelope (A-32 point 5): fixed
// shape, sorted keys through canonicalSerialize at the boundary.
export function proxyToCanonical(resolution: ProxyResolution): CanonicalValue {
  switch (resolution.kind) {
    case "none":
      return { kind: "none" };
    case "beacon":
      return {
        kind: "beacon",
        beacon: resolution.beacon as string,
        beaconCodeHash: resolution.beaconCodeHash as string,
        implementation: resolution.implementation as string,
        implementationCodeHash: resolution.implementationCodeHash as string,
        beaconSlot: resolution.beaconSlot as string,
        block: resolution.block as number,
        upgradeAuthority: authorityToCanonical(resolution.upgradeAuthority),
      };
    case "eip1967":
      return {
        kind: "eip1967",
        implementation: resolution.implementation as string,
        implementationCodeHash: resolution.implementationCodeHash as string,
        implementationSlot: resolution.implementationSlot as string,
        adminSlot: resolution.adminSlot as string,
        block: resolution.block as number,
        admin: adminToCanonical(resolution.admin),
        upgradeAuthority: authorityToCanonical(resolution.upgradeAuthority),
      };
    case "uups":
      return {
        kind: "uups",
        implementation: resolution.implementation as string,
        implementationCodeHash: resolution.implementationCodeHash as string,
        implementationSlot: resolution.implementationSlot as string,
        block: resolution.block as number,
        upgradeFunction: resolution.upgradeFunction as string,
        upgradeFunctionOffset:
          resolution.upgradeFunctionOffset === undefined
            ? null
            : (resolution.upgradeFunctionOffset as number),
        upgradeAuthority: authorityToCanonical(resolution.upgradeAuthority),
      };
    case "zos":
      return {
        kind: "zos",
        implementation: resolution.implementation as string,
        implementationCodeHash: resolution.implementationCodeHash as string,
        implementationSlot: resolution.implementationSlot as string,
        adminSlot: resolution.adminSlot as string,
        block: resolution.block as number,
        admin: adminToCanonical(resolution.admin),
        upgradeAuthority: authorityToCanonical(resolution.upgradeAuthority),
      };
    case "eip1167":
      return {
        kind: "eip1167",
        target: resolution.target as string,
        targetCodeHash: resolution.targetCodeHash as string,
        mutability: resolution.mutability,
      };
    case "eip7702":
      return {
        kind: "eip7702",
        delegation: resolution.delegation as string,
        delegationCodeHash: resolution.delegationCodeHash as string,
        mutability: resolution.mutability,
      };
  }
}

function adminToCanonical(admin: AdminKind): CanonicalValue {
  switch (admin.kind) {
    case "eoa":
      return { kind: "eoa", address: admin.address as string };
    case "contract":
      return {
        kind: "contract",
        address: admin.address as string,
        codeHash: admin.codeHash as string,
      };
    case "zero":
      return { kind: "zero" };
    case "unknown":
      return { kind: "unknown" };
  }
}

// Host fact for detectors: resolved proxy facts the detector cannot
// derive from bytecode alone (storage reads at the pinned block).
export type ProxyFact = {
  readonly proxyKind: "eip1967" | "uups" | "zos" | "eip1167" | "eip7702" | "beacon";
  readonly implementation: AddressType;
  readonly admin: AddressType | null;
  readonly adminKind: "eoa" | "contract" | "zero" | "none";
  readonly upgradeSelector: SelectorType | null;
};

export function proxyFactOf(resolution: ProxyResolution): ProxyFact | null {
  switch (resolution.kind) {
    case "none":
      return null;
    case "beacon": {
      const auth = resolution.upgradeAuthority;
      if (auth.kind === "single-key") {
        return Object.freeze({ proxyKind: "beacon", implementation: resolution.implementation, admin: auth.holder, adminKind: "eoa", upgradeSelector: null });
      }
      if (auth.kind === "contract") {
        return Object.freeze({ proxyKind: "beacon", implementation: resolution.implementation, admin: auth.holder, adminKind: "contract", upgradeSelector: null });
      }
      return Object.freeze({ proxyKind: "beacon", implementation: resolution.implementation, admin: null, adminKind: "none", upgradeSelector: null });
    }
    case "eip1967":
    case "zos": {
      const admin = resolution.admin;
      if (admin.kind === "zero") {
        return Object.freeze({ proxyKind: resolution.kind, implementation: resolution.implementation, admin: null, adminKind: "zero", upgradeSelector: null });
      }
      if (admin.kind === "unknown") {
        return Object.freeze({ proxyKind: resolution.kind, implementation: resolution.implementation, admin: null, adminKind: "none", upgradeSelector: null });
      }
      return Object.freeze({ proxyKind: resolution.kind, implementation: resolution.implementation, admin: admin.address, adminKind: admin.kind, upgradeSelector: null });
    }
    case "uups": {
      const auth = resolution.upgradeAuthority;
      if (auth.kind === "locked") {
        return Object.freeze({ proxyKind: "uups", implementation: resolution.implementation, admin: null, adminKind: "zero", upgradeSelector: resolution.upgradeFunction });
      }
      if (auth.kind === "single-key") {
        return Object.freeze({ proxyKind: "uups", implementation: resolution.implementation, admin: auth.holder, adminKind: "eoa", upgradeSelector: resolution.upgradeFunction });
      }
      if (auth.kind === "contract") {
        return Object.freeze({ proxyKind: "uups", implementation: resolution.implementation, admin: auth.holder, adminKind: "contract", upgradeSelector: resolution.upgradeFunction });
      }
      return Object.freeze({ proxyKind: "uups", implementation: resolution.implementation, admin: null, adminKind: "none", upgradeSelector: resolution.upgradeFunction });
    }
    case "eip1167":
      return Object.freeze({ proxyKind: "eip1167", implementation: resolution.target, admin: null, adminKind: "none", upgradeSelector: null });
    case "eip7702":
      return Object.freeze({ proxyKind: "eip7702", implementation: resolution.delegation, admin: null, adminKind: "none", upgradeSelector: null });
  }
}

function authorityToCanonical(authority: UpgradeAuthority): CanonicalValue {
  switch (authority.kind) {
    case "single-key":
      return { kind: "single-key", holder: authority.holder as string };
    case "contract":
      return {
        kind: "contract",
        holder: authority.holder as string,
        codeHash: authority.codeHash as string,
      };
    case "implementation":
      return { kind: "implementation" };
    case "locked":
      return { kind: "locked" };
    case "unknown":
      return { kind: "unknown" };
  }
}
