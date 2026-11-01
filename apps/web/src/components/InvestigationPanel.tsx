import type { JSX } from "react";
import type { InvestigationState, InvestigationStep, Signal } from "../types.ts";
import type { Availability } from "../lib/capabilities.ts";
import { evidenceSignalKey, splitNarrative } from "../lib/investigation.ts";
import { providerDisplayName } from "../lib/providers.ts";
import { Explain } from "./Explain.tsx";
import { FeatureUnavailable } from "./FeatureUnavailable.tsx";
import { ScanStatus } from "./ScanStatus.tsx";

// Investigation loop in its own tab: the opt-in runtime agent loop over
// the frozen deterministic result. The panel never receives score,
// probability or evidence setters, so the trace and narrative cannot move
// the deterministic result. Tool rationales and the narrative are model
// text and render as text only: React escapes them by default, and this
// panel uses no raw-HTML rendering path anywhere.
//
// The trace renders as a static vertical timeline (S-125): one numbered
// node per step joined by a static connector. Evidence ids and narrative
// citations become chips that move focus to the linked signal and expand
// it. No transforms, no rotation, and the connector never animates.
function EvidenceChips({
  evidenceIds,
  signals,
  onSignalLink,
}: {
  readonly evidenceIds: readonly string[];
  readonly signals: readonly Signal[];
  readonly onSignalLink: (key: string) => void;
}): JSX.Element {
  if (evidenceIds.length === 0) {
    return <span className="muted">none</span>;
  }
  return (
    <>
      {evidenceIds.map((id) => {
        const key = evidenceSignalKey(signals, id);
        const label = id.startsWith("signal:") ? id.slice("signal:".length) : id;
        return key === null ? (
          <span key={id} className="tool-chip" style={{ margin: "2px 4px 2px 0" }}>
            {label}
          </span>
        ) : (
          <button
            key={id}
            type="button"
            className="chip mono"
            data-evidence={id}
            style={{ margin: "2px 4px 2px 0" }}
            onClick={() => onSignalLink(key)}
          >
            {label}
          </button>
        );
      })}
    </>
  );
}

function StepGraph({
  steps,
  signals,
  onSignalLink,
}: {
  readonly steps: readonly InvestigationStep[];
  readonly signals: readonly Signal[];
  readonly onSignalLink: (key: string) => void;
}): JSX.Element | null {
  if (steps.length === 0) {
    return null;
  }
  return (
    <ol className="timeline" aria-label="Investigation steps" data-graph="2d">
      {steps.map((step) => (
        <li key={step.step} className="timeline-step" value={step.step}>
          <span className="timeline-node" aria-hidden="true">
            {step.step}
          </span>
          <div className="timeline-body">
            <p style={{ margin: "0 0 4px" }}>
              <span className="tool-chip">{step.toolId}</span>{" "}
              <Explain explainKey="investigation:step" label={`Investigation step ${step.step}`} />
            </p>
            <p className="muted" style={{ margin: "0 0 4px" }}>
              {step.rationale}
            </p>
            <p className="quiet" style={{ margin: 0 }}>
              Evidence: <EvidenceChips evidenceIds={step.evidenceIds} signals={signals} onSignalLink={onSignalLink} />
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function CheckedNarrative({
  narrative,
  signals,
  onSignalLink,
}: {
  readonly narrative: string;
  readonly signals: readonly Signal[];
  readonly onSignalLink: (key: string) => void;
}): JSX.Element {
  return (
    <p style={{ margin: "0 0 4px" }}>
      {splitNarrative(narrative).map((part, index) =>
        part.kind === "text" ? (
          <span key={index}>{part.text}</span>
        ) : (
          <EvidenceChips key={index} evidenceIds={[part.id]} signals={signals} onSignalLink={onSignalLink} />
        ),
      )}
    </p>
  );
}

export function InvestigationPanel({
  state,
  score,
  availability,
  signals,
  onSignalLink,
  onRequest,
}: {
  readonly state: InvestigationState;
  readonly score: number;
  readonly availability: Availability;
  readonly signals: readonly Signal[];
  readonly onSignalLink: (key: string) => void;
  readonly onRequest: () => void;
}): JSX.Element {
  void score;
  // No card of its own (UI v2 §1.2): the Muse console owns the frame and
  // this block renders inside its output area.
  return (
    <section aria-label="Investigation">
      <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>Investigate with Muse</h2>
      {state.status === "idle" ? (
        availability === "unavailable" ? (
          <FeatureUnavailable
            title="Investigation"
            reason="AI investigation is not configured on this server."
            actionLabel="Request investigation"
          />
        ) : (
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
        )
      ) : null}
      {state.status === "loading" ? (
        <div>
          <ScanStatus text="Investigating… steps stream in below." />
          <StepGraph steps={state.steps} signals={signals} onSignalLink={onSignalLink} />
        </div>
      ) : null}
      {state.status === "not-configured" ? (
        <FeatureUnavailable
          title="Investigation"
          reason="AI investigation is not configured on this server."
          actionLabel="Request investigation"
        />
      ) : null}
      {state.status === "limit" ? (
        <div>
          <p style={{ marginBottom: 4 }}>
            <strong>Investigation stopped at its budget.</strong>
          </p>
          <p className="muted" style={{ marginTop: 0 }}>
            {state.message}
          </p>
          <StepGraph steps={state.steps} signals={signals} onSignalLink={onSignalLink} />
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
          <StepGraph steps={state.steps} signals={signals} onSignalLink={onSignalLink} />
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
              Investigated with {providerDisplayName(state.provider)} · model {state.modelId}
            </span>
          </p>
          {state.forcedConclusion ? (
            <p className="quiet" style={{ margin: "4px 0 0" }}>
              Muse concluded at the step limit.
            </p>
          ) : null}
          <StepGraph steps={state.steps} signals={signals} onSignalLink={onSignalLink} />
          <h3 style={{ fontSize: 16, margin: "12px 0 4px" }}>
            <span>Checked narrative</span> <Explain explainKey="investigation:narrative" label="Checked narrative" />
          </h3>
          {state.narrative.length > 0 ? (
            <CheckedNarrative narrative={state.narrative} signals={signals} onSignalLink={onSignalLink} />
          ) : (
            <p className="muted" style={{ margin: "0 0 4px" }}>
              Muse&apos;s conclusion did not cite collected evidence, so it is not shown.
            </p>
          )}
          <p className="quiet" style={{ margin: 0 }}>
            {state.droppedClaims === 0
              ? "Every cited claim matched collected evidence."
              : state.dropReasons === undefined
                ? `${state.droppedClaims} uncited claim${state.droppedClaims === 1 ? "" : "s"} dropped by citation checking.`
                : `${state.droppedClaims} claim${state.droppedClaims === 1 ? "" : "s"} dropped by citation checking (${state.dropReasons.uncited} uncited, ${state.dropReasons.unknownId} with unknown ids).`}
          </p>
          <button type="button" className="button-ghost" onClick={onRequest} style={{ marginTop: 8 }}>
            Run again
          </button>
        </div>
      ) : null}
    </section>
  );
}
