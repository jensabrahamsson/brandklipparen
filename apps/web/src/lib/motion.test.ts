// Reduced-motion flag coverage: the shared hook answers what the viewer
// preference reports, with no motion of its own.
import { afterEach, describe, expect, test, vi } from "vitest";
import { reducedMotionRequested, useReducedMotion } from "./motion.ts";

function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({ matches: matches && query.includes("reduce"), media: query }),
  });
}

describe("reduced motion flag", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("motion_flag_follows_media_query", () => {
    stubMatchMedia(true);
    expect(reducedMotionRequested()).toBe(true);
    expect(useReducedMotion()).toBe(true);
    stubMatchMedia(false);
    expect(reducedMotionRequested()).toBe(false);
    expect(useReducedMotion()).toBe(false);
  });

  test("motion_flag_defaults_to_still_without_window", () => {
    expect(reducedMotionRequested()).toBe(false);
  });
});
