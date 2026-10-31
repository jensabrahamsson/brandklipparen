// Pictogram renderer (UI v2 §2.1): decorative inline SVG on the 24 px
// grid, colour currentColor, never a markup sink. W-1 pins the four
// glyphs this unit needs; W-2 covers the full set.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { Pictogram } from "./Pictogram.tsx";
import { PICTOGRAMS, type PictogramName } from "../lib/pictograms.ts";

const NAMES: readonly PictogramName[] = ["copy", "check", "cross", "chain"];

describe("pictogram", () => {
  test("every_w1_glyph_renders_decorative_svg", () => {
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

  test("names_are_unique", () => {
    expect(new Set(NAMES).size).toBe(NAMES.length);
  });
});
