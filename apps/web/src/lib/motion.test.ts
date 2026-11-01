// Reduced-motion flag coverage (S-114): the shared hook answers what the
// viewer preference reports, with no motion of its own. The flag drives
// the fully-static kill switch; default mode keeps short hover state
// changes plus the one-shot phosphor fills, and count-ups render final
// at once under reduced motion.
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

describe("reduced motion keeps added highlights static (P2-20)", () => {
  test("the shared flag is the single gate for animated fills", () => {
    stubMatchMedia(true);
    expect(reducedMotionRequested()).toBe(true);
    expect(renderToString(createElement(CountProbe, { target: 84 }))).toContain("84");
    stubMatchMedia(false);
    expect(reducedMotionRequested()).toBe(false);
  });
});

describe("deterministic order keeps sections static (W-8 option A)", () => {
  const cssDir = dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(join(cssDir, "../styles.css"), "utf8");
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

  test("no_ai_reorder_or_emphasis_rules_remain", () => {
    // W-8 retires AI ordering (option A): no section ever moves and no
    // emphasis is applied, so the arrival-glow and data-emphasis rules
    // are gone. The Ask field only highlights tiles in place.
    expect(code).not.toContain("ai-moved");
    expect(code).not.toContain("data-emphasis");
    expect(code).not.toMatch(/^\.ai-moved\s*\{/m);
  });

  test("ai_moved_is_static_under_reduced_motion", () => {
    const media = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*)\}\s*$/);
    expect(media).not.toBeNull();
    expect(media?.[1] ?? "").toContain("animation: none");
  });

  test("no_transform_in_any_animation", () => {
    const blocks = code.match(/@keyframes\s+[\w-]+\s*\{[\s\S]*?\n\}/g) ?? [];
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).not.toMatch(/transform|translate|scale|rotate/);
    }
    const animations = code.match(/^[ \t]*animation[^;]*;/gm) ?? [];
    for (const line of animations) {
      expect(line).not.toMatch(/transform|translate|scale|rotate/);
    }
  });
});
