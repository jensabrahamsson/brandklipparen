// Design-token coverage (S-121 elevation, S-122 motion, S-126 controls).
// Reads the real stylesheet text so the token system cannot drift from
// the rules: one token system in styles.css, no raw box-shadow outside
// the token definitions, no transform/perspective anywhere, and motion
// durations that collapse to 0 ms under reduced motion.
import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cssDir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(cssDir, "styles.css"), "utf8");
// Comments name properties without declaring them; strip them before
// scanning declarations.
const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

function rootBlock(): string {
  const match = css.match(/:root\s*\{([^}]*)\}/);
  if (match === null || match[1] === undefined) {
    throw new Error(":root block missing from styles.css");
  }
  return match[1];
}

test("s121_elevation_tokens_cover_surfaces", () => {
  const root = rootBlock();
  for (const token of ["--elev-1", "--elev-2", "--elev-3", "--sheen"]) {
    expect(root, `missing token ${token}`).toContain(token);
  }
  expect(root).toContain("0 1px 2px rgb(0 0 0 / 35%), 0 4px 12px rgb(0 0 0 / 22%)");
  expect(root).toContain("0 2px 4px rgb(0 0 0 / 35%), 0 12px 32px rgb(0 0 0 / 32%)");
  expect(root).toContain("0 8px 16px rgb(0 0 0 / 40%), 0 24px 48px rgb(0 0 0 / 45%)");
});

test("s121_no_raw_box_shadow_outside_tokens", () => {
  const withoutRoot = css.replace(/:root\s*\{[^}]*\}/, "");
  const lines = withoutRoot.split("\n");
  const raw = lines.filter(
    (line) => line.includes("box-shadow:") && !line.includes("var(--"),
  );
  expect(raw).toEqual([]);
});

test("s121_no_transform_or_perspective_styles", () => {
  const declarations = css.match(/^[ \t]*(transform|perspective)\s*:/gm) ?? [];
  expect(declarations).toEqual([]);
});

test("s122_motion_tokens_defined", () => {
  const root = rootBlock();
  expect(root).toContain("--dur-fast: 120ms");
  expect(root).toContain("--dur-base: 180ms");
  expect(root).toContain("--dur-slow: 280ms");
  expect(root).toContain("--ease-out: cubic-bezier(0.2, 0, 0, 1)");
  expect(root).toContain("--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1)");
});

test("s122_transition_durations_capped_at_300ms", () => {
  const blocks = code.match(/transition[^;]*;/g) ?? [];
  expect(blocks.length).toBeGreaterThan(0);
  const tooLong = blocks.filter((block) =>
    (block.match(/(\d+(?:\.\d+)?)ms/g) ?? []).some((part) => Number.parseFloat(part) > 300),
  );
  expect(tooLong).toEqual([]);
});

test("s122_transitions_cover_only_opacity_colour_and_shadow", () => {
  const allowed = new Set([
    "background-color",
    "border-color",
    "color",
    "box-shadow",
    "opacity",
    "stroke-dasharray",
  ]);
  const blocks = code.match(/transition[^;]*;/g) ?? [];
  const bad: string[] = [];
  for (const block of blocks) {
    const list = block.replace(/^transition\s*:/, "");
    for (const part of list.split(",")) {
      const name = part.trim().split(/\s+/)[0] ?? "";
      if (name === "none") {
        continue;
      }
      if (name.startsWith("var(") || name.endsWith("ms") || name.startsWith("cubic-bezier")) {
        continue;
      }
      if (!allowed.has(name)) {
        bad.push(`${name} in ${block.trim()}`);
      }
    }
  }
  expect(bad).toEqual([]);
});

test("s122_score_ring_draws_once_on_mount", () => {
  expect(css).toContain("stroke-dasharray var(--dur-slow)");
  expect(css).toContain("@keyframes fade-in");
  expect(css).toMatch(/\.explain-tooltip\s*\{[^}]*animation:\s*fade-in var\(--dur-base\)/);
});

test("s122_tokens_become_zero_under_reduced_motion", () => {
  const media = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*)\}\s*$/);
  expect(media, "reduced-motion block missing").not.toBeNull();
  const body = media?.[1] ?? "";
  expect(body).toContain("--dur-fast: 0ms");
  expect(body).toContain("--dur-base: 0ms");
  expect(body).toContain("--dur-slow: 0ms");
});

function cssVar(name: string): string {
  const root = rootBlock();
  const match = root.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  if (match === null || match[1] === undefined) {
    throw new Error(`token ${name} missing from :root`);
  }
  return match[1].trim();
}

function luminanceOf(hex: string): number {
  const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  const linear = channels.map((value) =>
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function contrastOf(first: string, second: string): number {
  const a = luminanceOf(first);
  const b = luminanceOf(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("s126_color_scheme_declared_dark", () => {
  expect(rootBlock()).toContain("color-scheme: dark");
});

test("s126_strong_borders_for_controls", () => {
  expect(cssVar("--border-strong")).toBe("#5a7186");
  const strongBorders = code.match(/border:\s*1px solid var\(--border-strong\)/g) ?? [];
  expect(strongBorders.length).toBeGreaterThanOrEqual(3);
  expect(code).toContain("accent-color: var(--brand)");
});

test("s126_border_strong_measures_three_to_one", () => {
  const edge = cssVar("--border-strong");
  for (const background of ["--bg", "--surface", "--surface-2"]) {
    expect(contrastOf(edge, cssVar(background))).toBeGreaterThanOrEqual(3);
  }
});

test("s126_disabled_and_invalid_control_styles", () => {
  expect(code).toMatch(/\.button-ghost:disabled\s*\{[^}]*opacity:\s*0\.5[^}]*dashed/);
  expect(code).toMatch(/\.input\[aria-invalid="true"\]\s*\{[^}]*border-color:\s*var\(--high\)/);
});
