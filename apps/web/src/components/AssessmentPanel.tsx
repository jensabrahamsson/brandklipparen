import type { JSX } from "react";
import type { AssessmentState } from "../types.ts";

// Contract assessment with Muse, in its own tab (K-305): free-text
// assessment through the selected assessment provider, on explicit request
// only. The panel never receives score, probability or evidence setters,
// so assessment text cannot move the deterministic result (K-307).
export function AssessmentPanel({
  state,
  score,
  onRequest,
}: {
  readonly state: AssessmentState;
  readonly score: number;
  readonly onRequest: () => void;
}): JSX.Element {
  void score;
  return (
    <section className="card" aria-label="Contract assessment with Muse">
      <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>Contract assessment with Muse</h2>
      <p className="assessment-label">
        <span className="assessment-dot" aria-hidden="true" />
        <span>Muse-generated, open weights by default: hosted-open-weights</span>
      </p>
      {state.status === "idle" ? (
        <div>
          <p className="muted">
            Request a free-text assessment of the closed evidence list. The score and evidence above never change.
          </p>
          <button type="button" className="button" onClick={onRequest}>
            Request assessment
          </button>
        </div>
      ) : null}
      {state.status === "loading" ? <p className="muted">Requesting assessment from the configured provider…</p> : null}
      {state.status === "not-configured" ? (
        <div>
          <p style={{ marginBottom: 4 }}>
            <strong>Assessment is not configured.</strong>
          </p>
          <p className="muted" style={{ marginTop: 0 }}>
            Set an assessment provider (default intent: hosted open weights, model
            meta-models/muse-spark-open-1026) with its API key to enable it.
          </p>
        </div>
      ) : null}
      {state.status === "error" ? (
        <div>
          <p style={{ marginBottom: 4 }}>
            <strong>Assessment unavailable.</strong>
          </p>
          <p className="muted" style={{ marginTop: 0 }}>
            {state.message}
          </p>
          <button type="button" className="button-ghost" onClick={onRequest}>
            Try again
          </button>
        </div>
      ) : null}
      {state.status === "ready" ? (
        <div>
          <p className="assessment-label">
            <span className="assessment-dot" aria-hidden="true" />
            <span>
              Muse-generated · provider {state.provider} · model {state.modelId}
            </span>
          </p>
          <p style={{ whiteSpace: "pre-wrap" }}>{state.text}</p>
        </div>
      ) : null}
    </section>
  );
}
