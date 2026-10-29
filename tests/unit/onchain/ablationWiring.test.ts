// Ablation wiring on tiny synthetic data: the join plus constrained
// heads produce one metric triple per arm (bytecode, onchain, both) with
// missing rows scoring at zero contribution. Synthetic addresses only.
import { describe, expect, test } from "vitest";
import { fitCalibratedHead } from "../../../src/domain/calibrationFit.ts";
import {
  ONCHAIN_FEATURE_NAMES,
  SERVABLE_FEATURE_NAMES,
  parseSnapshotFile,
  snapshotFeaturesOf,
} from "../../../src/domain/onchain/snapshot.ts";
import { joinOnchainSnapshot, rankAUC } from "../../../src/application/onchainCalibration.ts";
import { syntheticAddress } from "../../helpers/syntheticAddresses.ts";

const BAD_A = syntheticAddress(131);
const BAD_B = syntheticAddress(132);
const GOOD_A = syntheticAddress(133);
const GOOD_B = syntheticAddress(134);
const PAIR = syntheticAddress(135);
const DEPLOYER = syntheticAddress(137);

function row(concentration: number, burned: number) {
  return {
    address: BAD_A,
    snapshot: {
      status: "ok",
      snapshotBlock: 8200,
      firstLiquidityBlock: 1000,
      mainPair: PAIR,
      mainPairDex: "v2",
      mainPairQuote: "WETH",
      afterFixtureBlock: false,
    },
    pairs: { status: "ok", value: [], method: "test" },
    deployBlock: { status: "ok", value: 500 },
    deployer: { status: "ok", value: DEPLOYER, method: "top_level_create_tx" },
    owner: {
      status: "ok",
      owner: { address: DEPLOYER, class: "eoa" },
      getOwner: { address: null, class: "n/a" },
    },
    totalSupply: { status: "ok", value: "1000000", decimals: 18 },
    deployerShare: { status: "ok", value: concentration },
    ownerShare: { status: "unavailable", reason: "no_owner_address" },
    holders: {
      status: "ok",
      top1Share: concentration,
      top10Share: concentration,
      holderCountFromLogs: 4,
      transferLogCount: 9,
      logBalanceSumOverSupply: 1,
      method: "test",
    },
    lpDistribution: {
      status: "ok",
      pair: PAIR,
      lpTotalSupply: "1000",
      lpSupplyIsMinimumLiquidityOnly: false,
      burnedShare: burned,
      lockerShare: 0,
      lockerBreakdown: {},
      deployerOrOwnerShare: 0,
      otherShare: 1 - burned,
      lpHolderCount: 2,
      lpTransferLogCount: 3,
      reconcilesWithTotalSupply: true,
      pairIsMain: true,
    },
    liquidity: {
      status: "ok",
      ethUsd: 3000,
      mainPairWeth: 1,
      mainPairUsd: 3000,
      allPairsWeth: 1,
      allPairsUsd: 3000,
      perPair: [],
      usdNote: null,
    },
  };
}

describe("ablation wiring on tiny synthetic data", () => {
  test("bytecode, onchain and both arms each report a train AUC", () => {
    const parsed = parseSnapshotFile({
      meta: { snapshotOffsetBlocks: 7200 },
      calibration: {
        [BAD_A]: { ...row(0.9, 0), address: BAD_A },
        [BAD_B]: { ...row(0.8, 0.1), address: BAD_B },
        [GOOD_A]: { ...row(0.05, 0.9), address: GOOD_A },
        [GOOD_B]: { ...row(0.1, 0.8), address: GOOD_B },
      },
      real: {},
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const rows = [{ address: BAD_A }, { address: BAD_B }, { address: GOOD_A }, { address: GOOD_B }];
    const joined = joinOnchainSnapshot(rows, parsed.value);
    expect(joined.matched).toBe(4);
    expect(joined.missing).toBe(0);
    const labels = [1, 1, 0, 0] as (0 | 1)[];
    const weights = [1, 1, 1, 1];
    const prior = { bias: 0, slope: 1, intercept: 0 };
    const servableIndex = SERVABLE_FEATURE_NAMES.map((name) => ONCHAIN_FEATURE_NAMES.indexOf(name));
    const onchainMatrix = joined.matrix.map((vector) => servableIndex.map((col) => vector[col] ?? 0));
    const bytecodeMatrix = [[1, 0], [1, 0], [0, 1], [0, 1]];
    const bothMatrix = bytecodeMatrix.map((base, index) => [...base, ...(onchainMatrix[index] ?? [])]);
    const fitArm = (matrix: readonly (readonly number[])[]) => ({
      rug: fitCalibratedHead(matrix, labels, weights, 0.1, prior, matrix[0]?.map(() => true) ?? [], 200, 0.5),
      honey: fitCalibratedHead(matrix, labels, weights, 0.1, prior, matrix[0]?.map(() => true) ?? [], 200, 0.5),
    });
    type Head = { readonly weights: readonly number[]; readonly bias: number; readonly slope: number; readonly intercept: number };
    const probsOf = (
      matrix: readonly (readonly number[])[],
      arm: { readonly rug: Head; readonly honey: Head },
    ): number[] =>
      matrix.map((features) => {
        const rug = arm.rug.weights.reduce((total, weight, index) => total + weight * (features[index] ?? 0), arm.rug.bias);
        const honey = arm.honey.weights.reduce((total, weight, index) => total + weight * (features[index] ?? 0), arm.honey.bias);
        return Math.max(rug, honey);
      });
    for (const matrix of [bytecodeMatrix, onchainMatrix, bothMatrix]) {
      const arm = fitArm(matrix);
      const auc = rankAUC(probsOf(matrix, arm), labels);
      expect(auc).toBeGreaterThanOrEqual(0);
      expect(auc).toBeLessThanOrEqual(1);
    }
    // A row without a snapshot match scores the all-zero neutral vector.
    const missing = joinOnchainSnapshot([{ address: syntheticAddress(138) }], parsed.value);
    expect(missing.missing).toBe(1);
    expect((missing.matrix[0] ?? []).every((value) => value === 0)).toBe(true);
    expect(snapshotFeaturesOf(null).every((value) => value === 0)).toBe(true);
  });
});
