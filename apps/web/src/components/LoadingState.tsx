// Loading and error states for the token page (R3 D-16, U-13).
// Loading renders the hero frame at its final min-height with an unlit
// dial, so the swap to the result barely shifts layout. The single
// status line counts elapsed seconds in text only (no motion); the
// ticking number is aria-hidden so screen readers hear one polite
// announcement, plus a second one when the slow-scan note appears.
// The error card is a flat red 1 px card with no glow, plain-language
// copy (never a status code or a raw message), an auto-retry countdown
// and Retry now. Behavior only: rendered text, roles and targets.
import { useEffect, useState, type JSX } from "react";

// Seconds between an auto-retry and the countdown start. Short enough
// to feel responsive, long enough to let a 429 cool down.
export const ERROR_RETRY_DELAY_S = 10;

// Seconds of waiting before the honest slow-scan note appears.
export const SLOW_SCAN_AFTER_S = 8;

export interface TokenLoadError {
  readonly title: string;
  readonly detail: string;
  // False when retrying cannot help (for example a missing API key):
  // the card then offers Retry now without a countdown.
  readonly retryable: boolean;
}

function useElapsedSeconds(): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setSeconds((value) => value + 1);
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  return seconds;
}

// One truthful status line with a per-second elapsed counter, text
// only and no motion. Renders during the fetch; unmounts on result.
export function LoadingStatusLine(): JSX.Element {
  const seconds = useElapsedSeconds();
  const slow = seconds >= SLOW_SCAN_AFTER_S;
  return (
    <p className="muted numeric loading-status" data-testid="loading-status" style={{ margin: "0 0 12px" }}>
      <span aria-hidden="true">
        Reading the contract… {seconds} s
        {slow ? " Still reading. First scan takes ~15 s." : null}
      </span>
      <span className="sr-only" role="status">
        {slow
          ? "Still reading. First scan takes ~15 s."
          : "Reading the contract…"}
      </span>
    </p>
  );
}

// Hero-frame skeleton: the same card and grid as the result hero, with
// the status line as its first row and an unlit dashed dial, so loading
// and result share one layout shape: matching tops, and block heights
// close to the verdict, chips and gauges. The skeleton blocks are honest
// placeholders, never fake content.
export function LoadingNotice(): JSX.Element {
  return (
    <>
    <section className="card verdict loading-frame" aria-label="Combined score" aria-busy="true">
      <LoadingStatusLine />
      <div aria-hidden="true">
        <span className="skel skel-title" />
        <span className="skel skel-addr" />
        <span className="skel skel-meta" />
      </div>
      <div className="score-ring-wrap">
        <div className="hero-copy" aria-hidden="true">
          <span className="skel skel-meaning-a" />
          <span className="skel skel-meaning-b" />
          <span className="skel skel-chips" />
          <span className="skel skel-gauges" />
        </div>
        <div className="score-dial loading-dial" aria-hidden="true">
          <span className="loading-dial-mark">…</span>
        </div>
      </div>
    </section>
    {/* Below-fold placeholders for the console and board, so the footer
        starts below the fold exactly as on the result page: the only
        visible swap is the hero frame itself. */}
    <div className="card loading-below loading-console" aria-hidden="true">
      <span className="skel" />
      <span className="skel" />
    </div>
    <div className="card loading-below loading-board" aria-hidden="true">
      <span className="skel" />
      <span className="skel" />
      <span className="skel" />
    </div>
    </>
  );
}

// Flat red error card with an auto-retry countdown and Retry now.
// The countdown ticks in aria-hidden text; the alert announces once.
export function TokenErrorCard({
  error,
  onRetry,
}: {
  readonly error: TokenLoadError;
  readonly onRetry: () => void;
}): JSX.Element {
  const [countdown, setCountdown] = useState(ERROR_RETRY_DELAY_S);
  useEffect(() => {
    if (!error.retryable) {
      return;
    }
    setCountdown(ERROR_RETRY_DELAY_S);
    const timer = window.setInterval(() => {
      setCountdown((value) => value - 1);
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [error.retryable]);
  useEffect(() => {
    if (error.retryable && countdown <= 0) {
      onRetry();
    }
  }, [countdown, error.retryable, onRetry]);
  return (
    <div className="card error-card" role="alert" data-testid="token-error">
      <p className="error-title">{error.title}</p>
      <p className="muted" style={{ marginBottom: 8 }}>
        {error.detail}
      </p>
      {error.retryable ? (
        <p className="muted numeric" style={{ margin: "0 0 12px" }} aria-hidden="true">
          Retrying automatically in {Math.max(0, countdown)} s.
        </p>
      ) : null}
      <button type="button" className="button" onClick={onRetry}>
        Retry now
      </button>
    </div>
  );
}
