// Known locker and Safe registries plus owner classification (session A).
// Pure domain module: the small documented locker registry (entries
// identified from public docs with verified on-chain code) and the Safe
// singleton registry from the Safe deployment records. Classification takes
// already-fetched evidence (the owner word, code presence, masterCopy
// result), so this module performs no reads itself.
import { isZeroOrDead } from "./topics.ts";

export type LockerEntry = {
  readonly name: string;
  readonly address: string;
  readonly kind: "v2-lp" | "v3-positions";
  readonly source: string;
  // Breakdown keys in the external point-in-time snapshot file that this
  // entry covers. The snapshot tool tracked lockers by name while the live
  // path reads balances by address, so this list is what lets the snapshot
  // mapping and the live plugins share one definition: the mapping sums
  // only these names (lockerShareOfBreakdown) and the live plugin reads
  // only these addresses (lpBucketsOf). Empty when the snapshot tool did
  // not track the entry.
  readonly snapshotNames: readonly string[];
};

// Documented locker registry: the single source of truth for the locker
// set, shared by the snapshot mapping (by snapshotNames) and the live
// plugins (by address), so train and serve use the same definition. The
// docs-identified UNCX entries shipped first; the snapshot-time entries
// below join them because the external snapshot definition documents each
// with a public verification (Etherscan name tag or verified contract
// name), and without them train would count lockers that serve ignores.
// Caveat: Team Finance also mints per-lock positions outside its single
// documented holder, so factory-routed locks beyond that holder still land
// in otherShare on both sides. A candidate PinkLock address with no code
// on mainnet stays out.
export const LOCKER_REGISTRY: readonly LockerEntry[] = Object.freeze([
  Object.freeze({
    name: "uncx-v2",
    address: "0x59d7d55ddc58494fbbbca29904f108ece82ac7fb",
    kind: "v2-lp",
    source: "https://docs.uncx.network/guides/for-projects/liquidity-lockers-v2",
    snapshotNames: Object.freeze([]),
  }),
  Object.freeze({
    name: "uncx-v3",
    address: "0x231278edd38b00b07fbd52120cef685b9baebcc1",
    kind: "v3-positions",
    source: "https://docs.uncx.network/guides/for-projects/liquidity-lockers-v3",
    snapshotNames: Object.freeze([]),
  }),
  Object.freeze({
    name: "uncx-uniswap-v2-locker",
    address: "0x663A5C229c09b049E36dCc11a9B0d4a8Eb9db214",
    kind: "v2-lp",
    source: "Etherscan name tag for the UNCX LP locker; verified contract UniswapV2Locker",
    snapshotNames: Object.freeze(["UNCX (Unicrypt) UniswapV2Locker"]),
  }),
  Object.freeze({
    name: "team-finance-lock",
    address: "0xE2fE530C047f2d85298b07D9333C05737f1435fB",
    kind: "v2-lp",
    source: "Etherscan name tag for the Team Finance lock",
    snapshotNames: Object.freeze(["Team Finance Lock"]),
  }),
  Object.freeze({
    name: "pinklock-v2",
    address: "0x71B5759d73262FBb223956913ecF4ecC51057641",
    kind: "v2-lp",
    source: "Etherscan name tag for the PinkSale Pink Lock",
    snapshotNames: Object.freeze(["PinkSale PinkLock v2"]),
  }),
  Object.freeze({
    name: "pinklock-v1",
    address: "0x33d4cC8716Beb13F814F538Ad3b2de3b036f5e2A",
    kind: "v2-lp",
    source: "Verified contract name PinkLock; listed by the PinkSale team in the DefiLlama adapters",
    snapshotNames: Object.freeze(["PinkSale PinkLock (v1)"]),
  }),
]);

export function lockerOf(address: string): LockerEntry | null {
  const lower = address.toLowerCase();
  for (const entry of LOCKER_REGISTRY) {
    if (entry.address.toLowerCase() === lower) {
      return entry;
    }
  }
  return null;
}

export function lockerAddresses(): readonly string[] {
  return Object.freeze(LOCKER_REGISTRY.map((entry) => entry.address.toLowerCase()));
}

// Snapshot locker names covered by the registry (v2-lp entries only): the
// snapshot mapping sums breakdown entries under exactly these names, so an
// unknown locker name never enters the locker share.
export function snapshotLockerNames(): readonly string[] {
  const names: string[] = [];
  for (const entry of LOCKER_REGISTRY) {
    if (entry.kind !== "v2-lp") {
      continue;
    }
    for (const name of entry.snapshotNames) {
      if (!names.includes(name)) {
        names.push(name);
      }
    }
  }
  return Object.freeze(names);
}

// Locker share from a snapshot breakdown record (locker name to share):
// sums only the registry-covered names, so train uses the same locker
// definition as the live plugin reads by address.
export function lockerShareOfBreakdown(breakdown: Readonly<Record<string, number>>): number {
  const wanted = new Set<string>(snapshotLockerNames());
  let total = 0;
  for (const [name, share] of Object.entries(breakdown)) {
    if (!wanted.has(name) || !Number.isFinite(share) || share <= 0) {
      continue;
    }
    total += share;
  }
  return total;
}

export type SafeSingletonEntry = {
  readonly name: string;
  readonly address: string;
  readonly source: string;
};

// Safe singleton registry from the Safe deployment records (Safe proxy
// pattern: the owner proxy answers masterCopy() with its singleton).
// Verified to carry code on Ethereum mainnet before shipping.
export const SAFE_SINGLETONS: readonly SafeSingletonEntry[] = Object.freeze([
  Object.freeze({
    name: "safe-v1.3.0",
    address: "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552",
    source: "https://github.com/safe-global/safe-deployments",
  }),
  Object.freeze({
    name: "safe-v1.4.1",
    address: "0x41675C099F32341bf84BFc5382aF534df5C7461a",
    source: "https://github.com/safe-global/safe-deployments",
  }),
]);

export function isKnownSafeSingleton(address: string): boolean {
  const lower = address.toLowerCase();
  return SAFE_SINGLETONS.some((entry) => entry.address.toLowerCase() === lower);
}

export type OwnerStatus =
  | { readonly kind: "renounced" }
  | { readonly kind: "eoa"; readonly address: string }
  | { readonly kind: "contract"; readonly address: string }
  | { readonly kind: "safe"; readonly address: string; readonly singleton: string }
  | { readonly kind: "unknown"; readonly reason: string };

// Deterministic owner classification over already-fetched evidence: the
// owner word read at the analysis block, whether that address carries code
// there, and the masterCopy() answer when the owner is a contract. Zero
// and dead words count as renounced; an unreadable value stays unknown
// (can't tell), never guessed.
export function classifyOwner(input: {
  readonly ownerWord: string | null;
  readonly ownerHasCode: boolean;
  readonly masterCopy: string | null;
}): OwnerStatus {
  if (input.ownerWord === null) {
    return Object.freeze({ kind: "unknown", reason: "owner value is missing" });
  }
  const address = input.ownerWord.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    return Object.freeze({ kind: "unknown", reason: "owner value is not an address" });
  }
  if (isZeroOrDead(address)) {
    return Object.freeze({ kind: "renounced" });
  }
  if (!input.ownerHasCode) {
    return Object.freeze({ kind: "eoa", address });
  }
  if (input.masterCopy !== null && isKnownSafeSingleton(input.masterCopy)) {
    return Object.freeze({ kind: "safe", address, singleton: input.masterCopy.toLowerCase() });
  }
  return Object.freeze({ kind: "contract", address });
}
