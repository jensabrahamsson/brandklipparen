import type { JSX } from "react";
import type { InvestigationState, InvestigationStep } from "../types.ts";

// Investigation loop in its own tab: the opt-in runtime agent loop over
// the frozen deterministic result. The panel never receives score,
// probability or evidence setters, so the trace and narrative cannot move
// the deterministic result. Tool rationales and the narrative are model
// text and render as text only: React escapes them by default, and this
// panel uses no raw-HTML rendering path anywhere.
function StepGraph({ steps }: { readonly steps: readonly InvestigationStep[] }): JSX.Element | null {
  if (steps.length === 0) {
    return null;
  }
  return (
    <ol aria-label="Investigation steps" style={{ margin: "12px 0", paddingLeft: 24 }}>
      {steps.map((step) => (
        <li key={step.step} style={{ marginBottom: 8 }}>
          <p style={{ margin: 0 }}>
            <strong>
              Step {step.step}: {step.toolId}
            </strong>
          </p>
          <p className="muted" style={{ margin: "2px 0" }}>
            {step.rationale}
          </p>
          <p className="quiet mono numeric" style={{ margin: 0 }}>
            Evidence: {step.evidenceIds.length === 0 ? "none" : step.evidenceIds.join(", ")}
          </p>
        </li>
      ))}
    </ol>
  );
}

export function InvestigationPanel({
  state,
  score,
  onRequest,
}: {
  readonly state: InvestigationState;
  readonly score: number;
  readonly onRequest: () => void;
}): JSX.Element {
  void score;
  return (
    <section className="card" aria-label="Investigation">
      <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>Investigate with Muse</h2>
      {state.status === "idle" ? (
        <div>
          <p className="muted">
            Run the opt-in investigation loop on open weights over the frozen result. The model chooses
            deterministic checks step by step and cites the evidence it collects. The deterministic score,
            signals and evidence stay unchanged.
          </p>
          <button type="button" className="button" onClick={onRequest}>
            Request investigation
          </button>
        </div>
      ) : null}
      {state.status === "loading" ? (
        <div>
          <p className="muted" role="status">
            Investigating… steps stream in below.
          </p>
          <StepGraph steps={state.steps} />
        </div>
      ) : null}
      {state.status === "not-configured" ? (
        <div>
          <p style={{ marginBottom: 4 }}>
            <strong>Investigation is not configured.</strong>
          </p>
          <p className="muted" style={{ marginTop: 0 }}>
            The REST API reports no investigation provider. Set its key to enable the loop.
          </p>
        </div>
      ) : null}
      {state.status === "limit" ? (
        <div>
          <p style={{ marginBottom: 4 }}>
            <strong>Investigation stopped at its budget.</strong>
          </p>
          <p className="muted" style={{ marginTop: 0 }}>
            {state.message}
          </p>
          <StepGraph steps={state.steps} />
          <button type="button" className="button-ghost" onClick={onRequest}>
            Run again
          </button>
        </div>
      ) : null}
      {state.status === "failed" ? (
        <div>
          <p style={{ marginBottom: 4 }}>
            <strong>Investigation failed.</strong>
          </p>
          <p className="muted" style={{ marginTop: 0 }}>
            {state.message}
          </p>
          <StepGraph steps={state.steps} />
          <button type="button" className="button-ghost" onClick={onRequest}>
            Try again
          </button>
        </div>
      ) : null}
      {state.status === "done" ? (
        <div>
          <p className="assessment-label">
            <span className="assessment-dot" aria-hidden="true" />
            <span>
              Investigated with {state.provider} · model {state.modelId}
            </span>
          </p>
          <StepGraph steps={state.steps} />
          <h3 style={{ fontSize: 16, margin: "12px 0 4px" }}>Checked narrative</h3>
          {state.narrative.length > 0 ? (
            <p style={{ margin: "0 0 4px" }}>{state.narrative}</p>
          ) : (
            <p className="muted" style={{ margin: "0 0 4px" }}>
              Every drafted claim failed citation checking, so no narrative stands.
            </p>
          )}
          <p className="quiet" style={{ margin: 0 }}>
            {state.droppedClaims === 0
              ? "Every cited claim matched collected evidence."
              : `${state.droppedClaims} uncited claim${state.droppedClaims === 1 ? "" : "s"} dropped by citation checking.`}
          </p>
          <button type="button" className="button-ghost" onClick={onRequest} style={{ marginTop: 8 }}>
            Run again
          </button>
        </div>
      ) : null}
    </section>
  );
}
