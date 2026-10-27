import { useState, type JSX } from "react";
import { signalTitle } from "../lib/signals.ts";
import type { Signal } from "../types.ts";

// Expandable signal and evidence list (K-021). Every contract-derived
// string renders as React text only, so hostile content stays inert
// (K-507): no HTML sinks anywhere in this view.

export function SignalList({ signals }: { readonly signals: readonly Signal[] }): JSX.Element {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(signals.slice(0, 1).map((signal) => signal.id)));
  if (signals.length === 0) {
    return <p className="muted">No signals: the bytecode shows none of the tracked risk patterns.</p>;
  }
  const toggle = (id: string): void => {
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };
  return (
    <div>
      {signals.map((signal) => {
        const expanded = open.has(signal.id);
        return (
          <article key={signal.id} className={signal.direction === "lowers" ? "signal signal-lowers" : "signal signal-raises"}>
            <button
              type="button"
              className="button-ghost"
              aria-expanded={expanded}
              onClick={() => toggle(signal.id)}
              style={{ border: "none", padding: 0, color: "var(--text)", fontSize: 16, fontWeight: 600 }}
            >
              {signalTitle(signal)} {expanded ? "▾" : "▸"}
            </button>
            <p className="quiet" style={{ margin: "4px 0 0" }}>
              {signal.risk} · {signal.direction ?? "raises"} · severity {signal.severity ?? "medium"}
            </p>
            {expanded ? (
              <div>
                <h4 className="quiet">EVIDENCE IN BYTECODE</h4>
                <ul className="mono numeric" style={{ listStyle: "none", padding: 0, fontSize: 13 }}>
                  {signal.evidence.map((entry, index) => (
                    <li key={`${entry.selector}-${index}`}>
                      {entry.selector}
                      <span className="quiet"> · PC {entry.offset === null ? "unknown" : `0x${entry.offset.toString(16)}`}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
