import type { JSX } from "react";
import type { CantTellEntry } from "../types.ts";
import { Explain } from "./Explain.tsx";

// Can't-tell panel (K-021): dashed border, hatched fill, labelled outside
// the score. It never feeds the score and says so.
export function CantTellPanel({ entries }: { readonly entries: readonly CantTellEntry[] }): JSX.Element {
  return (
    <section className="cant-tell" data-tilt aria-label="What bytecode alone cannot tell you">
      <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>
        <span>What bytecode alone cannot tell you</span> <Explain explainKey="cant-tell" label="Can't-tell list" />
      </h2>
      <p className="muted" style={{ margin: "0 0 12px" }}>
        These answers live outside the score and never change it.
      </p>
      {entries.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          Nothing is currently marked as unknowable for this token.
        </p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {entries.map((entry) => (
            <li key={entry.question} style={{ marginBottom: 8 }}>
              <div>{entry.question}</div>
              <div className="quiet">Needs: {entry.dataSource}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
