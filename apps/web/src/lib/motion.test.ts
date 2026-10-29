// Reduced-motion flag coverage (S-114): the shared hook answers what the
// viewer preference reports, with no motion of its own. The flag drives
// the fully-static kill switch; default mode keeps short hover state
// changes plus the one-shot phosphor fills, and count-ups render final
// at once under reduced motion.
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { reducedMotionRequested, useCountUp, useReducedMotion } from "./motion.ts";

function CountProbe({ target }: { readonly target: number }): string {
  return String(useCountUp(target, 1700));
}

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

describe("count-up", () => {
  test("count_up_renders_final_value_under_reduced_motion", () => {
    stubMatchMedia(true);
    expect(renderToString(createElement(CountProbe, { target: 84 }))).toContain("84");
  });

  test("count_up_starts_at_zero_without_reduced_motion", () => {
    stubMatchMedia(false);
    // Server render shows the pre-fill state; the client eases to the
    // target once via requestAnimationFrame, never via Web Animations.
    expect(renderToString(createElement(CountProbe, { target: 84 }))).toContain("0");
  });
});
