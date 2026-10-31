// Accessible explanation trigger (S-113, K-021, K-103, K-507).
// Written first per A-21 (red): ./Explain.tsx does not exist yet. The
// trigger is a focusable button, the text lives in a role="tooltip" node
// linked by aria-describedby, and server rendering pins both states: a
// closed trigger carries no text (numbers stay readable) and an opened
// one carries the full explanation as inert text.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { Explain } from "./Explain.tsx";

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

  test("trigger_is_a_44px_box_with_a_20px_visual", () => {
    // UI v2 §6.1 (D3): the button box is always 44x44 and transparent,
    // and the 20 px inner span draws the circle, so the touch rule never
    // enlarges the visual.
    const html = renderToString(<Explain explainKey="score:combined" label="Combined score" />);
    expect(html).toContain('class="explain-trigger"');
    expect(html).toContain('<span class="q" aria-hidden="true">');
  });
});
