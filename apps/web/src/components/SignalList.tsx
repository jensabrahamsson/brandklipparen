import { useState, type JSX } from "react";
import { signalKey, signalTitle } from "../lib/signals.ts";
import type { Signal } from "../types.ts";
import { Explain } from "./Explain.tsx";

// Expandable signal and evidence list. Every contract-derived string
// renders as React text only, so hostile content stays inert: no HTML
// sinks anywhere in this view.
//
// Identity (S-116): the REST layer may repeat signal ids within one
// response, so articles, DOM ids and open state key on the stable
// position-derived signal key, never on the signal id. Template lines map
// to signals by position and risk through the same order.
// Expanded evidence slots (design review P0-5):
// - decompiled snippet: the v1 REST schema carries no snippet field, so
//   the slot is an honest placeholder, never faked content;
// - copy evidence: JSON of address/codeHash/signal/evidence;
// - open in bytecode: disabled with a reason, since this view has no
//   bytecode pane;
// - per-signal template line when an explanation claim links the signal.
export function SignalList({
  signals,
  target,
  codeHash,
  deepening,
  expert,
  open,
  onToggle,
  templateLine,
}: {
  readonly signals: readonly Signal[];
  readonly target: string;
  readonly codeHash: string;
  readonly deepening: "pending" | "ready" | "unavailable";
  readonly expert: boolean;
  readonly open: ReadonlySet<string>;
  readonly onToggle: (key: string) => void;
  readonly templateLine: (index: number) => string | undefined;
}): JSX.Element {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  if (signals.length === 0) {
    return <p className="muted">No signals: the bytecode shows none of the tracked risk patterns.</p>;
  }

  const copyEvidence = async (signal: Signal): Promise<void> => {
    const payload = JSON.stringify(
      { address: target, codeHash, signal: signal.id, evidence: signal.evidence },
      null,
      2,
    );
    try {
      await navigator.clipboard.writeText(payload);
      setCopiedId(signal.id);
    } catch {
      // Clipboard is a convenience only; the JSON stays readable in-view.
    }
  };

  // The empty-snippet reason stays plain in Simple mode; the schema
  // detail behind it lives in Expert mode (S-131).
  const snippetText =
    deepening === "pending"
      ? "Snippet arrives with deepening: the analysis is still streaming."
      : deepening === "ready"
        ? expert
          ? "Deepening is ready, but this v1 response carries no decompiled snippet (REST contract gap: v1 has no snippet field)."
          : "No decompiled snippet is available for this signal."
        : expert
          ? "Deepening did not resolve; no snippet is available (REST contract gap: v1 has no snippet field)."
          : "No decompiled snippet is available for this signal.";

  return (
    <div>
      <p aria-live="polite" className="quiet" style={{ position: "absolute", left: -9999 }}>
        {copiedId === null ? "" : `Evidence for ${copiedId} copied.`}
      </p>
      {signals.map((signal, index) => {
        const key = signalKey(signal, index);
        const expanded = open.has(key);
        const line = templateLine(index);
        // Inverted severity tag (Phosphor Console): HIGH reads as inverse
        // video with a warning pulse; the severity also stays in words in
        // the meta line below, so it is never colour-only.
        const severity = signal.severity ?? "medium";
        const sevClass = severity === "high" ? "high" : severity === "low" ? "low" : "medium";
        const sevWord = severity === "high" ? "HIGH" : severity === "low" ? "LOW" : "MED";
        return (
          <article
            key={key}
            id={`signal-${key}`}
            className={signal.direction === "lowers" ? "signal signal-lowers" : "signal signal-raises"}
          >
            <span className={`sev ${sevClass}`} aria-hidden="true">
              {sevWord}
            </span>
            <button
              type="button"
              className="button-ghost signal-toggle"
              aria-expanded={expanded}
              onClick={() => onToggle(key)}
              style={{ border: "none", padding: 0, color: "var(--text)", fontSize: 16, fontWeight: 600 }}
            >
              {signalTitle(signal)} {expanded ? "▾" : "▸"}
            </button>
            <p className="quiet" style={{ margin: "4px 0 0" }}>
              {signal.risk} · {signal.direction ?? "raises"} · severity {signal.severity ?? "medium"}
            </p>
            {line !== undefined ? (
              <p className="muted" style={{ margin: "4px 0 0", fontSize: 14 }}>
                Template: {line} <Explain explainKey="explanation:claim" label="Template sentence" />
              </p>
            ) : null}
            {expanded ? (
              <div>
                <h3 className="quiet" style={{ fontSize: 12 }}>
                  EVIDENCE IN BYTECODE <Explain explainKey="evidence:selector" label="Evidence rows" />
                </h3>
                <ul className="mono numeric ev-list" style={{ fontSize: 13 }}>
                  {signal.evidence.map((entry, index) => (
                    <li key={`${entry.selector}-${index}`}>
                      {entry.selector}
                      <span className="quiet"> · PC {entry.offset === null ? "unknown" : `0x${entry.offset.toString(16)}`}</span>
                    </li>
                  ))}
                </ul>
                <h3 className="quiet" style={{ fontSize: 12 }}>
                  DECOMPILED SNIPPET <Explain explainKey="evidence:snippet" label="Decompiled snippet" />
                </h3>
                <p className="muted" style={{ fontSize: 13, margin: "0 0 8px" }}>
                  {snippetText}
                </p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button type="button" className="button-ghost" onClick={() => void copyEvidence(signal)}>
                    Copy evidence
                  </button>
                  <button
                    type="button"
                    className="button-ghost"
                    disabled
                    title="This view has no bytecode pane to open."
                    aria-label={`Open ${signal.id} in bytecode (unavailable: this view has no bytecode pane)`}
                  >
                    Open in bytecode
                  </button>
                </div>
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
