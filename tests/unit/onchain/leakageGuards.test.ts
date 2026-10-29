// Leakage-guard unit tests (traps a, b, c, d) with synthetic rows only.
// (a) Missingness never moves the score: no status/reason/missingness,
// pairIsMain, mainPairDex, afterFixtureBlock or pair-count features exist,
// and a missing value maps to exactly zero contribution in a linear head.
// (b) Drained LP: burnedShare 1.0 with minimum-liquidity-only supply maps
// to burned 0 plus an affirmed drained flag, never to safe.
// (c) Holder figures with a deviating log-balance sum map to zero.
// (d) Deploy-to-first-liquidity is capped so era cannot ride along.
import { describe, expect, test } from "vitest";
import {
  DEPLOY_TO_FIRST_CAP_BLOCKS,
  LOG_BALANCE_TOLERANCE,
  ONCHAIN_FEATURE_NAMES,
  SERVABLE_FEATURE_NAMES,
  deployToFirstLiq,
  featureAvailable,
  holdersReliable,
  parseSnapshotFile,
  snapshotFeaturesOf,
} from "../../../src/domain/onchain/snapshot.ts";
import { syntheticAddress } from "../../helpers/syntheticAddresses.ts";

const TOKEN = syntheticAddress(111);
const PAIR = syntheticAddress(112);
const QUOTE = syntheticAddress(113);
const DEPLOYER = syntheticAddress(114);

function baseRow(extra: Record<string, unknown> = {}) {
  return {
    address: TOKEN,
    snapshot: {
      status: "ok",
      snapshotBlock: 8200,
      firstLiquidityBlock: 1000,
      mainPair: PAIR,
      mainPairDex: "v2",
      mainPairQuote: QUOTE,
      afterFixtureBlock: true,
      notes: "ignored extra",
    },
    pairs: {
      status: "ok",
      value: [
        { dex: "v2", address: PAIR, quote: QUOTE, fee: null, createdBlock: 900, isMain: true, createdAfterSnapshot: false },
        { dex: "v3", address: syntheticAddress(115), quote: QUOTE, fee: 3000, createdBlock: 950, isMain: false, createdAfterSnapshot: false },
      ],
      method: "test",
    },
    deployBlock: { status: "ok", value: 500 },
    deployer: { status: "ok", value: DEPLOYER, method: "top_level_create_tx" },
    owner: {
      status: "ok",
      owner: { address: DEPLOYER, class: "eoa" },
      getOwner: { address: null, class: "n/a" },
    },
    totalSupply: { status: "ok", value: "1000000", decimals: 18 },
    deployerShare: { status: "ok", value: 0.1 },
    ownerShare: { status: "ok", value: 0.05, ownerIsDeployer: false },
    holders: {
      status: "ok",
      top1Share: 0.2,
      top10Share: 0.5,
      holderCountFromLogs: 40,
      transferLogCount: 120,
      logBalanceSumOverSupply: 1,
      method: "test",
    },
    lpDistribution: {
      status: "ok",
      pair: PAIR,
      lpTotalSupply: "1000",
      lpSupplyIsMinimumLiquidityOnly: false,
      burnedShare: 0.6,
      lockerShare: 0.1,
      lockerBreakdown: {},
      deployerOrOwnerShare: 0.05,
      otherShare: 0.25,
      lpHolderCount: 5,
      lpTransferLogCount: 9,
      reconcilesWithTotalSupply: true,
      pairIsMain: true,
    },
    liquidity: {
      status: "ok",
      ethUsd: 3000,
      mainPairWeth: 2,
      mainPairUsd: 6000,
      allPairsWeth: 2,
      allPairsUsd: 6000,
      perPair: [],
      usdNote: null,
    },
    ...extra,
  };
}

function parseRow(extra: Record<string, unknown> = {}) {
  const parsed = parseSnapshotFile({
    meta: { snapshotOffsetBlocks: 7200 },
    calibration: { [TOKEN]: baseRow(extra) },
    real: {},
  });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    throw new Error("fixture must parse");
  }
  expect(parsed.value.invalidRows).toEqual([]);
  const row = parsed.value.rows[0];
  if (row === undefined) {
    throw new Error("fixture must hold one row");
  }
  return row;
}

function linearScore(features: readonly number[], weights: readonly number[], bias: number): number {
  let total = bias;
  for (let index = 0; index < weights.length; index += 1) {
    total += (weights[index] ?? 0) * (features[index] ?? 0);
  }
  return total;
}

describe("leakage trap (a): missingness never moves the score", () => {
  test("no feature name leaks status, reason, pair flags or counts", () => {
    const banned = ["missing", "status", "reason", "pair_is_main", "pair_dex", "after_fixture", "pair_count", "unavailable", "error"];
    for (const name of ONCHAIN_FEATURE_NAMES) {
      for (const word of banned) {
        expect(name).not.toContain(word);
      }
    }
  });

  test("leakage carriers change no feature value", () => {
    const plain = snapshotFeaturesOf(parseRow());
    const loaded = parseRow({
      snapshot: { ...baseRow()["snapshot"] as Record<string, unknown>, mainPairDex: "v3", afterFixtureBlock: false },
      pairs: {
        status: "ok",
        value: [
          { dex: "v2", address: PAIR, quote: QUOTE, fee: null, createdBlock: 900, isMain: false, createdAfterSnapshot: true },
        ],
        method: "other",
      },
    });
    // pairIsMain flips to false through a V3 main pair with a side V2 pair.
    const altered = parseRow({
      lpDistribution: { ...(baseRow()["lpDistribution"] as Record<string, unknown>), pairIsMain: false },
    });
    expect(snapshotFeaturesOf(loaded)).toEqual(plain);
    expect(snapshotFeaturesOf(altered)).toEqual(plain);
  });

  test("a missing feature contributes exactly zero to a linear head", () => {
    const weights = ONCHAIN_FEATURE_NAMES.map((_, index) => 0.1 * (index + 1));
    const bias = -0.4;
    const missing = snapshotFeaturesOf(null);
    expect(missing.every((value) => value === 0)).toBe(true);
    expect(linearScore(missing, weights, bias)).toBe(bias);
    // Same token with the holders section missing scores exactly as a
    // model without the holder columns: dropping the columns and their
    // weights leaves every other contribution untouched.
    const row = parseRow({ holders: { status: "unavailable", reason: "transfer_log_cap_exceeded" } });
    const full = snapshotFeaturesOf(row);
    const holderIndex = ONCHAIN_FEATURE_NAMES.indexOf("conc_top1_share");
    expect(full[holderIndex]).toBe(0);
    const kept = full.filter((_, index) => index !== holderIndex);
    const keptWeights = weights.filter((_, index) => index !== holderIndex);
    expect(linearScore(full, weights, bias)).toBe(linearScore(kept, keptWeights, bias));
  });

  test("servable features are a strict subset with documented exclusions", () => {
    for (const name of SERVABLE_FEATURE_NAMES) {
      expect(ONCHAIN_FEATURE_NAMES).toContain(name);
    }
    expect(SERVABLE_FEATURE_NAMES).not.toContain("conc_top1_share");
    expect(SERVABLE_FEATURE_NAMES).not.toContain("liq_log10_1p_weth");
  });
});

describe("leakage trap (b): drained LP never reads as safe", () => {
  test("minimum-liquidity-only supply maps burned to zero and raises the drained flag", () => {
    const row = parseRow({
      lpDistribution: {
        ...(baseRow()["lpDistribution"] as Record<string, unknown>),
        lpSupplyIsMinimumLiquidityOnly: true,
        burnedShare: 1,
      },
    });
    const features = snapshotFeaturesOf(row);
    const burned = features[ONCHAIN_FEATURE_NAMES.indexOf("lp_burned_share")] ?? -1;
    const drained = features[ONCHAIN_FEATURE_NAMES.indexOf("liquidity_removed_24h")] ?? -1;
    expect(burned).toBe(0);
    expect(drained).toBe(1);
    expect(featureAvailable(row, "lp_burned_share")).toBe(false);
    expect(featureAvailable(row, "liquidity_removed_24h")).toBe(true);
  });

  test("a locked share still maps while drained", () => {
    const row = parseRow({
      lpDistribution: {
        ...(baseRow()["lpDistribution"] as Record<string, unknown>),
        lpSupplyIsMinimumLiquidityOnly: true,
        burnedShare: 1,
        lockerShare: 0,
      },
    });
    const features = snapshotFeaturesOf(row);
    expect(features[ONCHAIN_FEATURE_NAMES.indexOf("lp_locker_share")]).toBe(0);
  });
});

describe("leakage trap (c): unreliable holder figures map to zero", () => {
  test("a deviating log-balance sum zeroes top and deployer holder shares", () => {
    const row = parseRow({
      holders: {
        ...(baseRow()["holders"] as Record<string, unknown>),
        logBalanceSumOverSupply: 1 + LOG_BALANCE_TOLERANCE + 0.01,
      },
    });
    expect(holdersReliable(row)).toBe(false);
    const features = snapshotFeaturesOf(row);
    expect(features[ONCHAIN_FEATURE_NAMES.indexOf("conc_top1_share")]).toBe(0);
    expect(features[ONCHAIN_FEATURE_NAMES.indexOf("conc_top10_share")]).toBe(0);
    expect(features[ONCHAIN_FEATURE_NAMES.indexOf("conc_deployer_share")]).toBe(0);
    expect(featureAvailable(row, "conc_top1_share")).toBe(false);
  });

  test("a sum within tolerance keeps the holder figures", () => {
    const row = parseRow({
      holders: {
        ...(baseRow()["holders"] as Record<string, unknown>),
        logBalanceSumOverSupply: 1.02,
      },
    });
    expect(holdersReliable(row)).toBe(true);
    const features = snapshotFeaturesOf(row);
    expect(features[ONCHAIN_FEATURE_NAMES.indexOf("conc_top1_share")]).toBe(0.2);
    expect(features[ONCHAIN_FEATURE_NAMES.indexOf("conc_deployer_share")]).toBe(0.1);
  });
});

describe("leakage trap (d): age cannot proxy for era", () => {
  test("deploy-to-first-liquidity caps at the documented bound", () => {
    const row = parseRow({
      deployBlock: { status: "ok", value: 0 },
      snapshot: { ...(baseRow()["snapshot"] as Record<string, unknown>), firstLiquidityBlock: 10000000, snapshotBlock: 10007200 },
    });
    expect(deployToFirstLiq(row)).toBe(DEPLOY_TO_FIRST_CAP_BLOCKS);
    const features = snapshotFeaturesOf(row);
    expect(features[ONCHAIN_FEATURE_NAMES.indexOf("blocks_deploy_to_first_capped")]).toBe(DEPLOY_TO_FIRST_CAP_BLOCKS);
  });

  test("inverted or unknown endpoints map to neutral zero", () => {
    const inverted = parseRow({ deployBlock: { status: "ok", value: 9000 } });
    expect(deployToFirstLiq(inverted)).toBeNull();
    const features = snapshotFeaturesOf(inverted);
    expect(features[ONCHAIN_FEATURE_NAMES.indexOf("blocks_deploy_to_first_capped")]).toBe(0);
    const unknown = parseRow({ deployBlock: { status: "unavailable", reason: "x" } });
    expect(deployToFirstLiq(unknown)).toBeNull();
  });
});
