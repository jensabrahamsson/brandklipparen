// Loading and error states (R3 D-16, U-13). Behavior only: rendered
// text, roles and order. Timers never run under renderToString, so the
// initial second and the full countdown are asserted as text.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { ApiError } from "../lib/api.ts";
import { errorCopy } from "../pages/TokenPage.tsx";
import {
  ERROR_RETRY_DELAY_S,
  LoadingNotice,
  LoadingStatusLine,
  TokenErrorCard,
} from "./LoadingState.tsx";

function renderError(status: number, message: string): string {
  const noop = (): void => {};
  return renderToString(
    <TokenErrorCard error={errorCopy(new ApiError("test", status, message))} onRetry={noop} />,
  );
}

// Server rendering splits text at expression boundaries with comments;
// strip them so assertions read the announced text, not the markup.
function text(html: string): string {
  return html.replace(/<!-- -->/g, "");
}

describe("loading status line (U-13)", () => {
  test("u13_status_line_names_the_chain_and_counts_seconds", () => {
    const html = text(renderToString(<LoadingStatusLine />));
    expect(html).toContain("Reading the contract… 0 s");
    expect(html).toContain('data-testid="loading-status"');
    expect(html).toContain('role="status"');
  });

  test("u13_status_line_says_analyzing_nothing_twice", () => {
    const html = renderToString(<LoadingStatusLine />);
    expect(html).not.toContain("Analyzing");
    expect(html).not.toContain("bytecode");
  });
});

describe("loading frame (U-13)", () => {
  test("u13_loading_uses_the_result_hero_frame_with_an_unlit_dial", () => {
    const html = text(renderToString(<LoadingNotice />));
    expect(html).toContain('aria-label="Combined score"');
    expect(html).toContain("loading-frame");
    expect(html).toContain("score-ring-wrap");
    expect(html).toContain("loading-dial");
    expect(html).toContain('aria-busy="true"');
    // The status line rides as the frame's first row, so the frame top
    // matches the result hero top and only the bottom edge can move.
    expect(html).toContain('data-testid="loading-status"');
    expect(html).toContain("Reading the contract… 0 s");
    // Below-fold placeholders keep the footer offscreen in both states.
    expect(html).toContain("loading-console");
    expect(html).toContain("loading-board");
  });

  test("u13_loading_names_no_result_and_no_jargon", () => {
    const html = renderToString(<LoadingNotice />);
    expect(html).not.toContain("Analyzing");
    expect(html).not.toContain("deterministic result appears here");
  });
});

describe("token error card (U-13)", () => {
  test("u13_rate_limit_shows_cause_countdown_and_retry_now", () => {
    const html = text(renderError(429, "Too many requests (429): slow down."));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Busy.");
    expect(html).toContain(`Retrying automatically in ${ERROR_RETRY_DELAY_S} s.`);
    expect(html).toContain("Retry now");
    expect(html).not.toContain("429");
    expect(html).not.toContain("slow down");
  });

  test("u13_server_error_retries_without_codes_or_raw_text", () => {
    const html = renderError(503, "Upstream unavailable: boom.");
    expect(html).toContain("Service down.");
    expect(html).toContain("Retry now");
    expect(html).not.toMatch(/\d{3}/);
    expect(html).not.toContain("Upstream unavailable");
  });

  test("u13_key_error_offers_retry_now_with_no_countdown", () => {
    const html = renderError(401, "Unauthorized");
    expect(html).toContain("API key needed.");
    expect(html).toContain("Retry now");
    expect(html).not.toContain("Retrying automatically");
    expect(html).not.toContain("401");
  });

  test("u13_retry_button_is_a_real_button", () => {
    const html = renderError(429, "Too many");
    expect(html).toContain("<button");
    expect(html).toContain("Retry now");
  });

});
