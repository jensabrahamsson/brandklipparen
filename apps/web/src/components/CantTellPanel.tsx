import type { JSX } from "react";
import type { CantTellEntry } from "../types.ts";
import { cantTellNeedsText, cantTellQuestionText } from "../lib/cantTellCopy.ts";
import { Pictogram } from "./Pictogram.tsx";

// Can't-tell panel: last section on the token page, collapsed by
// default. It never feeds the score.
export function CantTellPanel({ entries }: { readonly entries: readonly CantTellEntry[] }): JSX.Element {
  return (
    <details className="cant-tell" id="cant-tell" tabIndex={-1}>
      <summary className="cant-tell-summary">
        <Pictogram name="canttell" size={20} />
        <span>Can&apos;t tell ({entries.length})</span>
      </summary>
      <p className="muted" style={{ margin: "0 0 12px" }}>
        Not in the score.
      </p>
      {entries.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          Nothing flagged.
        </p>
      ) : (
        <ul className="cant">
          {entries.map((entry) => (
            <li key={entry.question} style={{ marginBottom: 8 }}>
              <div>
                <Pictogram name="canttell" size={16} /> {cantTellQuestionText(entry.question)}
              </div>
              <div className="quiet">Needs {cantTellNeedsText(entry.dataSource)}</div>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
