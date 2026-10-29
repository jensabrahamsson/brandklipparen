// On-chain feature scaler tests (issue 1): the scaler fits mean/sd on
// TRAIN available values only, test/serve apply the stored TRAIN params,
// and a missing value maps to zero contribution after scaling.
// Synthetic values only.
import { describe, expect, test } from "vitest";
import {
  applyOnchainScaler,
  fitOnchainScaler,
} from "../../../src/domain/onchain/scaler.ts";

const NAMES = ["owner_eoa", "lp_burned_share", "lp_locker_share"];
const isContinuous = (name: string): boolean => name !== "owner_eoa";

const TRAIN_MATRIX = [
  [1, 0.2, 0.4],
  [0, 0.6, 0],
  [1, 0, 0.8],
];
const TRAIN_AVAILABLE = [
  [true, true, true],
  [true, true, false],
  [true, false, true],
];

describe("onchain scaler fit (TRAIN only)", () => {
  test("means use TRAIN available values only, binaries stay unscaled", () => {
    const scaler = fitOnchainScaler(NAMES, isContinuous, TRAIN_MATRIX, TRAIN_AVAILABLE);
    expect(scaler.features).toEqual(NAMES);
    // lp_burned_share available on rows 0,1: mean (0.2+0.6)/2.
    expect(scaler.columns[1]?.mean).toBeCloseTo(0.4, 9);
    // lp_locker_share available on rows 0,2: mean (0.4+0.8)/2.
    expect(scaler.columns[2]?.mean).toBeCloseTo(0.6, 9);
    expect(scaler.columns[1]?.scaled).toBe(true);
    expect(scaler.columns[2]?.scaled).toBe(true);
    // Binary columns are never scaled.
    expect(scaler.columns[0]?.scaled).toBe(false);
    expect(scaler.columns[0]?.mean).toBe(0);
    expect(scaler.columns[0]?.sd).toBe(1);
  });

  test("test/serve rows use the stored TRAIN params, never a refit", () => {
    const scaler = fitOnchainScaler(NAMES, isContinuous, TRAIN_MATRIX, TRAIN_AVAILABLE);
    const mean = scaler.columns[1]?.mean ?? 0;
    const sd = scaler.columns[1]?.sd ?? 1;
    const applied = applyOnchainScaler([0, 0.9, 0.1], [true, true, true], scaler);
    expect(applied[0]).toBe(0);
    expect(applied[1]).toBeCloseTo((0.9 - mean) / sd, 12);
    // A constant TRAIN column floors sd to 1 instead of dividing by zero.
    const constant = fitOnchainScaler(["lp_burned_share"], () => true, [[0.5], [0.5]], [[true], [true]]);
    expect(constant.columns[0]?.sd).toBe(1);
    expect(applyOnchainScaler([0.5], [true], constant)[0]).toBeCloseTo(0, 12);
  });

  test("a missing value contributes exactly zero after scaling", () => {
    const scaler = fitOnchainScaler(NAMES, isContinuous, TRAIN_MATRIX, TRAIN_AVAILABLE);
    const weights = [0.7, -0.5, 1.3];
    const bias = 0.25;
    const linearScore = (features: readonly number[]): number =>
      features.reduce((total, value, index) => total + value * (weights[index] ?? 0), bias);
    // Missing locker share scores the bias plus the other columns only:
    // dropping the missing column and its weight leaves the score unchanged.
    const scaled = applyOnchainScaler([1, 0.2, 999], [true, true, false], scaler);
    expect(scaled[2]).toBe(0);
    const kept = [scaled[0] ?? 0, scaled[1] ?? 0];
    const keptWeights = [weights[0] ?? 0, weights[1] ?? 0];
    expect(linearScore(scaled)).toBe(
      kept.reduce((total, value, index) => total + value * (keptWeights[index] ?? 0), bias),
    );
  });
});
