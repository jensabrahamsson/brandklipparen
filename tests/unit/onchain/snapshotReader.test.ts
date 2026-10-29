// Snapshot reader tests against a small SYNTHETIC fixture mirroring the
// real schema (synthetic 0x0102 addresses only): valid parse, field
// statuses, block-offset violations, strict per-row validation with
// reported counts, and join by id. No real addresses or values here.
import { describe, expect, test } from "vitest";
import {
  ONCHAIN_FEATURE_NAMES,
  checkSnapshotOffsets,
  featureAvailable,
  indexSnapshotById,
  parseSnapshotFile,
  snapshotFeaturesOf,
} from "../../../src/domain/onchain/snapshot.ts";
import { loadOnchainSnapshotFile } from "../../../src/adapters/onchain/snapshotFile.ts";
import { joinOnchainSnapshot } from "../../../src/application/onchainCalibration.ts";
import { syntheticAddress } from "../../helpers/syntheticAddresses.ts";

const TOKEN_A = syntheticAddress(101);
const TOKEN_B = syntheticAddress(102);
const TOKEN_C = syntheticAddress(103);
const PAIR = syntheticAddress(104);
const QUOTE = syntheticAddress(105);
const DEPLOYER = syntheticAddress(106);

function okSnapshot(firstLiquidityBlock: number) {
  return {
    status: "ok",
    snapshotBlock: firstLiquidityBlock + 7200,
    firstLiquidityBlock,
    mainPair: PAIR,
    mainPairDex: "v2",
    mainPairQuote: QUOTE,
    afterFixtureBlock: false,
  };
}

function okRow(firstLiquidityBlock: number, extra: Record<string, unknown> = {}) {
  return {
    address: TOKEN_A,
    snapshot: okSnapshot(firstLiquidityBlock),
    pairs: { status: "ok", value: [], method: "test" },
    deployBlock: { status: "ok", value: firstLiquidityBlock - 100 },
    deployer: { status: "ok", value: DEPLOYER, method: "top_level_create_tx" },
    owner: {
      status: "ok",
      owner: { address: DEPLOYER, class: "eoa" },
      getOwner: { address: null, class: "n/a" },
    },
    totalSupply: { status: "ok", value: "1000000", decimals: 18 },
    deployerShare: { status: "ok", value: 0.1 },
    ownerShare: { status: "ok", value: 0.1, ownerIsDeployer: true },
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

function fileOf(rows: Record<string, Record<string, unknown>>) {
  return { meta: { snapshotOffsetBlocks: 7200 }, calibration: rows, real: {} };
}

describe("snapshot reader against the real schema", () => {
  test("a valid file parses with rows keyed by address", () => {
    const parsed = parseSnapshotFile(fileOf({ [TOKEN_A]: okRow(1000) }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.offsetBlocks).toBe(7200);
    expect(parsed.value.rows).toHaveLength(1);
    expect(parsed.value.rows[0]?.id).toBe(TOKEN_A.toLowerCase());
    expect(parsed.value.invalidRows).toEqual([]);
  });

  test("unavailable sections parse with their reason and map to neutral", () => {
    const row = okRow(1000, {
      holders: { status: "unavailable", reason: "transfer_log_cap_exceeded" },
      lpDistribution: { status: "unavailable", reason: "v3_position_nft", pairIsMain: false },
    });
    const parsed = parseSnapshotFile(fileOf({ [TOKEN_A]: row }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const features = snapshotFeaturesOf(parsed.value.rows[0] ?? null);
    expect(features).toHaveLength(ONCHAIN_FEATURE_NAMES.length);
    expect(featureAvailable(parsed.value.rows[0] ?? null, "conc_top1_share")).toBe(false);
    expect(featureAvailable(parsed.value.rows[0] ?? null, "lp_burned_share")).toBe(false);
  });

  test("offset violations carry positions and blocks, never addresses", () => {
    const row = okRow(1000);
    (row.snapshot as Record<string, unknown>)["snapshotBlock"] = 9999;
    const parsed = parseSnapshotFile(fileOf({ [TOKEN_A]: row }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const { checked, violations } = checkSnapshotOffsets(parsed.value);
    expect(checked).toBe(1);
    expect(violations).toHaveLength(1);
    expect(JSON.stringify(violations[0])).not.toContain(TOKEN_A.toLowerCase());
    expect(violations[0]?.expectedBlock).toBe(1000 + 7200);
  });

  test("rows that fail validation are reported by count and reason", () => {
    const bad = okRow(1000, { deployerShare: { status: "ok", value: 7 } });
    const mismatch = okRow(1000);
    const parsed = parseSnapshotFile(fileOf({ [TOKEN_A]: bad, [TOKEN_B]: mismatch, [TOKEN_C]: okRow(2000, { address: TOKEN_C }) }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.rows).toHaveLength(1);
    expect(parsed.value.invalidRows).toHaveLength(2);
    for (const invalid of parsed.value.invalidRows) {
      expect(typeof invalid.reason).toBe("string");
      expect(invalid.reason.length).toBeGreaterThan(0);
    }
  });

  test("unknown statuses and non-address keys fail loudly", () => {
    const row = okRow(1000, { owner: { status: "maybe", reason: "x" } });
    const parsed = parseSnapshotFile(fileOf({ [TOKEN_A]: row, ["not-an-address"]: okRow(1000) }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.rows).toHaveLength(0);
    expect(parsed.value.invalidRows).toHaveLength(2);
  });

  test("join is by lowercase id with explicit matched and missing counts", () => {
    const parsed = parseSnapshotFile(fileOf({ [TOKEN_A]: okRow(1000) }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const joined = joinOnchainSnapshot(
      [{ address: TOKEN_A.toUpperCase() }, { address: TOKEN_B }],
      parsed.value,
    );
    expect(joined.matched).toBe(1);
    expect(joined.missing).toBe(1);
    expect(joined.matrix).toHaveLength(2);
    expect(joined.deployBlocks[0]).toBe(900);
    expect(joined.snapshotBlocks[0]).toBe(8200);
    expect(joined.snapshotBlocks[1]).toBeNull();
  });

  test("duplicate snapshot rows count once with first row winning", () => {
    const parsed = parseSnapshotFile(fileOf({ [TOKEN_A]: okRow(1000) }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const doubled = { ...parsed.value, rows: Object.freeze([...parsed.value.rows, ...parsed.value.rows]) };
    const { byId, duplicates } = indexSnapshotById(doubled);
    expect(duplicates).toBe(1);
    expect(byId.size).toBe(1);
  });

  test("a missing snapshot file fails loudly, never silently", () => {
    const loaded = loadOnchainSnapshotFile("/nonexistent-path-010203/onchain-snapshot.json");
    expect(loaded.ok).toBe(false);
  });
});
