// Design-token coverage for the Phosphor Console direction: palette
// tokens with exact hex, the system monospace stack with no network
// fonts, glow-only motion (no transform or movement anywhere), the
// animation inventory timing bounds, the reduced-motion kill switch, and
// WCAG AA contrast for every text pair plus 3:1 UI boundaries.
// Reads the real stylesheet text so the token system cannot drift.
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

test("phosphor_palette_tokens_exact", () => {
  const root = rootBlock();
  for (const [token, hex] of [
    ["--void", "#010402"],
    ["--glass", "#03110a"],
    ["--glass-2", "#062016"],
    ["--phosphor", "#8dffb6"],
    ["--phosphor-hi", "#d6ffe6"],
    ["--dim", "#4fb27a"],
    ["--faint", "#1f5a3a"],
    ["--rule", "#154a2e"],
    ["--low", "#8dffb6"],
    ["--elevated", "#ffc14d"],
    ["--high", "#ff5a52"],
  ] as const) {
    expect(root).toContain(`${token}: ${hex}`);
  }
});

test("phosphor_system_mono_stack_without_network_fonts", () => {
  const root = rootBlock();
  expect(root).toContain('ui-monospace, "SF Mono", Menlo, Consolas, monospace');
  expect(code).not.toMatch(/@import/);
  expect(code).not.toMatch(/url\(\s*["']?https?:/);
  expect(code).not.toMatch(/font-face/);
});

test("phosphor_no_transform_or_movement_styles", () => {
  // No transform/perspective/translate/scale/rotate declarations: nothing
  // may translate, scale or rotate. text-transform for caps is fine; it is
  // not motion, so only declaration names count here.
  const declarations = code.match(/^[ \t]*(transform|perspective|translate|scale|rotate)\s*:/gim) ?? [];
  expect(declarations).toEqual([]);
  const transitions = code.match(/transition[^;]*;/g) ?? [];
  for (const block of transitions) {
    expect(block).not.toMatch(/transform|translate|scale|rotate/);
  }
});

test("phosphor_motion_inventory_tokens_defined", () => {
  const root = rootBlock();
  for (const [token, value] of [
    ["--blink-cursor", "1.2s"],
    ["--blink-analyzing", "1s"],
    ["--pulse-live", "1.6s"],
    ["--arrive", "2.4s"],
    ["--settle", "1.4s"],
    ["--breathe", "3s"],
    ["--glass-breathe", "3.2s"],
    ["--warn", "1.4s"],
    ["--hot", "2.2s"],
    ["--hot-badge", "2s"],
    ["--fade-sec", "0.8s"],
  ] as const) {
    expect(root).toContain(`${token}: ${value}`);
  }
});

test("phosphor_blinks_at_most_1hz_and_pulses_within_bounds", () => {
  const root = rootBlock();
  const secondsOf = (token: string): number => {
    const match = root.match(new RegExp(`${token}\\s*:\\s*([\\d.]+)s`));
    if (match === null || match[1] === undefined) {
      throw new Error(`token ${token} missing from :root`);
    }
    return Number.parseFloat(match[1]);
  };
  // Blinks run at most 1 Hz: the fastest cycle is exactly 1.0 s.
  expect(secondsOf("--blink-analyzing")).toBeGreaterThanOrEqual(1);
  expect(secondsOf("--blink-cursor")).toBeGreaterThanOrEqual(1);
  // Every pulse/breathing cycle lands in 1.4-3.2 s.
  for (const token of ["--pulse-live", "--breathe", "--glass-breathe", "--warn", "--hot", "--hot-badge"]) {
    const seconds = secondsOf(token);
    expect(seconds).toBeGreaterThanOrEqual(1.4);
    expect(seconds).toBeLessThanOrEqual(3.2);
  }
});

test("phosphor_keyframes_cover_only_opacity_colour_and_glow", () => {
  const allowed = new Set(["opacity", "color", "background-color", "border-color", "box-shadow", "text-shadow", "filter"]);
  const blocks = code.match(/@keyframes\s+[\w-]+\s*\{[\s\S]*?\n\}/g) ?? [];
  expect(blocks.length).toBeGreaterThan(0);
  const bad: string[] = [];
  for (const block of blocks) {
    const name = block.match(/@keyframes\s+([\w-]+)/)?.[1] ?? "?";
    for (const line of block.split("\n")) {
      const declaration = line.match(/^\s*([\w-]+)\s*:/);
      if (declaration !== null && declaration[1] !== undefined) {
        const property = declaration[1];
        if (!allowed.has(property)) {
          bad.push(`${name}: ${property}`);
        }
      }
    }
  }
  expect(bad).toEqual([]);
});

test("phosphor_transitions_cover_only_opacity_colour_and_shadow", () => {
  const allowed = new Set([
    "background-color",
    "border-color",
    "color",
    "box-shadow",
    "opacity",
    "stroke",
    "filter",
  ]);
  const blocks = code.match(/^[ \t]*transition(?!-)[^;]*;/gm) ?? [];
  expect(blocks.length).toBeGreaterThan(0);
  const bad: string[] = [];
  for (const block of blocks) {
    const list = block.replace(/^[ \t]*transition\s*:/, "");
    for (const part of list.split(",")) {
      const name = part.trim().split(/\s+/)[0] ?? "";
      if (name === "none") {
        continue;
      }
      if (name.startsWith("var(") || name.endsWith("ms") || name.endsWith("s") || name.startsWith("cubic-bezier")) {
        continue;
      }
      if (!allowed.has(name)) {
        bad.push(`${name} in ${block.trim()}`);
      }
    }
  }
  expect(bad).toEqual([]);
});

test("phosphor_transition_durations_capped_at_300ms", () => {
  // Interactive state transitions stay short: resolve the duration tokens
  // and cap every literal at 300 ms. One-shot fades run as animations,
  // never as transitions, so --fade-sec must not appear here.
  const root = rootBlock();
  const resolve = (block: string): string => {
    const tokenValue = (token: string): string => {
      const match = root.match(new RegExp(`${token}\\s*:\\s*([^;]+);`));
      if (match === null || match[1] === undefined) {
        throw new Error(`token ${token} missing from :root`);
      }
      return match[1].trim();
    };
    return block.replace(/var\((--[\w-]+)\)/g, (_, token: string) => tokenValue(token));
  };
  // Stagger delays are not durations; only transition shorthands count.
  const blocks = code.match(/^[ \t]*transition(?!-)[^;]*;/gm) ?? [];
  expect(blocks.length).toBeGreaterThan(0);
  for (const block of blocks) {
    expect(block, "one-shot fades run as animations, not transitions").not.toContain("--fade-sec");
  }
  const tooLong = blocks
    .map(resolve)
    .filter((block) =>
      (block.match(/(\d+(?:\.\d+)?)(m?s)/g) ?? []).some((part) => {
        const match = part.match(/(\d+(?:\.\d+)?)(m?s)/);
        if (match === null || match[1] === undefined || match[2] === undefined) {
          return false;
        }
        const ms = match[2] === "ms" ? Number.parseFloat(match[1]) : Number.parseFloat(match[1]) * 1000;
        return ms > 300;
      }),
    );
  expect(tooLong).toEqual([]);
});

test("phosphor_glow_tokens_cover_surfaces", () => {
  const root = rootBlock();
  for (const token of [
    "--elev-1",
    "--elev-2",
    "--elev-3",
    "--sheen",
    "--glow",
    "--glow-red",
    "--glow-red-lg",
    "--glow-red-strong",
    "--glow-red-faint",
    "--glow-seg",
    "--arrive-glow",
    "--shadow-off",
    "--shadow-none",
    "--alert-glow",
    "--tube-rings",
  ]) {
    expect(root, `missing token ${token}`).toContain(token);
  }
});

test("phosphor_no_raw_box_shadow_outside_tokens", () => {
  const withoutRoot = css.replace(/:root\s*\{[^}]*\}/, "");
  const lines = withoutRoot.split("\n");
  const raw = lines.filter((line) => line.includes("box-shadow:") && !line.includes("var(--"));
  expect(raw).toEqual([]);
});

test("phosphor_kill_switch_is_fully_static", () => {
  const media = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*)\}\s*$/);
  expect(media, "reduced-motion block missing").not.toBeNull();
  const body = media?.[1] ?? "";
  expect(body).toContain("transition: none");
  expect(body).toContain("animation: none");
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

test("s132_headline_caret_reads_the_verdict_band_token", () => {
  // The caret must take the verdict's risk colour from --verdict-band
  // (set from riskBand, the badge's source), never a hardcoded red.
  const marker = code.match(/\.headline-marker\s*\{[^}]*\}/)?.[0] ?? "";
  expect(marker.length).toBeGreaterThan(0);
  expect(marker).toContain("var(--verdict-band");
  expect(marker).not.toMatch(/#ff5a52/i);
});

test("s126_color_scheme_declared_dark", () => {
  expect(rootBlock()).toContain("color-scheme: dark");
});

test("phosphor_body_text_pairs_meet_aa", () => {
  // Every text/background pair used for text measures at least 4.5:1.
  // Faint and rule are decorative only and never appear here.
  const pairs: Array<[string, string]> = [
    ["--text", "--bg"],
    ["--text-2", "--bg"],
    ["--phosphor", "--glass"],
    ["--phosphor-hi", "--glass"],
    ["--dim", "--glass"],
    ["--dim", "--bg"],
    ["--amber", "--glass"],
    ["--high", "--glass"],
    ["--bg", "--high"],
    ["--bg", "--elevated"],
  ];
  for (const [foreground, background] of pairs) {
    expect(
      contrastOf(cssVar(foreground), cssVar(background)),
      `${foreground} on ${background}`,
    ).toBeGreaterThanOrEqual(4.5);
  }
});

test("phosphor_ui_boundaries_measure_three_to_one", () => {
  // Control edges, unlit segments and ticks all clear 3:1.
  for (const edge of ["--border-strong", "--edge", "--track"]) {
    for (const background of ["--bg", "--surface", "--surface-2"]) {
      expect(
        contrastOf(cssVar(edge), cssVar(background)),
        `${edge} on ${background}`,
      ).toBeGreaterThanOrEqual(3);
    }
  }
});

test("s126_strong_borders_for_controls", () => {
  expect(cssVar("--border-strong")).toBe("#4fb27a");
  const strongBorders = code.match(/(border|outline):[^;]*var\(--(border-strong|edge)\)/g) ?? [];
  expect(strongBorders.length).toBeGreaterThanOrEqual(3);
  expect(code).toContain("accent-color: var(--brand)");
});

test("s126_disabled_and_invalid_control_styles", () => {
  expect(code).toMatch(/\.button-ghost:disabled\s*\{[^}]*opacity:\s*0\.5[^}]*dashed/);
  expect(code).toMatch(/\.input\[aria-invalid="true"\]\s*\{[^}]*border-color:\s*var\(--high\)/);
});

test("r1_r3_r4_touch_targets_wrap_and_separator", () => {
  // R-1: the AI bar wraps so the applied notice stays inside the bar.
  const aiBar = code.match(/\.ai-bar\s*\{[^}]*\}/)?.[0] ?? "";
  expect(aiBar).toContain("flex-wrap: wrap");
  expect(code).toMatch(/\.ai-bar\s+\.ai-compact\s*\{[^}]*min-width:\s*0/);
  // R-3: tabs, copy buttons and ghost buttons carry a real 44 px desktop
  // floor; the "?" trigger keeps its compact look with an invisible hit
  // area that never moves layout.
  for (const selector of ["\\.tab", "\\.copy-btn", "\\.button-ghost"]) {
    const rule = code.match(new RegExp(`${selector}\\s*\\{[^}]*\\}`))?.[0] ?? "";
    expect(rule, `${selector} keeps the 44 px floor`).toMatch(/min-height:\s*44px/);
  }
  expect(code).toMatch(/\.explain-trigger::after\s*\{[^}]*inset:\s*-13px/);
  // R-4: the "·" separator renders at ~1.2 em, never a 14 px speck.
  const separator = code.match(/\.meta-item\s*\+\s*\.meta-item::before\s*\{[^}]*\}/)?.[0] ?? "";
  expect(separator).toContain('content: "·"');
  expect(separator).toMatch(/position:\s*absolute/);
  expect(separator).toMatch(/top:\s*50%/);
  expect(separator).not.toMatch(/transform/);
  const tokenSeparator = code.match(/\.token-meta\s*>\s*\.meta-item\s*\+\s*\.meta-item::before\s*\{[^}]*\}/)?.[0] ?? "";
  expect(tokenSeparator).toMatch(/font-size:\s*1\.2em/);
});
