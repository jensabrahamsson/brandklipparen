import type { JSX } from "react";
import type { InvestigationState, InvestigationStep, Signal } from "../types.ts";
import { splitNarrative } from "../lib/investigation.ts";
import { modelDisplayLabel, providerDisplayName } from "../lib/providers.ts";
import { Explain } from "./Explain.tsx";
import { CoverageChip } from "./ExplainPanel.tsx";
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
// citations become lamp chips that move focus to the linked finding;
// unknown ids render nothing, never a raw id. No transforms, no
// rotation, and the connector never animates.
function EvidenceChips({
  evidenceIds,
  signals,
  address,
  allIds,
  onSignalLink,
}: {
  readonly evidenceIds: readonly string[];
  readonly signals: readonly Signal[];
  readonly address: string;
  readonly allIds: readonly string[];
  readonly onSignalLink: (key: string) => void;
}): JSX.Element | null {
  if (evidenceIds.length === 0) {
    return <span className="muted">none</span>;
  }
  return (
    <>
      {evidenceIds.map((id) => (
        <CoverageChip
          key={id}
          id={id}
          signals={signals}
          address={address}
          allIds={allIds}
          onSignalLink={onSignalLink}
        />
      ))}
    </>
  );
}

function StepGraph({
  steps,
  signals,
  address,
  allIds,
  onSignalLink,
}: {
  readonly steps: readonly InvestigationStep[];
  readonly signals: readonly Signal[];
  readonly address: string;
  readonly allIds: readonly string[];
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
              Evidence:{" "}
              <EvidenceChips
                evidenceIds={step.evidenceIds}
                signals={signals}
                address={address}
                allIds={allIds}
                onSignalLink={onSignalLink}
              />
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
  address,
  allIds,
  onSignalLink,
}: {
  readonly narrative: string;
  readonly signals: readonly Signal[];
  readonly address: string;
  readonly allIds: readonly string[];
  readonly onSignalLink: (key: string) => void;
}): JSX.Element {
  return (
    <p style={{ margin: "0 0 4px" }}>
      {splitNarrative(narrative).map((part, index) =>
        part.kind === "text" ? (
          <span key={index}>{part.text}</span>
        ) : (
          <EvidenceChips
            key={index}
            evidenceIds={[part.id]}
            signals={signals}
            address={address}
            allIds={allIds}
            onSignalLink={onSignalLink}
          />
        ),
      )}
    </p>
  );
}

// Wording for removed sentences, shown only inside a Details
// disclosure: the count plus the reason in plain words, with the
// uncited vs unknown-id split when the report carries it.
function removedLine(
  droppedClaims: number,
  dropReasons: { readonly uncited: number; readonly unknownId: number } | undefined,
): string {
  if (droppedClaims <= 0) {
    return "Every cited claim matched collected evidence.";
  }
  if (droppedClaims === 1) {
    return "1 sentence removed: it cited no evidence.";
  }
  if (dropReasons !== undefined) {
    const parts: string[] = [];
    if (dropReasons.uncited > 0) {
      parts.push(`${dropReasons.uncited} cited nothing`);
    }
    if (dropReasons.unknownId > 0) {
      parts.push(`${dropReasons.unknownId} cited an unknown id`);
    }
    if (parts.length > 0) {
      return `${droppedClaims} sentences removed: ${parts.join(", ")}.`;
    }
  }
  return `${droppedClaims} sentences removed: they cited no evidence.`;
}

export function InvestigationPanel({
  state,
  score,
  signals,
  address,
  allIds,
  onSignalLink,
  onRequest,
}: {
  readonly state: InvestigationState;
  readonly score: number;
  readonly signals: readonly Signal[];
  readonly address: string;
  readonly allIds: readonly string[];
  readonly onSignalLink: (key: string) => void;
  readonly onRequest: () => void;
}): JSX.Element {
  void score;
  // No card of its own (UI v2 §1.2): the Muse console owns the frame and
  // this block renders inside its output area. The console starts the
  // run the moment the visitor presses Investigate, so there is no idle
  // explainer and no second button here.
  return (
    <section aria-label="Investigation">
      <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>Investigate with Muse</h2>
      {state.status === "idle" ? <ScanStatus text="Investigating… steps stream in below." /> : null}
      {state.status === "loading" ? (
        <div>
          <ScanStatus text="Investigating… steps stream in below." />
          <StepGraph steps={state.steps} signals={signals} address={address} allIds={allIds} onSignalLink={onSignalLink} />
        </div>
      ) : null}
      {state.status === "not-configured" ? (
        <FeatureUnavailable
          title="Investigation"
          reason="Investigation is not available on this server."
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
          <StepGraph steps={state.steps} signals={signals} address={address} allIds={allIds} onSignalLink={onSignalLink} />
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
          <StepGraph steps={state.steps} signals={signals} address={address} allIds={allIds} onSignalLink={onSignalLink} />
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
              {state.modelId === "muse-spark-1.3" ? null : `${providerDisplayName(state.provider)} · `}<span title={state.modelId}>{modelDisplayLabel(state.modelId)}</span>
            </span>
          </p>
          {state.forcedConclusion ? (
            <p className="quiet" style={{ margin: "4px 0 0" }}>
              Muse concluded at the step limit.
            </p>
          ) : null}
          <StepGraph steps={state.steps} signals={signals} address={address} allIds={allIds} onSignalLink={onSignalLink} />
          <h3 style={{ fontSize: 16, margin: "12px 0 4px" }}>
            <span>Checked narrative</span> <Explain explainKey="investigation:narrative" label="Checked narrative" />
          </h3>
          {state.narrative.length > 0 ? (
            <CheckedNarrative narrative={state.narrative} signals={signals} address={address} allIds={allIds} onSignalLink={onSignalLink} />
          ) : (
            <p className="muted" style={{ margin: "0 0 4px" }}>
              Muse&apos;s conclusion did not cite collected evidence, so it is not shown.
            </p>
          )}
          <details className="muse-details">
            <summary>Details</summary>
            <p className="quiet" style={{ margin: 0 }}>
              {removedLine(state.droppedClaims, state.dropReasons)}
            </p>
          </details>
          <button type="button" className="button-ghost" onClick={onRequest} style={{ marginTop: 8 }}>
            Run again
          </button>
        </div>
      ) : null}
    </section>
  );
}
