// Point-in-time on-chain feature computation (session A).
// Pure domain module shared by both drivers: the offline extractor (point-
// in-time block T0 + W for training) and the serving path (current block
// for inference). Every function takes an already-fetched snapshot and
// returns a feature with an explicit can't-tell reason wherever data is
// missing. Nothing here reads the chain; the drivers fetch through RpcPort.
import { ANALYSIS_WINDOWS, analysisBlock } from "./pools.ts";
import type { OwnerStatus } from "./lockers.ts";
import { LOCKER_REGISTRY, classifyOwner } from "./lockers.ts";
import { concentrationOf } from "./transfers.ts";
import type { ConcentrationResult, TransferEvent } from "./transfers.ts";

export const FEATURE_W_VALUES: readonly number[] = ANALYSIS_WINDOWS;
export { analysisBlock };

export type FeatureStatus = "ok" | "partial" | "no-pool" | "cant-tell";

export type OwnerFeature =
  | { readonly status: "ok"; readonly owner: OwnerStatus }
  | { readonly status: "cant-tell"; readonly reason: string };

export function ownerFeatureOf(input: {
  readonly ownerWord: string | null;
  readonly ownerHasCode: boolean;
  readonly masterCopy: string | null;
  readonly slotProven: boolean;
}): OwnerFeature {
  if (!input.slotProven && input.ownerWord === null) {
    return { status: "cant-tell", reason: "no proven owner slot and no owner() answer" };
  }
  const owner = classifyOwner({
    ownerWord: input.ownerWord,
    ownerHasCode: input.ownerHasCode,
    masterCopy: input.masterCopy,
  });
  if (owner.kind === "unknown") {
    return { status: "cant-tell", reason: owner.reason };
  }
  return Object.freeze({ status: "ok", owner });
}

export type LpBuckets =
  | {
      readonly status: "ok";
      readonly burnedShare: number;
      readonly lockerShare: number;
      readonly deployerShare: number;
      readonly ownerShare: number;
      readonly otherShare: number;
    }
  | { readonly status: "cant-tell"; readonly reason: string };

// V2-style LP share buckets over an already-fetched snapshot: the burned
// (zero and dead), locker-held, deployer-held and owner-held shares of LP
// supply, with the remainder as other. Shares divide by the on-chain LP
// total supply; a missing or zero supply stays can't-tell. V3 positions
// aggregate off-chain and are can't-tell unless the driver proves them.
export function lpBucketsOf(input: {
  readonly kind: "v2" | "v3";
  readonly lpTotalSupply: bigint | null;
  readonly balances: Readonly<Record<string, bigint>>;
  readonly deployer: string | null;
  readonly owner: string | null;
}): LpBuckets {
  if (input.kind === "v3") {
    return { status: "cant-tell", reason: "v3 position ownership is too costly to prove" };
  }
  if (input.lpTotalSupply === null || input.lpTotalSupply <= 0n) {
    return { status: "cant-tell", reason: "lp total supply is missing or zero" };
  }
  const supply = Number(input.lpTotalSupply);
  const at = (address: string): bigint => input.balances[address.toLowerCase()] ?? 0n;
  const burned = at("0x0000000000000000000000000000000000000000") + at("0x000000000000000000000000000000000000dead");
  const lockerHeld = LOCKER_REGISTRY.filter((entry) => entry.kind === "v2-lp")
    .reduce((total, entry) => total + at(entry.address), 0n);
  const deployerHeld = input.deployer === null ? 0n : at(input.deployer);
  const ownerHeld = input.owner === null ? 0n : at(input.owner);
  const counted = burned + lockerHeld + deployerHeld + ownerHeld;
  const other = input.lpTotalSupply - counted;
  return Object.freeze({
    status: "ok",
    burnedShare: burned <= 0n ? 0 : Number(burned) / supply,
    lockerShare: lockerHeld <= 0n ? 0 : Number(lockerHeld) / supply,
    deployerShare: deployerHeld <= 0n ? 0 : Number(deployerHeld) / supply,
    ownerShare: ownerHeld <= 0n ? 0 : Number(ownerHeld) / supply,
    otherShare: other <= 0n ? 0 : Number(other) / supply,
  });
}

export type LiquidityFeature =
  | {
      readonly status: "ok";
      readonly quote: string;
      readonly quoteAmount: string;
      readonly wethAmount: string | null;
      readonly usdAmount: string | null;
    }
  | { readonly status: "cant-tell"; readonly reason: string };

// Liquidity size in quote-asset terms from an already-fetched reserves
// snapshot. WETH quotes report the raw amount; stablecoin quotes report the
// raw amount as USD and a WETH normalisation through the canonical
// WETH/USDC V2 reserves read at the same block (documented deterministic
// conversion): wethPerStable is WETH per one whole stable unit, so the
// quote reserve first normalises by its decimals. V3 pools stay can't-tell:
// tick math is too costly here.
export function liquidityOf(input: {
  readonly kind: "v2" | "v3";
  readonly quote: string;
  readonly quoteIsWeth: boolean;
  readonly quoteIsStable: boolean;
  readonly quoteReserve: bigint | null;
  readonly quoteDecimals: number | null;
  readonly wethPerStable: number | null;
}): LiquidityFeature {
  if (input.kind === "v3") {
    return { status: "cant-tell", reason: "v3 liquidity math is too costly to prove" };
  }
  if (input.quoteReserve === null) {
    return { status: "cant-tell", reason: "quote reserves are missing" };
  }
  if (input.quoteIsWeth) {
    return Object.freeze({
      status: "ok",
      quote: input.quote,
      quoteAmount: input.quoteReserve.toString(),
      wethAmount: input.quoteReserve.toString(),
      usdAmount: null,
    });
  }
  if (input.quoteIsStable) {
    if (input.wethPerStable === null || !(input.wethPerStable > 0) || input.quoteDecimals === null) {
      return Object.freeze({
        status: "ok",
        quote: input.quote,
        quoteAmount: input.quoteReserve.toString(),
        wethAmount: null,
        usdAmount: input.quoteReserve.toString(),
      });
    }
    const weth = (Number(input.quoteReserve) / 10 ** input.quoteDecimals) * input.wethPerStable;
    return Object.freeze({
      status: "ok",
      quote: input.quote,
      quoteAmount: input.quoteReserve.toString(),
      wethAmount: String(weth),
      usdAmount: input.quoteReserve.toString(),
    });
  }
  return { status: "cant-tell", reason: "quote asset is neither weth nor a stablecoin" };
}

export type VariantFeatures = {
  readonly window: number;
  readonly analysisBlock: number | null;
  readonly owner: OwnerFeature;
  readonly lp: LpBuckets;
  readonly concentration: ConcentrationResult;
  readonly liquidity: LiquidityFeature;
  readonly tokenAgeBlocks: number | null;
};

export type TokenFeatures = {
  readonly deploymentBlock: number | null;
  readonly deployer: string | null;
  readonly deployerProvenance: "creation-tx" | "factory-or-internal" | "unknown";
  readonly t0: number | null;
  readonly t0Pool: { readonly kind: "v2" | "v3"; readonly dex: string } | null;
  readonly blocksToT0: number | null;
  readonly status: "ok" | "partial" | "no-pool";
  readonly reasons: readonly string[];
  readonly variants: readonly VariantFeatures[];
};

export function concentrationFeatureOf(input: {
  readonly transfers: readonly TransferEvent[];
  readonly excluded: readonly string[];
  readonly totalSupply: bigint | null;
  readonly deployer: string | null;
  readonly owner: string | null;
}): ConcentrationResult {
  return concentrationOf(input);
}
