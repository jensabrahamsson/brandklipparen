// Unit tests for L2 logistic fitting and Platt scaling.
// Tiny synthetic matrices only.
import { describe, expect, test } from "vitest";
import {
  applyPlattScaling,
  fitCalibratedHead,
  fitPlattScaling,
  fitWeightedLogistic,
  predictProbability,
} from "../../../src/domain/calibrationFit.ts";

describe("weighted logistic fitting", () => {
  test("separates a tiny two-point problem", () => {
    const fit = fitWeightedLogistic(
      [
        [0],
        [1],
      ],
      [0, 1],
      [1, 1],
      0.1,
      200,
      0.5,
    );
    expect(predictProbability([0], fit)).toBeLessThan(0.5);
    expect(predictProbability([1], fit)).toBeGreaterThan(0.5);
  });

  test("same inputs give identical outputs", () => {
    const first = fitWeightedLogistic(
      [
        [0, 1],
        [1, 0],
      ],
      [0, 1],
      [1, 1],
      1,
      100,
      0.5,
    );
    const second = fitWeightedLogistic(
      [
        [0, 1],
        [1, 0],
      ],
      [0, 1],
      [1, 1],
      1,
      100,
      0.5,
    );
    expect(first).toEqual(second);
  });

  test("platt scaling maps raw logits to probabilities", () => {
    const scaled = fitPlattScaling([-2, -1, 1, 2], [0, 0, 1, 1], [1, 1, 1, 1], 0, 200, 0.5);
    expect(scaled.slope).toBeGreaterThan(0);
    expect(Number.isFinite(scaled.intercept)).toBe(true);
  });

  test("non-negative constraint never learns a protective weight", () => {
    const features = [[1], [1], [1], [0], [0], [0]];
    const labels = [0, 0, 0, 1, 1, 1] as (0 | 1)[];
    const weights = [1, 1, 1, 1, 1, 1];
    const free = fitWeightedLogistic(features, labels, weights, 0.1, 200, 0.5);
    expect(free.weights[0] ?? 0).toBeLessThan(0);
    const constrained = fitWeightedLogistic(features, labels, weights, 0.1, 200, 0.5, { nonNegative: [true] });
    expect(constrained.weights[0] ?? -1).toBe(0);
  });

  test("non-positive constraint never learns a risk-increasing weight", () => {
    const features = [[0], [0], [0], [1], [1], [1]];
    const labels = [0, 0, 0, 1, 1, 1] as (0 | 1)[];
    const weights = [1, 1, 1, 1, 1, 1];
    const free = fitWeightedLogistic(features, labels, weights, 0.1, 200, 0.5);
    expect(free.weights[0] ?? 0).toBeGreaterThan(0);
    const constrained = fitWeightedLogistic(features, labels, weights, 0.1, 200, 0.5, { nonPositive: [true] });
    expect(constrained.weights[0] ?? 1).toBe(0);
  });

  test("platt slope floors at zero on inverted data and the map stays monotone", () => {
    const scaled = fitPlattScaling([2, 1, -1, -2], [0, 0, 1, 1], [1, 1, 1, 1], 0, 200, 0.5);
    expect(scaled.slope).toBeGreaterThanOrEqual(0);
    expect(scaled.slope).toBe(0);
    let previous = -Infinity;
    for (let logit = -6; logit <= 6; logit += 1) {
      const next = applyPlattScaling(logit, scaled);
      expect(next).toBeGreaterThanOrEqual(previous);
      previous = next;
    }
  });

  test("calibrated head falls back to the prior without monotone signal", () => {
    const prior = { bias: -0.5, slope: 1.0, intercept: 0.0 };
    const none = fitCalibratedHead([[1], [0]], [0, 0], [1, 1], 0.1, prior, [true]);
    expect(none.uncalibrated).toBe(true);
    expect(none.slope).toBe(prior.slope);
    expect(none.bias).toBe(prior.bias);
    const inverted = fitCalibratedHead([[1], [1], [0], [0]], [0, 0, 1, 1], [1, 1, 1, 1], 0.1, prior, [true]);
    expect(inverted.uncalibrated).toBe(true);
    expect(inverted.slope).toBe(prior.slope);
    const separable = fitCalibratedHead([[0], [0], [1], [1]], [0, 0, 1, 1], [1, 1, 1, 1], 0.1, prior, [true]);
    expect(separable.uncalibrated).toBe(false);
    expect(separable.slope).toBeGreaterThan(0);
    expect(separable.weights[0] ?? -1).toBeGreaterThanOrEqual(0);
  });
});
