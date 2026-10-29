import type { JSX } from "react";
import type { CantTellEntry } from "../types.ts";
import { cantTellNeedsText, cantTellQuestionText } from "../lib/cantTellCopy.ts";
import { Explain } from "./Explain.tsx";

// Can't-tell panel (K-021): dashed border, hatched fill, labelled outside
// the score. It never feeds the score and says so. Entries render as
// plain questions (S-131); the envelope keeps the stable slugs.
export function CantTellPanel({ entries }: { readonly entries: readonly CantTellEntry[] }): JSX.Element {
  return (
    <section className="cant-tell" aria-label="What bytecode alone cannot tell you">
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
        <ul className="cant">
          {entries.map((entry) => (
            <li key={entry.question} style={{ marginBottom: 8 }}>
              <div>{cantTellQuestionText(entry.question)}</div>
              <div className="quiet">Needs {cantTellNeedsText(entry.dataSource)}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
