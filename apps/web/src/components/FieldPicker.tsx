// Field picker (S-100, K-020, K-023): the visitor limits which overview
// sections render. The score section stays pinned and is never pickable,
// so filtering can never move the score; picked sections render, cleared
// sections hide. Pure display filter: scores, evidence and finding text
// stay byte-identical either way.
import type { JSX } from "react";

export const PICKABLE_SECTIONS: readonly { id: string; label: string }[] = Object.freeze([
  { id: "explanation", label: "Explanation" },
  { id: "signals", label: "Signals" },
  { id: "plugin-findings", label: "Plugin findings" },
  { id: "cant-tell", label: "Can't-tell" },
]);

export function FieldPicker({
  visible,
  onToggle,
}: {
  readonly visible: ReadonlySet<string>;
  readonly onToggle: (sectionId: string) => void;
}): JSX.Element {
  return (
    <fieldset className="card" style={{ marginBottom: 20 }}>
      <legend>Choose sections</legend>
      <p className="quiet" style={{ margin: "0 0 8px" }}>
        The score always stays on top; picked sections render below it.
      </p>
      {PICKABLE_SECTIONS.map((section) => (
        <label key={section.id} style={{ display: "block", margin: "4px 0" }}>
          <input
            type="checkbox"
            checked={visible.has(section.id)}
            onChange={() => onToggle(section.id)}
          />{" "}
          Show {section.label}
        </label>
      ))}
    </fieldset>
  );
}
