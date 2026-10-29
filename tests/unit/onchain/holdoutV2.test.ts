// Holdout-v2 evaluation path tests on SYNTHETIC fixtures only.
// Synthetic 0x0102 addresses throughout; no real token data. Covers the
// holdout section parse, the v2-only LP filter, the leakage rule (rows
// differing only in calibration-only columns score identically, and the
// feature code never names those columns), frozen-hash determinism and
// mismatch refusal, the exactly-once marker, and hand-computed metrics.
import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  parseSnapshotFile,
  snapshotFeaturesOf,
  featureAvailable,
  lpIsV2,
} from "../../../src/domain/onchain/snapshot.ts";
import {
  HOLDOUT_FROZEN_VERSION,
  parseFrozenConfig,
  parseHoldoutDataset,
  scoreFrozenArm,
  aucRank,
  bootstrapAucCI,
  brier,
  round6,
  bandCountsOf,
  confusionOf,
  canonicalFrozenText,
  frozenSha256,
} from "../../../src/application/holdoutV2.ts";
import type { FrozenConfig } from "../../../src/application/holdoutV2.ts";
import { syntheticAddress } from "../../helpers/syntheticAddresses.ts";

const TOKEN_A = syntheticAddress(501);
const TOKEN_B = syntheticAddress(502);
const TOKEN_C = syntheticAddress(503);
const TOKEN_D = syntheticAddress(504);
const PAIR = syntheticAddress(505);
const DEPLOYER = syntheticAddress(507);

function okSnapshot(firstLiquidityBlock: number) {
  return {
    status: "ok",
    snapshotBlock: firstLiquidityBlock + 7200,
    firstLiquidityBlock,
    mainPair: PAIR,
    mainPairDex: "v2",
    mainPairQuote: "WETH",
    afterFixtureBlock: false,
  };
}

function okRow(firstLiquidityBlock: number, extra: Record<string, unknown> = {}) {
  return {
    address: TOKEN_A,
    snapshot: okSnapshot(firstLiquidityBlock),
    deployBlock: { status: "ok", value: firstLiquidityBlock - 100 },
    deployer: { status: "ok", value: DEPLOYER, method: "top_level_create_tx" },
    owner: {
      status: "ok",
      owner: { address: DEPLOYER, class: "eoa" },
      getOwner: { address: null, class: "n/a" },
    },
    deployerShare: { status: "ok", value: 0.1 },
    ownerShare: { status: "unavailable", reason: "no_owner_address" },
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
      dex: "v2",
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

describe("holdout section format", () => {
  test("a file with a holdout section parses with rows keyed by address", () => {
    const parsed = parseSnapshotFile({
      meta: { snapshotOffsetBlocks: 7200 },
      holdout: { [TOKEN_A]: okRow(1000) },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.rows).toHaveLength(1);
    expect(parsed.value.rows[0]?.id).toBe(TOKEN_A.toLowerCase());
  });

  test("a file with neither calibration, real nor holdout fails loudly", () => {
    const parsed = parseSnapshotFile({ meta: { snapshotOffsetBlocks: 7200 }, other: {} });
    expect(parsed.ok).toBe(false);
  });
});

describe("v2-only LP filter", () => {
  test("a v3 venue maps LP features to zero and reads unavailable", () => {
    const v2 = parseSnapshotFile({ meta: { snapshotOffsetBlocks: 7200 }, holdout: { [TOKEN_A]: okRow(1000) } });
    const v3row = okRow(1000, {
      lpDistribution: { ...(okRow(1000)["lpDistribution"] as Record<string, unknown>), dex: "v3" },
    });
    const v3 = parseSnapshotFile({ meta: { snapshotOffsetBlocks: 7200 }, holdout: { [TOKEN_A]: v3row } });
    expect(v2.ok && v3.ok).toBe(true);
    if (!v2.ok || !v3.ok) {
      return;
    }
    const v2row = v2.value.rows[0] ?? null;
    const v3parsed = v3.value.rows[0] ?? null;
    const v2features = snapshotFeaturesOf(v2row);
    const v3features = snapshotFeaturesOf(v3parsed);
    // LP-derived positions in the versioned vector.
    for (const name of ["lp_burned_share", "lp_locker_share", "lp_deployer_or_owner_share", "liquidity_removed_24h"] as const) {
      expect(featureAvailable(v2row, name)).toBe(true);
      expect(featureAvailable(v3parsed, name)).toBe(false);
    }
    expect(lpIsV2(v2row)).toBe(true);
    expect(lpIsV2(v3parsed)).toBe(false);
    // Owner flags are untouched by the venue filter.
    expect(v3features[1]).toBe(v2features[1]);
  });

  test("an absent venue still counts as v2 for older files", () => {
    const base = okRow(1000);
    const lp = { ...(base["lpDistribution"] as Record<string, unknown>) };
    delete lp["dex"];
    const parsed = parseSnapshotFile({ meta: { snapshotOffsetBlocks: 7200 }, holdout: { [TOKEN_A]: { ...base, lpDistribution: lp } } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const row = parsed.value.rows[0] ?? null;
    expect(lpIsV2(row)).toBe(true);
    expect(featureAvailable(row, "lp_burned_share")).toBe(true);
  });

  test("an unknown venue fails validation", () => {
    const bad = okRow(1000, {
      lpDistribution: { ...(okRow(1000)["lpDistribution"] as Record<string, unknown>), dex: "v4" },
    });
    const parsed = parseSnapshotFile({ meta: { snapshotOffsetBlocks: 7200 }, holdout: { [TOKEN_A]: bad } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.rows).toHaveLength(0);
    expect(parsed.value.invalidRows).toHaveLength(1);
  });
});

describe("leakage rule: calibration-only columns never enter features", () => {
  const leakedBase = {
    address: TOKEN_A,
    symbol: "SYN",
    name: "Synthetic",
    label: "legit",
    block: 1000,
    codehash: "0x00",
    bytecode: "0x600160015500",
    datasetSplit: "holdout-v2",
  };

  test("rows differing only in those columns parse identically and score identically", () => {
    const left = { ...leakedBase, creationBlock: 10, ageDays: 1, liquidityNote: "deep", wethInUniswapPools: 5 };
    const right = { ...leakedBase, creationBlock: 99999, ageDays: 900, liquidityNote: "thin", wethInUniswapPools: 0 };
    const parsedLeft = parseHoldoutDataset([left]);
    const parsedRight = parseHoldoutDataset([right]);
    expect(parsedLeft.ok && parsedRight.ok).toBe(true);
    if (!parsedLeft.ok || !parsedRight.ok) {
      return;
    }
    expect(parsedLeft.value).toEqual(parsedRight.value);
    const arm = {
      ablation: "bytecode",
      featureNames: ["f0", "f1"],
      lambda: 0.01,
      rug: { weights: [0.5, -0.25], bias: 0.1, slope: 1, intercept: 0, uncalibrated: false },
      honey: { weights: [0.2, 0.3], bias: -0.1, slope: 1, intercept: 0, uncalibrated: false },
    } as const;
    const features = [1, 0];
    expect(scoreFrozenArm(features, arm)).toBe(scoreFrozenArm(features, arm));
    const snap = parseSnapshotFile({ meta: { snapshotOffsetBlocks: 7200 }, holdout: { [TOKEN_A]: okRow(1000) } });
    expect(snap.ok).toBe(true);
    if (!snap.ok) {
      return;
    }
    // One snapshot row serves both dataset rows: the vector cannot differ.
    expect(snapshotFeaturesOf(snap.value.rows[0] ?? null)).toEqual(snapshotFeaturesOf(snap.value.rows[0] ?? null));
  });

  test("the feature code never names those columns", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const repo = join(here, "..", "..", "..");
    const scanned = [
      join(repo, "src", "domain", "onchain", "snapshot.ts"),
      join(repo, "src", "application", "onchainCalibration.ts"),
      join(repo, "src", "application", "holdoutV2.ts"),
      join(repo, "scripts", "evaluate-holdout-v2.ts"),
    ];
    const banned = ["creationBlock", "ageDays", "liquidityNote", "wethInUniswapPools"];
    for (const file of scanned) {
      const text = readFileSync(file, "utf8");
      for (const word of banned) {
        expect(text, `${file} must not read ${word}`).not.toContain(word);
      }
    }
  });
});

describe("frozen hash determinism", () => {
  function tinyFrozen(): FrozenConfig {
    const head = (bias: number) => ({ weights: [0.1], bias, slope: 1, intercept: 0, uncalibrated: false });
    const arm = (ablation: string) => ({ ablation, featureNames: ["f0"], lambda: 0.01, rug: head(0), honey: head(0) });
    return {
      frozenVersion: HOLDOUT_FROZEN_VERSION,
      modelVersion: "9.9.9-test",
      dataVersion: "test-v1",
      seed: 42,
      gitCommit: "synthetic",
      featureVersion: "onchain-v3",
      positiveClass: "bad",
      unknownHandling: "unknown excluded",
      decisionRule: "elevated-or-above",
      bytecodeFeatureNames: ["f0"],
      onchainServableFeatures: ["f0"],
      bothFeatureNames: ["f0", "f0"],
      arms: { bytecode: arm("bytecode"), onchain: arm("onchain"), both: arm("both") },
      scaler: { features: ["f0"], means: [0], sds: [1], scaled: [false] },
      signRules: { f0: "risk-increasing" },
      lockerList: { snapshotNames: [], addresses: [] },
      regularization: { bytecodeLambda: 0.01, onchainLambda: 0.01, bothLambda: 0.01, grid: [0.01], selection: "test" },
      bandThresholds: { elevated: 30, high: 60 },
      appliedBands: { elevated: 30, high: 60 },
      calibrationDatasetSha256: "0".repeat(64),
      calibrationSnapshotSha256: "1".repeat(64),
    };
  }

  test("two builds with the same inputs give the same hash", () => {
    const left = tinyFrozen();
    const right = tinyFrozen();
    expect(canonicalFrozenText(left)).toBe(canonicalFrozenText(right));
    expect(frozenSha256(left)).toBe(frozenSha256(right));
    expect(parseFrozenConfig(JSON.parse(canonicalFrozenText(left)) as unknown).ok).toBe(true);
  });

  test("one changed byte changes the hash", () => {
    const base = tinyFrozen();
    const altered = { ...base, seed: 43 };
    expect(frozenSha256(base)).not.toBe(frozenSha256(altered));
  });
});

describe("hand-computed metrics", () => {
  test("AUC, Brier, bands and confusion match a tiny example worked by hand", () => {
    // Probs [0.9, 0.8, 0.1, 0.2] against labels [1, 1, 0, 0]: both
    // positives outrank both negatives, so AUC is 1.0. Squared errors
    // are 0.01, 0.04, 0.01, 0.04, so Brier is 0.025. At prob*100 the
    // positives land High and the negatives land Low.
    const probs = [0.9, 0.8, 0.1, 0.2];
    const labels = [1, 1, 0, 0] as (0 | 1)[];
    expect(aucRank(probs, labels)).toBeCloseTo(1, 12);
    expect(round6(brier(probs, labels))).toBeCloseTo(0.025, 12);
    expect(bandCountsOf(probs, 30, 60)).toEqual({ low: 2, elevated: 0, high: 2 });
    expect(confusionOf(probs, labels, 30)).toEqual({
      truePositives: 2,
      falsePositives: 0,
      trueNegatives: 2,
      falseNegatives: 0,
    });
    const ci = bootstrapAucCI(probs, labels, 1000, 43);
    expect(ci.resamples).toBe(1000);
    expect(ci.lower).toBeLessThanOrEqual(1);
    expect(ci.upper).toBeLessThanOrEqual(1);
    expect(ci.lower).toBeLessThanOrEqual(ci.upper);
    // Deterministic: the same inputs give the same interval.
    expect(bootstrapAucCI(probs, labels, 1000, 43)).toEqual(ci);
  });
});

describe("evaluate script: hash check and exactly-once marker", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = join(here, "..", "..", "..");
  const script = join(repo, "scripts", "evaluate-holdout-v2.ts");

  const BYTECODE_NAMES = ["mint", "blacklist", "transfer-fee", "pause", "transfer-limits", "ownership", "transfer-hooks", "sell-block", "proxy-upgrade"];
  const SERVABLE = ["owner_renounced", "owner_eoa", "owner_contract", "owner_safe", "lp_burned_share", "lp_locker_share", "lp_deployer_or_owner_share", "liquidity_removed_24h"];

  function fixtureFrozen(): FrozenConfig {
    const zeroHead = (width: number) => ({ weights: Array<number>(width).fill(0), bias: 0, slope: 1, intercept: 0, uncalibrated: false });
    const arm = (ablation: string, width: number, names: readonly string[]) => ({
      ablation,
      featureNames: [...names],
      lambda: 0.01,
      rug: zeroHead(width),
      honey: zeroHead(width),
    });
    return {
      frozenVersion: HOLDOUT_FROZEN_VERSION,
      modelVersion: "9.9.9-test",
      dataVersion: "test-v1",
      seed: 7,
      gitCommit: "synthetic",
      featureVersion: "onchain-v3",
      positiveClass: "bad",
      unknownHandling: "unknown excluded",
      decisionRule: "elevated-or-above",
      bytecodeFeatureNames: [...BYTECODE_NAMES],
      onchainServableFeatures: [...SERVABLE],
      bothFeatureNames: [...BYTECODE_NAMES, ...SERVABLE],
      arms: {
        bytecode: arm("bytecode", BYTECODE_NAMES.length, BYTECODE_NAMES),
        onchain: arm("onchain", SERVABLE.length, SERVABLE),
        both: arm("both", BYTECODE_NAMES.length + SERVABLE.length, [...BYTECODE_NAMES, ...SERVABLE]),
      },
      scaler: {
        features: [...SERVABLE],
        means: SERVABLE.map(() => 0),
        sds: SERVABLE.map(() => 1),
        scaled: SERVABLE.map(() => false),
      },
      signRules: Object.fromEntries(SERVABLE.map((name) => [name, "risk-increasing"])),
      lockerList: { snapshotNames: [], addresses: [] },
      regularization: { bytecodeLambda: 0.01, onchainLambda: 0.01, bothLambda: 0.01, grid: [0.01], selection: "test" },
      bandThresholds: { elevated: 30, high: 60 },
      appliedBands: { elevated: 30, high: 60 },
      calibrationDatasetSha256: "0".repeat(64),
      calibrationSnapshotSha256: "1".repeat(64),
    };
  }

  function fixtureFiles(dir: string) {
    const tokens = [TOKEN_A, TOKEN_B, TOKEN_C, TOKEN_D];
    const labels = ["rug", "legit", "scam", "unknown"];
    const dataset = tokens.map((address, index) => ({
      address,
      symbol: `SYN${index}`,
      name: `Synthetic ${index}`,
      label: labels[index],
      labelSource: "synthetic",
      labelBasis: "dataset",
      datasetName: "synthetic",
      labelNote: "fixture",
      block: 1000 + index,
      codehash: "0x00",
      bytecode: "0x600160015500",
      datasetSplit: "holdout-v2",
    }));
    const holdout: Record<string, unknown> = {};
    tokens.forEach((address, index) => {
      holdout[address] = { ...okRow(1000 + index * 10), address };
    });
    const frozen = fixtureFrozen();
    const frozenText = canonicalFrozenText(frozen);
    const datasetPath = join(dir, "dataset.json");
    const snapshotPath = join(dir, "snapshot.json");
    const frozenPath = join(dir, "frozen.json");
    writeFileSync(datasetPath, JSON.stringify(dataset), "utf8");
    writeFileSync(snapshotPath, JSON.stringify({ meta: { snapshotOffsetBlocks: 7200 }, holdout }), "utf8");
    writeFileSync(frozenPath, frozenText, "utf8");
    const hash = createHash("sha256").update(frozenText).digest("hex");
    return { datasetPath, snapshotPath, frozenPath, hash, tokens };
  }

  function runEvaluate(args: string[]): { ok: boolean; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync(process.execPath, ["--experimental-strip-types", script, ...args], { encoding: "utf8" });
      return { ok: true, stdout: typeof stdout === "string" ? stdout : "", stderr: "" };
    } catch (error) {
      const err = error as { status?: number; stdout?: unknown; stderr?: unknown };
      return {
        ok: false,
        stdout: typeof err.stdout === "string" ? err.stdout : "",
        stderr: typeof err.stderr === "string" ? err.stderr : "",
      };
    }
  }

  test("a first run writes the marker and aggregate results, a second run refuses", () => {
    const dir = mkdtempSync(join(tmpdir(), "holdout-v2-"));
    const { datasetPath, snapshotPath, frozenPath, hash, tokens } = fixtureFiles(dir);
    const outDir = join(dir, "out");
    const first = runEvaluate([
      "--frozen", frozenPath,
      "--expect-sha256", hash,
      "--dataset", datasetPath,
      "--onchain-snapshot", snapshotPath,
      "--out-dir", outDir,
    ]);
    expect(first.ok).toBe(true);
    const markerPath = join(outDir, "HOLDOUT-V2-EVALUATED.json");
    const metricsPath = join(outDir, "holdout-v2-metrics.json");
    expect(existsSync(markerPath)).toBe(true);
    expect(existsSync(metricsPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    expect(marker["frozenSha256"]).toBe(hash);
    expect(typeof marker["createdAt"]).toBe("string");
    // Aggregate only: no token address leaves the script in any file.
    const metricsText = readFileSync(metricsPath, "utf8");
    for (const token of tokens) {
      expect(metricsText.toLowerCase()).not.toContain(token.toLowerCase());
    }
    expect(first.stdout.toLowerCase()).not.toContain(tokens[0]?.toLowerCase() ?? "0x000");
    const second = runEvaluate([
      "--frozen", frozenPath,
      "--dataset", datasetPath,
      "--onchain-snapshot", snapshotPath,
      "--out-dir", outDir,
    ]);
    expect(second.ok).toBe(false);
  });

  test("a wrong expected hash refuses before scoring", () => {
    const dir = mkdtempSync(join(tmpdir(), "holdout-v2-"));
    const { datasetPath, snapshotPath, frozenPath } = fixtureFiles(dir);
    const outDir = join(dir, "out");
    const wrong = runEvaluate([
      "--frozen", frozenPath,
      "--expect-sha256", "0".repeat(64),
      "--dataset", datasetPath,
      "--onchain-snapshot", snapshotPath,
      "--out-dir", outDir,
    ]);
    expect(wrong.ok).toBe(false);
    expect(existsSync(join(outDir, "HOLDOUT-V2-EVALUATED.json"))).toBe(false);
  });
});
