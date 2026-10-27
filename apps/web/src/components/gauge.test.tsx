import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { Gauge } from "./Gauge.tsx";

// Design review P0-1: the arc dash math used a different radius than the
// SVG arc, so the gauge under-reported probability. pathLength=100 with a
// percent dash makes the fill exact by construction.
describe("gauge arc fill (design review P0-1)", () => {
  test("design_review_gauge_dash_matches_percent", () => {
    const html = renderToString(<Gauge kind="honeypot" probability={0.91} signalCount={1} reason="plain reason" />).replace(
      /<!-- -->/g,
      "",
    );
    expect(html).toContain('pathLength="100"');
    expect(html).toContain('stroke-dasharray="91 100"');
    expect(html).toContain("91%");
  });

  test("design_review_gauge_zero_and_full", () => {
    expect(renderToString(<Gauge kind="rug-pull" probability={0} signalCount={0} reason="x" />)).toContain(
      'stroke-dasharray="0 100"',
    );
    expect(renderToString(<Gauge kind="rug-pull" probability={1} signalCount={2} reason="x" />)).toContain(
      'stroke-dasharray="100 100"',
    );
  });
});
