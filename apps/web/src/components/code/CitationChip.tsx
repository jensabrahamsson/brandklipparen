// Citation chip (addendum §A2.3, VS-2): line chips (`L3`), range
// chips (`L3–4`), cross-function chips (`transfer() L2`) and evidence
// chips (`Blacklist gate`). A chip whose target resolves is a 44 px
// button that focuses and pulses the target line (E-2); a chip whose
// target is unknown renders as plain text, never a button, so an
// uncited or hallucinated reference can never look clickable. Sentence
// case throughout; chips never use amber or red.
import type { JSX } from "react";
import type { ExplainCodeCite } from "../../lib/api.ts";

export type CitePosition = {
  // The function and pane the chip is rendered beside.
  readonly selector: string;
  readonly view: "decompiled" | "source";
};

export type CiteMaps = {
  // Line numbers present in the current pane.
  readonly lines: ReadonlySet<number>;
  // All functions of this contract: lower-cased selector to display name.
  readonly functions: ReadonlyMap<string, string>;
  // Known evidence ids to labels (sentence case, e.g. "Blacklist gate").
  readonly evidence: ReadonlyMap<string, string>;
};

export type ResolvedCite =
  | { readonly kind: "line"; readonly label: string; readonly line: number }
  | {
      readonly kind: "function";
      readonly label: string;
      readonly selector: string;
      readonly view: "decompiled" | "source";
      readonly line: number;
    }
  | { readonly kind: "evidence"; readonly label: string; readonly id: string }
  | { readonly kind: "unknown"; readonly label: string };

function shortSelector(selector: string): string {
  return selector.length <= 10 ? selector : selector.slice(0, 10);
}

// Pure target resolution, unit-tested: line, cross-function and
// evidence targets resolve; anything else stays plain text.
export function resolveCite(cite: ExplainCodeCite, current: CitePosition, maps: CiteMaps): ResolvedCite {
  if (cite.kind === "evidence") {
    const label = maps.evidence.get(cite.id);
    if (label !== undefined) {
      return { kind: "evidence", label, id: cite.id };
    }
    return { kind: "unknown", label: cite.id };
  }
  const sameFunction = cite.selector.toLowerCase() === current.selector.toLowerCase();
  const sameView = cite.view === current.view;
  if (sameFunction && sameView) {
    if (maps.lines.has(cite.line)) {
      return { kind: "line", label: `L${cite.line}`, line: cite.line };
    }
    return { kind: "unknown", label: `L${cite.line}` };
  }
  const name = maps.functions.get(cite.selector.toLowerCase());
  if (name !== undefined) {
    return { kind: "function", label: `${name} L${cite.line}`, selector: cite.selector, view: cite.view, line: cite.line };
  }
  if (sameFunction) {
    return { kind: "unknown", label: `L${cite.line}` };
  }
  return { kind: "unknown", label: `${shortSelector(cite.selector)} L${cite.line}` };
}

export function CitationChip({
  cite,
  current,
  maps,
  labelOverride,
  onLine,
  onFunction,
  onEvidence,
}: {
  readonly cite: ExplainCodeCite;
  readonly current: CitePosition;
  readonly maps: CiteMaps;
  // Notes anchor to a range: one chip names it (`L3–4`) and focuses
  // its first line.
  readonly labelOverride?: string | undefined;
  readonly onLine: (line: number) => void;
  readonly onFunction: (selector: string, view: "decompiled" | "source", line: number) => void;
  readonly onEvidence: (id: string) => void;
}): JSX.Element {
  const resolved = resolveCite(cite, current, maps);
  const label = labelOverride ?? resolved.label;
  if (resolved.kind === "line") {
    return (
      <button type="button" className="cite-chip" aria-label={`Muse note for line ${resolved.line}`} onClick={() => onLine(resolved.line)}>
        {label}
      </button>
    );
  }
  if (resolved.kind === "function") {
    return (
      <button
        type="button"
        className="cite-chip"
        aria-label={`Muse note in ${resolved.label}`}
        onClick={() => onFunction(resolved.selector, resolved.view, resolved.line)}
      >
        {label}
      </button>
    );
  }
  if (resolved.kind === "evidence") {
    return (
      <button type="button" className="cite-chip" aria-label={`Evidence: ${resolved.label}`} onClick={() => onEvidence(resolved.id)}>
        {label}
      </button>
    );
  }
  return (
    <span className="cite-chip is-unknown" aria-label={label}>
      {label}
    </span>
  );
}
