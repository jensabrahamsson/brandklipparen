// Muse line-anchored notes (addendum §A2.3–§A2.4, VS-2): one summary
// card plus 0–6 notes beside the code the sentence is about. Below
// 1600 px notes interleave after the last line of their range as
// indented callouts (X-1 expand, then the E-7 power-on); at 1600 px and
// above they sit as margin notes in the pane's right margin,
// top-aligned to the first cited line, stacked so they never overlap,
// without changing any code line height. Every note is an aside with
// its line range in the accessible name; the typewriter keeps the full
// text in the accessibility tree from the first frame (typed copy is
// aria-hidden) and announces once, when ready.
import { useEffect, useRef, useState, type CSSProperties, type JSX, type ReactNode } from "react";
import type { ExplainCodeNote } from "../../lib/api.ts";
import { useReducedMotion } from "../../lib/motion.ts";
import { motionAllowed, runNotesIntro } from "../../lib/explainMotion.ts";
import { Pictogram } from "../Pictogram.tsx";

export function noteRangeLabel(note: Pick<ExplainCodeNote, "from" | "to">): string {
  return note.from === note.to ? `line ${note.from}` : `lines ${note.from} to ${note.to}`;
}

export function noteRangeShort(note: Pick<ExplainCodeNote, "from" | "to">): string {
  return note.from === note.to ? `L${note.from}` : `L${note.from}–${note.to}`;
}

export function MuseNote({
  id,
  note,
  shownText,
  done,
  chips,
}: {
  // Focus target for the gutter ✦ marker and citation chips.
  readonly id: string;
  readonly note: ExplainCodeNote;
  // The typewriter slice; the full text stays in the sr-only twin.
  readonly shownText: string;
  readonly done: boolean;
  readonly chips: ReactNode;
}): JSX.Element {
  return (
    <aside id={id} tabIndex={-1} className="muse-note" aria-label={`Muse note, ${noteRangeLabel(note)}`}>
      <p className="muse-note-lines" aria-hidden="true">
        <Pictogram name="muse" size={16} />
        <span className="mono">{noteRangeShort(note)}</span>
      </p>
      <p className="muse-note-text">
        <span aria-hidden="true">
          {shownText}
          {done ? null : <b className="cursor" aria-hidden="true" />}
        </span>
        <span className="sr-only">{note.text}</span>
      </p>
      {chips === null || chips === undefined ? null : <p className="muse-note-chips">{chips}</p>}
    </aside>
  );
}

// One interleaved callout (<1600 px): it renders at rest height on
// mount, then the E-7 text power-on (opacity only, never movement).
// Turning notes off unmounts instantly, no exit animation. Static mode
// renders at rest with no animation.
export function InterleavedNote({
  noteId,
  note,
  shownText,
  done,
  chips,
  intro,
}: {
  readonly noteId: string;
  readonly note: ExplainCodeNote;
  readonly shownText: string;
  readonly done: boolean;
  readonly chips: ReactNode;
  // The E-7 intro runs once, when the note mounts into the reading flow.
  readonly intro: boolean;
}): JSX.Element {
  const reduce = useReducedMotion();
  const bodyRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!intro || reduce || !motionAllowed() || bodyRef.current === null) {
      return;
    }
    void runNotesIntro([bodyRef.current]).then(
      () => undefined,
      () => undefined,
    );
  }, [intro, reduce]);
  return (
    <li className="code-note-row" aria-label={`Muse note after ${noteRangeLabel(note)}`}>
      <div className="code-note-expand is-open">
        <div className="code-note-clip">
          <span
            ref={(element) => {
              bodyRef.current = element;
            }}
          >
            <MuseNote id={noteId} note={note} shownText={shownText} done={done} chips={chips} />
          </span>
        </div>
      </div>
    </li>
  );
}

// Margin notes (≥1600 px): absolutely positioned in the pane's reserved
// right margin, top-aligned to the first cited line. Overlapping notes
// stack downward with a dashed leader to their line; code line heights
// never change because the overlay takes no space in the line flow.
export function MarginNotes({
  notes,
  renderNote,
  lineTop,
}: {
  // Notes in line order with their aside ids.
  readonly notes: readonly { readonly id: string; readonly from: number }[];
  readonly renderNote: (id: string) => ReactNode;
  // Line number to offsetTop relative to the pane, null when unknown.
  readonly lineTop: (line: number) => number | null;
}): JSX.Element {
  // Stacking is layout, not motion: it always runs, so notes never
  // overlap under reduced motion either. Reduced motion only removes
  // the transition, which the global media query already disables.
  const [tops, setTops] = useState<ReadonlyMap<string, number> | null>(null);
  const asideRefs = useRef(new Map<string, HTMLElement>());
  const key = notes.map((note) => note.id).join(",");
  useEffect(() => {
    // Two passes: first align to the cited lines, then stack any notes
    // that would overlap, using measured heights.
    const first = new Map<string, number>();
    for (const note of notes) {
      first.set(note.id, lineTop(note.from) ?? 0);
    }
    const ordered = [...notes].sort((a, b) => (first.get(a.id) ?? 0) - (first.get(b.id) ?? 0));
    const stacked = new Map<string, number>();
    let floor = 0;
    for (const note of ordered) {
      const top = Math.max(first.get(note.id) ?? 0, floor);
      stacked.set(note.id, top);
      const height = asideRefs.current.get(note.id)?.offsetHeight ?? 0;
      floor = top + height + 8;
    }
    setTops(stacked);
  }, [key, lineTop]);
  return (
    <div className="code-margin-notes" aria-label="Muse notes">
      {notes.map((note) => {
        const top = tops?.get(note.id) ?? lineTop(note.from) ?? 0;
        return (
          <div
            key={note.id}
            className="code-margin-note"
            ref={(element) => {
              if (element === null) {
                asideRefs.current.delete(note.id);
              } else {
                asideRefs.current.set(note.id, element);
              }
            }}
            style={{ "--note-top": `${top}px` } as CSSProperties}
          >
            {renderNote(note.id)}
          </div>
        );
      })}
    </div>
  );
}
