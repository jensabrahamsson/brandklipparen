import { afterEach, describe, expect, test, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { Gauge } from "./Gauge.tsx";

// Phosphor Console gauges: a 20-segment bar that lights once to the
// probability share, the percent as text with its band word, the signal
// count and one plain-text reason. The accessible labels carry the exact
// percent, so the reading never depends on the lit count alone.
describe("gauge segments (phosphor console)", () => {
  test("gauge_renders_twenty_segments_with_exact_labels", () => {
    const html = renderToString(
      <Gauge kind="honeypot" probability={0.91} signalCount={1} reason="plain reason" />,
    ).replace(/<!-- -->/g, "");
    expect(html).toContain('aria-label="Honeypot: 91 percent"');
    expect(html).toContain('aria-label="91 percent probability"');
    expect(html).toContain("plain reason");
    expect(html).toContain("1 signal");
    expect(html).toContain("HIGH");
    const segments = html.match(/<i /g) ?? [];
    expect(segments).toHaveLength(20);
  });

  test("gauge_zero_and_full_light_counts", () => {
    vi.stubGlobal("window", {
      matchMedia: (query: string) => ({ matches: query.includes("reduce"), media: query }),
    });
    try {
      // Under reduced motion the fill renders final at once.
      const zero = renderToString(<Gauge kind="rug-pull" probability={0} signalCount={0} reason="x" />);
      expect(zero.match(/class="lit"/g) ?? []).toHaveLength(0);
      // A quiet gauge carries no count line and never says "no signals".
      expect(zero).not.toContain("no signals");
      expect(zero).not.toContain('class="cnt"');
      const full = renderToString(<Gauge kind="rug-pull" probability={1} signalCount={2} reason="x" />);
      expect(full.match(/class="lit"/g) ?? []).toHaveLength(20);
      expect(full).toContain("2 signals");
      expect(full).toContain("HIGH");
      const partial = renderToString(<Gauge kind="bot-pump" probability={0.22} signalCount={0} reason="x" />);
      expect(partial.match(/class="lit"/g) ?? []).toHaveLength(4);
      expect(partial).toContain("LOW");
      // An empty reason renders no reason line at all.
      const quiet = renderToString(<Gauge kind="honeypot" probability={0.1} signalCount={0} reason="" />);
      expect(quiet).not.toContain('class="why"');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("gauge_uncalibrated_shows_prior_badge", () => {
    const html = renderToString(
      <Gauge kind="bot-pump" probability={0.18} signalCount={0} reason="x" uncalibrated />,
    );
    expect(html).toContain("Prior · uncalibrated");
    const plain = renderToString(<Gauge kind="rug-pull" probability={0.18} signalCount={0} reason="x" />);
    expect(plain).not.toContain("Prior · uncalibrated");
  });

  test("score6_bot_pump_stays_on_one_line_with_muted_band", () => {
    // SCORE-6: the label reads "Bot pump" (space) and never wraps; the
    // uncalibrated tag sits on its own line under the title.
    const html = renderToString(
      <Gauge kind="bot-pump" probability={0.18} signalCount={0} reason="x" uncalibrated />,
    ).replace(/<!-- -->/g, "");
    expect(html).toContain("Bot pump");
    expect(html).not.toContain("Bot-pump");
    expect(html).toContain('aria-label="Bot pump: 18 percent"');
    expect(html.indexOf("Bot pump")).toBeLessThan(html.indexOf("Prior · uncalibrated"));
  });

  test("score6_muted_band_reads_neutral_next_to_a_floor", () => {
    const html = renderToString(
      <Gauge kind="honeypot" probability={0.08} signalCount={0} reason="x" mutedBand />,
    );
    expect(html).toContain("floor-muted");
    expect(html).toContain("LOW");
    const plain = renderToString(<Gauge kind="honeypot" probability={0.08} signalCount={0} reason="x" />);
    expect(plain).not.toContain("floor-muted");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});
