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
};

// Documented locker registry, kept small on purpose. Each entry was
// identified from its public docs and verified to carry code on Ethereum
// mainnet before the registry shipped. Lockers whose holding semantics
// cannot be verified from public docs stay out: PinkLock02 carries no code
// on mainnet at its documented address, and the Team Finance factory
// mints per-lock positions whose holding contract is not a single
// documented address, so both stay can't-tell until proven.
export const LOCKER_REGISTRY: readonly LockerEntry[] = Object.freeze([
  Object.freeze({
    name: "uncx-v2",
    address: "0x59d7d55ddc58494fbbbca29904f108ece82ac7fb",
    kind: "v2-lp",
    source: "https://docs.uncx.network/guides/for-projects/liquidity-lockers-v2",
  }),
  Object.freeze({
    name: "uncx-v3",
    address: "0x231278edd38b00b07fbd52120cef685b9baebcc1",
    kind: "v3-positions",
    source: "https://docs.uncx.network/guides/for-projects/liquidity-lockers-v3",
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
