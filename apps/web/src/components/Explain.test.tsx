// Accessible explanation trigger (S-113, K-021, K-103, K-507).
// Written first per A-21 (red): ./Explain.tsx does not exist yet. The
// trigger is a focusable button, the text lives in a role="tooltip" node
// linked by aria-describedby, and server rendering pins both states: a
// closed trigger carries no text (numbers stay readable) and an opened
// one carries the full explanation as inert text.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { Explain, tooltipPlacement } from "./Explain.tsx";

describe("explain trigger (S-113)", () => {
  test("closed_trigger_shows_no_text_but_stays_labelled", () => {
    const html = renderToString(<Explain explainKey="score:combined" label="Combined score" />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Explain Combined score");
    expect(html).not.toContain('role="tooltip"');
  });

  test("open_trigger_links_the_tooltip_text", () => {
    const html = renderToString(<Explain explainKey="score:combined" label="Combined score" defaultOpen />);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('role="tooltip"');
    expect(html).toContain("aria-describedby");
    expect(html.length).toBeGreaterThan(200);
  });

  test("tooltip_placement_clamps_to_16px_gutters_on_wide_screens", () => {
    const placed = tooltipPlacement({ top: 100, bottom: 144, left: 700 }, { width: 390 + 400, height: 844 }, { width: 280, height: 120 });
    expect(placed.sheet).toBe(false);
    expect(placed.style.left).toBe(790 - 280 - 16);
    const nearLeft = tooltipPlacement({ top: 100, bottom: 144, left: 4 }, { width: 1024, height: 800 }, { width: 280, height: 120 });
    expect(nearLeft.style.left).toBe(16);
  });

  test("tooltip_placement_flips_above_when_below_would_cross_the_bottom", () => {
    const placed = tooltipPlacement({ top: 700, bottom: 744, left: 100 }, { width: 1024, height: 800 }, { width: 200, height: 120 });
    expect(placed.style.top).toBe(700 - 120 - 6);
  });

  test("tooltip_placement_is_a_bottom_sheet_at_phone_widths", () => {
    for (const width of [390, 320]) {
      const placed = tooltipPlacement({ top: 300, bottom: 344, left: 300 }, { width, height: 700 }, { width: 280, height: 140 });
      expect(placed.sheet).toBe(true);
      expect(placed.style.left).toBe(16);
      expect(placed.style.right).toBe(16);
    }
  });

  test("trigger_is_a_44px_box_with_a_20px_visual", () => {
    // UI v2 §6.1 (D3): the button box is always 44x44 and transparent,
    // and the 20 px inner span draws the circle, so the touch rule never
    // enlarges the visual.
    const html = renderToString(<Explain explainKey="score:combined" label="Combined score" />);
    expect(html).toContain('class="explain-trigger"');
    expect(html).toContain('<span class="q" aria-hidden="true">');
  });
});
