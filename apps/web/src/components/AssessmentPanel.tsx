import type { JSX } from "react";
import type { AssessmentState, ProviderInfo } from "../types.ts";
import { modelDisplayLabel, providerDisplayName } from "../lib/providers.ts";
import { FeatureUnavailable } from "./FeatureUnavailable.tsx";

// Contract assessment in its own tab: free-text assessment through the
// selected assessment provider, on explicit request only. The panel never
// receives score, probability or evidence setters, so assessment text
// cannot move the deterministic result. The provider label always comes
// from GET /health via props (design review P0-3): the real
// {provider, modelId}, or the disabled state when the REST API reports
// none. After an assessment response, the ready label shows the provider
// and model that answered.
export function AssessmentPanel({
  state,
  score,
  provider,
  onRequest,
}: {
  readonly state: AssessmentState;
  readonly score: number;
  readonly provider: ProviderInfo;
  readonly onRequest: () => void;
}): JSX.Element {
  void score;
  // No card of its own (UI v2 §1.2): the Muse console owns the frame and
  // this block renders inside its output area.
  return (
    <section aria-label="Contract assessment">
      <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>Contract assessment</h2>
      {provider.status === "loading" ? (
        <p className="assessment-label">
          <span className="assessment-dot" aria-hidden="true" />
          <span>Checking assessment provider…</span>
        </p>
      ) : null}
      {provider.status === "disabled" ? (
        <p className="assessment-label">
          <span className="assessment-dot" aria-hidden="true" />
          <span>Assessment is not configured: no assessment provider is set up on this server.</span>
        </p>
      ) : null}
      {provider.status === "ready" && state.status !== "ready" ? (
        <p className="assessment-label">
          <span className="assessment-dot" aria-hidden="true" />
          <span>
            {provider.modelId === "muse-spark-1.3" ? null : `${providerDisplayName(provider.provider)} · `}<span title={provider.modelId}>{modelDisplayLabel(provider.modelId)}</span>
          </span>
        </p>
      ) : null}
      {state.status === "idle" ? (
        provider.status === "disabled" ? (
          <FeatureUnavailable
            title="Contract assessment"
            reason="Contract assessment is not configured on this server."
            actionLabel="Request assessment"
          />
        ) : (
          <div>
            <p className="muted">A plain-language read of the findings above.</p>
            <button type="button" className="button" onClick={onRequest}>
              Request assessment
            </button>
          </div>
        )
      ) : null}
      {state.status === "loading" ? <p className="muted">Requesting assessment from the configured provider…</p> : null}
      {state.status === "not-configured" ? (
        <FeatureUnavailable
          title="Contract assessment"
          reason="Contract assessment is not configured on this server."
          actionLabel="Request assessment"
        />
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
              {state.modelId === "muse-spark-1.3" ? null : `${providerDisplayName(state.provider)} · `}<span title={state.modelId}>{modelDisplayLabel(state.modelId)}</span>
            </span>
          </p>
          <p style={{ whiteSpace: "pre-wrap" }}>{state.text}</p>
        </div>
      ) : null}
    </section>
  );
}
