// Explain panel (S-101, K-020): the opt-in sentence-level explanation
// overlay beside the deterministic result. Nothing fetches until the
// visitor asks. Sentences render as inert React text (never HTML), the
// drop count names how many model sentences failed the evidence check,
// and the invalid-output branch falls back to the deterministic
// explanation. Scores and evidence are untouched: the panel reads the
// overlay endpoint only.
import { useState, type JSX } from "react";
import { fetchExplain } from "../lib/api.ts";
import type { ExplainState } from "../lib/api.ts";

export function ExplainPanel({
  address,
  apiKey,
}: {
  readonly address: string;
  readonly apiKey: string;
}): JSX.Element {
  const [state, setState] = useState<ExplainState | null>(null);
  const [pending, setPending] = useState(false);

  async function onRequest(): Promise<void> {
    setPending(true);
    const next = await fetchExplain(address, apiKey);
    setPending(false);
    setState(next);
  }

  return (
    <section className="card" aria-label="Explain panel" style={{ marginBottom: 20 }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>Explain</h2>
      <p className="quiet" style={{ margin: "0 0 8px" }}>
        One opt-in model explanation over the frozen analysis. Advisory only: the score stands.
      </p>
      <button type="button" className="button-ghost" onClick={() => void onRequest()} disabled={pending}>
        {pending ? "Loading…" : "Request explanation"}
      </button>
      {state === null ? null : state.status === "not-configured" ? (
        <p data-testid="explain-not-configured" style={{ margin: "12px 0 0" }}>
          Explanations are not configured.
        </p>
      ) : state.status === "ready" ? (
        <div data-testid="explain-sentences" style={{ marginTop: 12 }}>
          {state.narrative.length === 0 ? (
            <p style={{ margin: 0 }}>Every model sentence failed the evidence check.</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {state.narrative.map((sentence, index) => (
                <li key={index}>{sentence}</li>
              ))}
            </ul>
          )}
          {state.droppedClaims > 0 ? (
            <p data-testid="explain-dropped" className="quiet" style={{ margin: "8px 0 0" }}>
              {state.droppedClaims} unsupported {state.droppedClaims === 1 ? "claim" : "claims"} dropped.
            </p>
          ) : null}
        </div>
      ) : state.status === "fallback" ? (
        <p data-testid="explain-fallback" style={{ margin: "12px 0 0" }}>
          The deterministic explanation stands.
        </p>
      ) : (
        <p role="alert" style={{ margin: "12px 0 0" }}>
          The explanation failed to load; the page result above stands.
        </p>
      )}
    </section>
  );
}
