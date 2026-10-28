// Tilt helper coverage (S-114, K-021, K-103).
// Written first per A-21 (red): ./tilt.ts does not exist yet. Tilt stays
// small, flat-text safe and off under reduced motion: the pure helpers
// below pin the angle clamp and the reduced-motion gate the hook reads.
import { describe, expect, test } from "vitest";
import { MAX_TILT_DEG, clampTilt, tiltVars } from "./tilt.ts";

describe("tilt helpers (S-114)", () => {
  test("tilt_respects_reduced_motion", () => {
    expect(tiltVars(0.5, 0.5, true)).toEqual({});
    const applied = tiltVars(1, 0, false);
    expect(applied["--tilt-rx"]).toBeDefined();
    expect(applied["--tilt-ry"]).toBeDefined();
  });

  test("tilt_angles_stay_small_and_clamped", () => {
    expect(MAX_TILT_DEG).toBeLessThanOrEqual(5);
    expect(clampTilt(100)).toBe(MAX_TILT_DEG);
    expect(clampTilt(-100)).toBe(-MAX_TILT_DEG);
    expect(clampTilt(2)).toBe(2);
    const corners = tiltVars(0, 0, false);
    const rx = Number.parseFloat((corners["--tilt-rx"] ?? "0deg").replace("deg", ""));
    const ry = Number.parseFloat((corners["--tilt-ry"] ?? "0deg").replace("deg", ""));
    expect(Math.abs(rx)).toBeLessThanOrEqual(MAX_TILT_DEG);
    expect(Math.abs(ry)).toBeLessThanOrEqual(MAX_TILT_DEG);
  });
});
