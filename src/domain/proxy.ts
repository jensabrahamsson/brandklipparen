// Proxy resolution: EIP-1967 and UUPS proxy detection (K-002, K-005, S-006).
// Pure domain module: slot definitions are derived from the public spec
// formula (keccak256 of the documented label minus 1) through the shared
// Keccak implementation, and slot decoding is a total function of the
// storage word. Reading storage slots goes through RpcPort in the
// application service; this module performs no I/O. Beacon, EIP-1167,
// diamond and EIP-7702 branches arrive in later stories (S-007–S-009).
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
// is reachable (zero admin).
export type AdminKind =
  | { readonly kind: "eoa"; readonly address: AddressType }
  | { readonly kind: "contract"; readonly address: AddressType; readonly codeHash: CodeHashType }
  | { readonly kind: "zero" };

export type UpgradeAuthority =
  | { readonly kind: "single-key"; readonly holder: AddressType }
  | { readonly kind: "contract"; readonly holder: AddressType; readonly codeHash: CodeHashType }
  | { readonly kind: "locked" };

// Proxy resolution branches for this story (A-12 subset). Each branch that
// reports an implementation carries the evidence the requirement names:
// the storage slot, the pinned block, and the selector with its PC offset
// where derivable. Beacon, EIP-1167, diamond and EIP-7702 branches arrive
// in their own stories and extend this union.
export type ProxyResolution =
  | { readonly kind: "none" }
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
    case "locked":
      return { kind: "locked" };
  }
}
