// Pictogram renderer (UI v2 §2.1): decorative inline SVG on the 24 px
// grid, colour currentColor, never a markup sink. W-2 covers the full
// §2.2 set: every name renders, stays inside the grid, and has a label.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { Pictogram } from "./Pictogram.tsx";
import { PICTOGRAMS, type PictogramName } from "../lib/pictograms.ts";

// The full §2.2 set, in spec order (facts and status first, UI glyphs last).
const NAMES: readonly PictogramName[] = [
  "chain",
  "contract",
  "pair",
  "dex",
  "age",
  "liquidity",
  "proxy",
  "direct",
  "hash",
  "owner",
  "renounced",
  "pause",
  "blacklist",
  "mint",
  "fee",
  "limits",
  "sellblock",
  "hooks",
  "upgrade",
  "callout",
  "capability",
  "decompiler",
  "clone",
  "tangle",
  "block",
  "model",
  "found",
  "notfound",
  "extended",
  "canttell",
  "error",
  "notrun",
  "muse",
  "fn",
  "partial",
  "copy",
  "check",
  "cross",
  "chevron-right",
  "chevron-down",
  "back",
  "expert",
  "link",
  "volume",
  "market",
  "verified",
  "source",
  "note",
];

describe("pictogram", () => {
  test("every_glyph_renders_decorative_svg", () => {
    for (const name of NAMES) {
      const html = renderToString(<Pictogram name={name} size={18} />);
      expect(html).toContain("<svg");
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain('viewBox="0 0 24 24"');
      expect(html).toContain('stroke="currentColor"');
      expect(html, `${name} has a label`).toBeTruthy();
      expect(PICTOGRAMS[name].label.length).toBeGreaterThan(0);
    }
  });

  test("names_are_unique_and_complete", () => {
    expect(new Set(NAMES).size).toBe(NAMES.length);
    expect([...NAMES].sort()).toEqual(Object.keys(PICTOGRAMS).sort());
  });

  test("nodes_stay_inside_the_24px_grid", () => {
    for (const name of NAMES) {
      for (const node of PICTOGRAMS[name].nodes) {
        if (node[0] === "path") {
          // Coarse bound: every literal number in a path is a coordinate
          // or a small relative delta, so its magnitude stays on the grid.
          const numbers = node[1].d.match(/-?(?:\d+(?:\.\d+)?|\.\d+)/g) ?? [];
          expect(numbers.length, `${name} path is not empty`).toBeGreaterThan(0);
          for (const raw of numbers) {
            expect(Math.abs(Number(raw)), `${name} path number ${raw}`).toBeLessThanOrEqual(24);
          }
        } else if (node[0] === "circle") {
          const { cx, cy, r } = node[1];
          expect(cx - r, `${name} circle left`).toBeGreaterThanOrEqual(0);
          expect(cy - r, `${name} circle top`).toBeGreaterThanOrEqual(0);
          expect(cx + r, `${name} circle right`).toBeLessThanOrEqual(24);
          expect(cy + r, `${name} circle bottom`).toBeLessThanOrEqual(24);
        } else {
          const { x, y, width, height } = node[1];
          expect(x, `${name} rect left`).toBeGreaterThanOrEqual(0);
          expect(y, `${name} rect top`).toBeGreaterThanOrEqual(0);
          expect(x + width, `${name} rect right`).toBeLessThanOrEqual(24);
          expect(y + height, `${name} rect bottom`).toBeLessThanOrEqual(24);
        }
      }
    }
  });

  test("snapshot_of_three_glyphs", () => {
    const html = (["blacklist", "extended", "muse"] as const)
      .map((name) => renderToString(<Pictogram name={name} />))
      .join("\n");
    expect(html).toMatchSnapshot();
  });
});
