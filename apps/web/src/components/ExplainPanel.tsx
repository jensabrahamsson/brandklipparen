// Explain block for the Muse console (S-101, K-020, UI v2 §1.2). The
// opt-in sentence-level explanation overlay beside the deterministic
// result, now without its own card: the console owns the frame, the
// buttons and the advisory footer. Nothing fetches until the console
// mounts this block. Sentences render as inert React text (never HTML),
// the drop count names how many model sentences failed the evidence
// check, and the invalid-output branch falls back to the deterministic
// explanation. Scores and evidence are untouched: the block reads the
// overlay endpoint only.
import { useEffect, useState, type JSX } from "react";
import { ScanStatus } from "./ScanStatus.tsx";
import { fetchExplain, fetchRug } from "../lib/api.ts";
import type { ExplainSource, ExplainState, RugState } from "../lib/api.ts";
import type { ExplanationClaim, Signal } from "../types.ts";
import { evidenceSignalKey, splitNarrative } from "../lib/investigation.ts";

export type ConsoleSentences = {
  readonly narrative: readonly string[];
  readonly droppedClaims: number;
};

// Sentences with evidence chips. Citation markers (`[E:signal:<id>]`)
// inside model sentences become chips that move focus to the linked
// signal; unknown ids render as plain text. Plain sentences without
// markers render as-is.
export function ExplainSentences({
  narrative,
  droppedClaims,
  signals,
  onSignalLink,
}: ConsoleSentences & {
  readonly signals: readonly Signal[];
  readonly onSignalLink: (key: string) => void;
}): JSX.Element {
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
                  <ExplainChip key={partIndex} id={part.id} signals={signals} onSignalLink={onSignalLink} />
                ),
              )}
            </li>
          ))}
        </ul>
      )}
      {droppedClaims > 0 ? (
        <p data-testid="explain-dropped" className="quiet" style={{ margin: "8px 0 0" }}>
          {droppedClaims} unsupported {droppedClaims === 1 ? "claim" : "claims"} dropped.
        </p>
      ) : null}
    </div>
  );
}

function ExplainChip({
  id,
  signals,
  onSignalLink,
}: {
  readonly id: string;
  readonly signals: readonly Signal[];
  readonly onSignalLink: (key: string) => void;
}): JSX.Element {
  const key = evidenceSignalKey(signals, id);
  const label = id.startsWith("signal:") ? id.slice("signal:".length) : id;
  if (key === null) {
    return (
      <span className="tool-chip" style={{ margin: "2px 4px 2px 0" }}>
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="chip mono"
      data-evidence={id}
      style={{ margin: "2px 4px 2px 0" }}
      onClick={() => onSignalLink(key)}
    >
      {label}
    </button>
  );
}

// User-facing fallback when every model sentence failed the evidence
// check: the deterministic template claims stand in for the dropped
// overlay, never the developer message. Inert React text only, with a
// quiet retry that re-runs the same overlay request.
export function ExplainFallback({
  claims,
  onRetry,
}: {
  readonly claims: readonly ExplanationClaim[];
  readonly onRetry: () => void;
}): JSX.Element {
  return (
    <div data-testid="explain-fallback">
      <p style={{ margin: 0 }}>We could not explain this with Muse. Here is what the analysis found:</p>
      {claims.length > 0 ? (
        <ul className="muse-sentences" style={{ margin: "8px 0 0", paddingLeft: 20 }}>
          {claims.map((claim, index) => (
            <li key={index}>{claim.text}</li>
          ))}
        </ul>
      ) : null}
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
  apiKey,
  source,
  signals,
  claims,
  onSignalLink,
  onRetry,
}: {
  readonly address: string;
  readonly apiKey: string;
  readonly source: Extract<ExplainSource, "explain" | "rug">;
  readonly signals: readonly Signal[];
  readonly claims: readonly ExplanationClaim[];
  readonly onSignalLink: (key: string) => void;
  readonly onRetry: () => void;
}): JSX.Element {
  const [state, setState] = useState<ExplainState | RugState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = source === "rug" ? fetchRug(address, apiKey) : fetchExplain(address, apiKey);
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
  }, [address, apiKey, source]);

  if (state === null) {
    return <ScanStatus text="Reading the frozen result…" />;
  }
  if (state.status === "not-configured") {
    return <p style={{ margin: 0 }}>Explanations are not configured on this server.</p>;
  }
  if (state.status === "ready") {
    return (
      <div>
        <p className="muse-result-label" style={{ margin: "0 0 8px" }}>
          Explain · {state.modelId}
        </p>
        {state.narrative.length === 0 ? (
          <div>
            <ExplainFallback claims={claims} onRetry={onRetry} />
            {state.droppedClaims > 0 ? (
              <p data-testid="explain-dropped" className="quiet" style={{ margin: "8px 0 0" }}>
                {state.droppedClaims} unsupported {state.droppedClaims === 1 ? "claim" : "claims"} dropped.
              </p>
            ) : null}
          </div>
        ) : (
          <ExplainSentences
            narrative={state.narrative}
            droppedClaims={state.droppedClaims}
            signals={signals}
            onSignalLink={onSignalLink}
          />
        )}
      </div>
    );
  }
  if (state.status === "fallback") {
    return <p style={{ margin: 0 }}>The deterministic explanation stands.</p>;
  }
  return (
    <div>
      <p role="alert" style={{ margin: "0 0 8px" }}>
        The explanation failed to load; the page result above stands.
      </p>
      <button type="button" className="button-ghost" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
