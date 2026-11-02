// Explain block for the Muse console (S-101, K-020, UI v2 §1.2). The
// opt-in sentence-level explanation overlay beside the deterministic
// result, now without its own card: the console owns the frame, the
// buttons and the advisory footer. Nothing fetches until the console
// mounts this block. Sentences render as inert React text (never HTML),
// the drop count names how many model sentences lacked evidence, and the
// invalid-output branch falls back to the verdict. Scores and evidence
// are untouched: the block reads the overlay endpoint only.
import { useEffect, useState, type JSX } from "react";
import { ScanStatus } from "./ScanStatus.tsx";
import { Pictogram } from "./Pictogram.tsx";
import { fetchExplain, fetchRug } from "../lib/api.ts";
import type { ExplainSource, ExplainState, RugState } from "../lib/api.ts";
import type { ExplanationClaim, Signal } from "../types.ts";
import { splitNarrative } from "../lib/investigation.ts";
import { citationTarget } from "../lib/citationTarget.ts";
import { modelDisplayLabel } from "../lib/providers.ts";

export type ConsoleSentences = {
  readonly narrative: readonly string[];
  readonly droppedClaims: number;
};

// One evidence chip per citation marker (`[E:<id>]`) inside a model
// sentence. Every coverage id shape becomes a lamp chip with a short
// plain label: signal chips jump to the "Why this score" row, check and
// analysis chips link to the plugin detail or board, and can't-tell
// chips scroll to the can't-tell panel. Unknown ids render nothing at
// all, never a raw id.
export function CoverageChip({
  id,
  signals,
  address,
  allIds,
  onSignalLink,
}: {
  readonly id: string;
  readonly signals: readonly Signal[];
  readonly address: string;
  readonly allIds: readonly string[];
  readonly onSignalLink: (key: string) => void;
}): JSX.Element | null {
  const target = citationTarget(id, { signals, address, allIds });
  if (target === null) {
    return null;
  }
  const lamp = (
    <span className="muse-chip-lamp" aria-hidden="true">
      <Pictogram name={target.lamp} size={20} />
    </span>
  );
  if (target.kind === "signal") {
    return (
      <button
        type="button"
        className="muse-chip"
        data-evidence={id}
        aria-label={`Evidence: ${target.label}. Open the Why this score row.`}
        onClick={() => onSignalLink(target.signalKey)}
      >
        {lamp}
        <span>{target.label}</span>
      </button>
    );
  }
  if (target.kind === "cant-tell") {
    return (
      <button
        type="button"
        className="muse-chip muse-chip-cant-tell"
        data-evidence={id}
        aria-label={`Evidence: ${target.label}. Open what the code can't tell you.`}
        onClick={jumpToCantTell}
      >
        {lamp}
        <span>{target.label}</span>
      </button>
    );
  }
  const detailHint =
    target.label === "What we checked" ? "Open what we checked." : "Open the check detail.";
  return (
    <a
      className="muse-chip"
      data-evidence={id}
      href={target.href}
      aria-label={`Evidence: ${target.label}. ${detailHint}`}
    >
      {lamp}
      <span>{target.label}</span>
    </a>
  );
}

// The can't-tell panel lives on the token main view. Hash routing owns
// every `#…` link, so this scrolls and focuses directly instead of
// touching the hash, which would route away from the token page.
function jumpToCantTell(): void {
  const target = document.getElementById("cant-tell");
  if (target === null) {
    return;
  }
  if (target instanceof HTMLDetailsElement) {
    target.open = true;
  }
  target.scrollIntoView({ block: "start" });
  if (target instanceof HTMLElement) {
    target.focus({ preventScroll: true });
  }
}

// Wording for removed sentences, shown only inside a Details
// disclosure: the count plus the reason, never a developer term.
export function droppedLine(droppedClaims: number): string | null {
  if (droppedClaims <= 0) {
    return null;
  }
  return droppedClaims === 1
    ? "1 sentence removed: it cited no evidence."
    : `${droppedClaims} sentences removed: they cited no evidence.`;
}

// Sentences with evidence chips. Citation markers become CoverageChips;
// plain sentences render as-is.
export function ExplainSentences({
  narrative,
  droppedClaims,
  signals,
  address,
  allIds,
  onSignalLink,
}: ConsoleSentences & {
  readonly signals: readonly Signal[];
  readonly address: string;
  readonly allIds: readonly string[];
  readonly onSignalLink: (key: string) => void;
}): JSX.Element {
  const dropped = droppedLine(droppedClaims);
  return (
    <div data-testid="explain-sentences">
      {narrative.length === 0 ? null : (
        <ul className="muse-sentences" style={{ margin: 0, paddingLeft: 20 }}>
          {narrative.map((sentence, index) => (
            <li key={index}>
              {splitNarrative(sentence).map((part, partIndex) =>
                part.kind === "text" ? (
                  <span key={partIndex}>{part.text}</span>
                ) : (
                  <CoverageChip
                    key={partIndex}
                    id={part.id}
                    signals={signals}
                    address={address}
                    allIds={allIds}
                    onSignalLink={onSignalLink}
                  />
                ),
              )}
            </li>
          ))}
        </ul>
      )}
      {dropped === null ? null : (
        <details className="muse-details">
          <summary>Details</summary>
          <p data-testid="explain-dropped" className="quiet" style={{ margin: "8px 0 0" }}>
            {dropped}
          </p>
        </details>
      )}
    </div>
  );
}

const NOTHING_FOUND_LINE =
  "No owner power found in the code we could read. That is not the same as safe.";

// User-facing fallback when no model sentence survived: with claims,
// the deterministic template claims stand in; without claims, the
// verdict sentence stands. Inert React text only, with a quiet retry
// that re-runs the same overlay request.
export function ExplainFallback({
  verdict,
  claims,
  onRetry,
}: {
  readonly verdict: string;
  readonly claims: readonly ExplanationClaim[];
  readonly onRetry: () => void;
}): JSX.Element {
  return (
    <div data-testid="explain-fallback">
      {claims.length > 0 ? (
        <>
          <p style={{ margin: 0 }}>Muse&apos;s answer cited no evidence. Here&apos;s the analysis instead:</p>
          <ul className="muse-sentences" style={{ margin: "8px 0 0", paddingLeft: 20 }}>
            {claims.map((claim, index) => (
              <li key={index}>{claim.text}</li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <p style={{ margin: 0 }}>{verdict}</p>
          {verdict.includes("No owner power found") ? null : (
            <p style={{ margin: "8px 0 0" }}>{NOTHING_FOUND_LINE}</p>
          )}
        </>
      )}
      <div style={{ marginTop: 8 }}>
        <button type="button" className="button-ghost" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}

export function ExplainPanel({
  address,
  block,
  apiKey,
  source,
  signals,
  claims,
  allIds,
  verdict,
  checkCount,
  onSignalLink,
  onRetry,
}: {
  readonly address: string;
  readonly block?: number | undefined;
  readonly apiKey: string;
  readonly source: Extract<ExplainSource, "explain" | "rug">;
  readonly signals: readonly Signal[];
  readonly claims: readonly ExplanationClaim[];
  readonly allIds: readonly string[];
  readonly verdict: string;
  readonly checkCount: number;
  readonly onSignalLink: (key: string) => void;
  readonly onRetry: () => void;
}): JSX.Element {
  const [state, setState] = useState<ExplainState | RugState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = source === "rug" ? fetchRug(address, apiKey, block) : fetchExplain(address, apiKey, block);
    run.then(
      (next) => {
        if (!cancelled) {
          setState(next);
        }
      },
      () => {
        if (!cancelled) {
          setState({ status: "failed" });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [address, apiKey, source, block]);

  if (state === null) {
    return (
      <ScanStatus
        text={checkCount > 0 ? `Muse is reading ${checkCount} check results…` : "Muse is reading the check results…"}
      />
    );
  }
  if (state.status === "not-configured") {
    return <p style={{ margin: 0 }}>Muse is not available for this result.</p>;
  }
  if (state.status === "ready") {
    const dropped = droppedLine(state.droppedClaims);
    return (
      <div>
        <p className="muse-result-label" style={{ margin: "0 0 8px" }}>
          Explain · <span title={state.modelId}>{modelDisplayLabel(state.modelId)}</span>
        </p>
        {state.narrative.length === 0 ? (
          <div>
            <ExplainFallback verdict={verdict} claims={claims} onRetry={onRetry} />
            {dropped === null ? null : (
              <details className="muse-details">
                <summary>Details</summary>
                <p data-testid="explain-dropped" className="quiet" style={{ margin: "8px 0 0" }}>
                  {dropped}
                </p>
              </details>
            )}
          </div>
        ) : (
          <ExplainSentences
            narrative={state.narrative}
            droppedClaims={state.droppedClaims}
            signals={signals}
            address={address}
            allIds={allIds}
            onSignalLink={onSignalLink}
          />
        )}
      </div>
    );
  }
  if (state.status === "fallback") {
    return <p style={{ margin: 0 }}>Muse had nothing to add.</p>;
  }
  return (
    <div>
      <p role="alert" style={{ margin: "0 0 8px" }}>
        The explanation failed to load.
      </p>
      <button type="button" className="button-ghost" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
