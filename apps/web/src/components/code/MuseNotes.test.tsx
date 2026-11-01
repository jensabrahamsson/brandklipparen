// Muse notes unit test (addendum §A2.3-§A2.4, VS-2): the aside names
// its line range, the typewriter keeps the full text in the
// accessibility tree from the first frame, and margin notes align to
// their cited lines. Behavior only: rendered text, roles and labels.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import {
  InterleavedNote,
  MarginNotes,
  MuseNote,
  noteRangeLabel,
  noteRangeShort,
} from "./MuseNotes.tsx";
import type { ExplainCodeNote } from "../../lib/api.ts";

const NOTE: ExplainCodeNote = { lines: [3, 4], from: 3, to: 4, text: "The owner check happens here.", cites: [] };
const SINGLE: ExplainCodeNote = { lines: [6], from: 6, to: 6, text: "This emits the change.", cites: [] };

describe("muse notes", () => {
  test("range labels read as sentences", () => {
    expect(noteRangeLabel(NOTE)).toBe("lines 3 to 4");
    expect(noteRangeLabel(SINGLE)).toBe("line 6");
    expect(noteRangeShort(NOTE)).toBe("L3–4");
    expect(noteRangeShort(SINGLE)).toBe("L6");
  });

  test("a note names its lines and keeps the full text in the tree while typing", () => {
    const html = renderToString(
      <MuseNote id="note-1" note={NOTE} shownText="The owner check" done={false} chips={null} />,
    );
    expect(html).toContain('aria-label="Muse note, lines 3 to 4"');
    expect(html).toContain("L3–4");
    // The typed copy is visual only; the full sentence stays readable.
    expect(html).toContain('aria-hidden="true">The owner check');
    expect(html).toContain('<span class="sr-only">The owner check happens here.</span>');
  });

  test("a finished note shows the full text with no cursor", () => {
    const html = renderToString(
      <MuseNote id="note-1" note={SINGLE} shownText={SINGLE.text} done={true} chips={<span>chip</span>} />,
    );
    expect(html).toContain('aria-label="Muse note, line 6"');
    expect(html).toContain("chip");
    expect(html).not.toContain("cursor");
  });

  test("an interleaved note sits in the line flow after its range", () => {
    const html = renderToString(
      <InterleavedNote noteId="n-0" note={NOTE} shownText={NOTE.text} done={true} chips={null} intro={true} />,
    );
    expect(html).toContain("code-note-row");
    expect(html).toContain('aria-label="Muse note after lines 3 to 4"');
    expect(html).toContain('id="n-0"');
  });

  test("margin notes top-align to their first cited line", () => {
    const html = renderToString(
      <MarginNotes
        notes={[
          { id: "n-0", from: 3 },
          { id: "n-1", from: 6 },
        ]}
        renderNote={(id) => <span>{id}</span>}
        lineTop={(line) => line * 20}
      />,
    );
    expect(html).toContain("code-margin-notes");
    expect(html).toContain("--note-top:60px");
    expect(html).toContain("--note-top:120px");
  });
});
