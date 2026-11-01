// "Explain this code" (addendum §A2, VS-2): per-function Muse
// read-along beside the code the sentence is about. One request per
// button press through POST /v1/explain-code; re-opening a function
// restores the stored overlay with no new request. Sentences type one
// at a time (M-4 pacing, ≤600 ms each, 4 s total cap); while a sentence
// types its cited lines ignite (E-1) and settle to a faint cited
// background with a ✦ gutter marker. Any key, pointer or wheel input
// finishes the typing and every running animation instantly. The full
// text stays in the accessibility tree from the first frame (typed copy
// is aria-hidden) and a polite live region announces once, when ready.
// Reduced motion or Motion off renders everything at rest with no
// animation and no cursor. Scores, evidence and finding text are never
// touched: this is a labelled advisory overlay with the standing
// footer "AI explanation · does not change the score".
import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import {
  fetchExplainCode,
  peekExplainCode,
  refreshExplainCode,
  type ExplainCodeCite,
  type ExplainCodeNote,
  type ExplainCodeState,
  type ExplainCodeView,
} from "../../lib/api.ts";
import { finishAll, motionAllowed, runCitedIgnite } from "../../lib/explainMotion.ts";
import { reducedMotionRequested } from "../../lib/motion.ts";
import { Pictogram } from "../Pictogram.tsx";
import { CitationChip, resolveCite, type CiteMaps, type CitePosition } from "./CitationChip.tsx";
import { MuseNote } from "./MuseNotes.tsx";

const TICK_MS = 16;
const TICKS_PER_SENTENCE = 37;
const TOTAL_BUDGET_MS = 4000;

export type ExplainStatus = "idle" | "pending" | "ready" | "invalid-output" | "capped" | "failed";

export type TypedEntry = {
  readonly key: string;
  readonly kind: "summary" | "note";
  readonly text: string;
  readonly shown: string;
  readonly done: boolean;
  readonly mounted: boolean;
  readonly note: ExplainCodeNote | null;
  readonly cites: readonly ExplainCodeCite[];
  // Cited lines in this pane (same selector and view, present below).
  readonly lines: readonly number[];
};

export type ExplainRuntime = {
  readonly status: ExplainStatus;
  readonly provider: string | null;
  readonly modelId: string | null;
  readonly dropped: number;
  readonly entries: readonly TypedEntry[];
  readonly liveLines: ReadonlySet<number>;
  readonly citedLines: ReadonlySet<number>;
  readonly readyMessage: string | null;
  readonly request: () => void;
  readonly retry: () => void;
  readonly askAgain: () => void;
};

function samePaneLines(
  cites: readonly ExplainCodeCite[],
  selector: string,
  view: ExplainCodeView,
  paneLines: ReadonlySet<number>,
): number[] {
  const out = new Set<number>();
  for (const cite of cites) {
    if (
      cite.kind === "line" &&
      cite.selector.toLowerCase() === selector.toLowerCase() &&
      cite.view === view &&
      paneLines.has(cite.line)
    ) {
      out.add(cite.line);
    }
  }
  return [...out].sort((first, second) => first - second);
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

// Per-view explanation state. One instance drives one pane: the header
// button, the summary card and the note bodies that CodeView places
// beside the code (interleaved below 1600 px, margin notes above).
export function useExplainCodeView({
  address,
  apiKey,
  selector,
  view,
  available,
  paneLines,
  lineElement,
}: {
  readonly address: string;
  readonly apiKey: string | null;
  readonly selector: string;
  readonly view: ExplainCodeView;
  readonly available: boolean;
  readonly paneLines: ReadonlySet<number>;
  readonly lineElement: (line: number) => HTMLLIElement | null;
}): ExplainRuntime {
  const [status, setStatus] = useState<ExplainStatus>("idle");
  const [data, setData] = useState<Extract<ExplainCodeState, { status: "ready" }> | null>(null);
  const [dropped, setDropped] = useState(0);
  const [provider, setProvider] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [active, setActive] = useState(0);
  const [chars, setChars] = useState(0);
  const [finished, setFinished] = useState(false);
  const startedAt = useRef(0);
  const requestId = useRef(0);

  const staticMode = reducedMotionRequested() || motionAllowed() === false;

  // Re-opening restores the stored overlay instantly: no new request,
  // no typing replay, full text at rest with cited lines marked.
  useEffect(() => {
    if (!available || status !== "idle") {
      return;
    }
    const settled = peekExplainCode(address, selector, view);
    if (settled !== null && (settled.status === "ready" || settled.status === "invalid-output" || settled.status === "capped")) {
      if (settled.status === "ready") {
        setData(settled);
        setDropped(settled.droppedClaims);
        setProvider(settled.provider);
        setModelId(settled.modelId);
      }
      setStatus(settled.status);
      setRestored(true);
      setFinished(true);
    }
  }, [address, selector, view, available, status]);

  const entries = useMemo(() => {
    if (data === null) {
      return [];
    }
    const built: Omit<TypedEntry, "shown" | "done" | "mounted">[] = [];
    data.summary.forEach((sentence, index) => {
      built.push({
        key: `summary-${index}`,
        kind: "summary",
        text: sentence.text,
        note: null,
        cites: sentence.cites,
        lines: samePaneLines(sentence.cites, selector, view, paneLines),
      });
    });
    data.notes.forEach((note, index) => {
      const ranged = note.lines.filter((line) => paneLines.has(line));
      const cited = samePaneLines(note.cites, selector, view, paneLines);
      const lines = [...new Set([...ranged, ...cited])].sort((first, second) => first - second);
      built.push({ key: `note-${index}`, kind: "note", text: note.text, note, cites: note.cites, lines });
    });
    return built;
  }, [data, paneLines]);

  // New data restarts the read-along; restored or static overlays show
  // everything at once.
  useEffect(() => {
    if (data === null) {
      return;
    }
    if (restored || staticMode) {
      setActive(entries.length);
      setChars(0);
      setFinished(true);
      return;
    }
    startedAt.current = 0;
    setActive(0);
    setChars(0);
    setFinished(false);
  }, [data, restored, staticMode, entries.length]);

  // E-1 read-along: sentences type one at a time while their cited
  // lines ignite; the 4 s total cap reveals the rest at once. Any key,
  // pointer or wheel input finishes the typing and every running
  // animation instantly: the visitor is never made to wait.
  useEffect(() => {
    if (status !== "ready" || data === null || staticMode || finished) {
      return;
    }
    if (active >= entries.length) {
      setFinished(true);
      return;
    }
    if (startedAt.current === 0) {
      startedAt.current = Date.now();
    }
    const finish = (): void => {
      finishAll();
      setActive(entries.length);
      setChars(0);
      setFinished(true);
    };
    const onInput = (): void => {
      finish();
    };
    const timer = window.setInterval(() => {
      if (Date.now() - startedAt.current > TOTAL_BUDGET_MS) {
        finish();
        return;
      }
      const entry = entries[active];
      if (entry === undefined) {
        finish();
        return;
      }
      const chunk = Math.max(1, Math.ceil(entry.text.length / TICKS_PER_SENTENCE));
      const next = chars + chunk;
      if (next >= entry.text.length) {
        const following = active + 1;
        setChars(0);
        setActive(following);
        if (following >= entries.length) {
          setFinished(true);
        }
        return;
      }
      setChars(next);
    }, TICK_MS);
    window.addEventListener("keydown", onInput, { passive: true });
    window.addEventListener("pointerdown", onInput, { passive: true });
    window.addEventListener("wheel", onInput, { passive: true });
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("keydown", onInput);
      window.removeEventListener("pointerdown", onInput);
      window.removeEventListener("wheel", onInput);
    };
  }, [status, data, staticMode, finished, active, chars, entries]);

  // While a sentence types, its cited lines ignite (E-1); the classes
  // below hold the live and settled states in every mode.
  useEffect(() => {
    if (status !== "ready" || staticMode || finished) {
      return;
    }
    const entry = entries[active];
    if (entry === undefined || entry.lines.length === 0) {
      return;
    }
    const elements = entry.lines
      .map((line) => lineElement(line))
      .filter((element) => element !== null);
    if (elements.length === 0) {
      return;
    }
    void runCitedIgnite(elements).then(
      () => undefined,
      () => undefined,
    );
  }, [status, staticMode, finished, active, entries, lineElement]);

  const adopt = (state: ExplainCodeState): void => {
    if (state.status === "ready") {
      setData(state);
      setDropped(state.droppedClaims);
      setProvider(state.provider);
      setModelId(state.modelId);
      setStatus("ready");
      return;
    }
    if (state.status === "invalid-output" || state.status === "capped") {
      setData(null);
      setStatus(state.status);
      return;
    }
    if (state.status === "not-configured") {
      setData(null);
      setStatus("idle");
      return;
    }
    setData(null);
    setStatus("failed");
  };

  const run = (loader: () => Promise<ExplainCodeState>): void => {
    const id = requestId.current + 1;
    requestId.current = id;
    setRestored(false);
    setFinished(false);
    setStatus("pending");
    void loader().then(
      (state) => {
        if (requestId.current === id) {
          adopt(state);
        }
      },
      () => {
        if (requestId.current === id) {
          adopt({ status: "failed" });
        }
      },
    );
  };

  const typed: TypedEntry[] = entries.map((entry, index) => {
    if (finished || index < active) {
      return { ...entry, shown: entry.text, done: true, mounted: true };
    }
    if (index > active) {
      return { ...entry, shown: "", done: false, mounted: false };
    }
    return { ...entry, shown: entry.text.slice(0, chars), done: false, mounted: true };
  });

  const liveLines = useMemo(() => {
    if (finished || staticMode) {
      return new Set<number>();
    }
    return new Set(entries[active]?.lines ?? []);
  }, [finished, staticMode, active, entries]);

  const citedLines = useMemo(() => {
    const out = new Set<number>();
    const doneCount = finished ? entries.length : active;
    for (let index = 0; index < doneCount; index += 1) {
      for (const line of entries[index]?.lines ?? []) {
        out.add(line);
      }
    }
    return out;
  }, [finished, active, entries]);

  const readyMessage =
    status === "ready" && data !== null
      ? `Muse explanation ready: ${data.summary.length} ${plural(data.summary.length, "summary", "summaries")}, ${data.notes.length} ${plural(data.notes.length, "note", "notes")}.`
      : null;

  return {
    status,
    provider,
    modelId,
    dropped,
    entries: typed,
    liveLines,
    citedLines,
    readyMessage,
    request: () => run(() => fetchExplainCode(address, selector, view, apiKey)),
    retry: () => run(() => refreshExplainCode(address, selector, view, apiKey)),
    askAgain: () => run(() => refreshExplainCode(address, selector, view, apiKey)),
  };
}

export function ExplainCodeButton({
  label,
  consentId,
  busy,
  testId,
  onPress,
}: {
  readonly label: string;
  readonly consentId: string;
  readonly busy: boolean;
  readonly testId: string;
  readonly onPress: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="button-ghost explain-code-btn"
      aria-describedby={consentId}
      aria-busy={busy}
      data-testid={testId}
      onClick={onPress}
    >
      <span aria-hidden="true" className="explain-code-glyph">
        <Pictogram name="muse" size={20} />
      </span>
      {busy ? "Explaining…" : label}
    </button>
  );
}

// One range chip per note plus its surviving citation chips, deduped by
// label. Unknown targets render as plain text through CitationChip.
export function entryChips(
  entry: Pick<TypedEntry, "kind" | "cites" | "note" | "lines">,
  current: CitePosition,
  maps: CiteMaps,
  handlers: {
    readonly onLine: (line: number) => void;
    readonly onFunction: (selector: string, view: ExplainCodeView, line: number) => void;
    readonly onEvidence: (id: string) => void;
  },
): ReactNode {
  const seen = new Set<string>();
  const chips: ReactNode[] = [];
  const push = (cite: ExplainCodeCite, labelOverride?: string): void => {
    const label = labelOverride ?? resolveCite(cite, current, maps).label;
    if (seen.has(label)) {
      return;
    }
    seen.add(label);
    chips.push(
      <CitationChip
        key={`${cite.kind}-${label}`}
        cite={cite}
        current={current}
        maps={maps}
        labelOverride={labelOverride}
        onLine={handlers.onLine}
        onFunction={handlers.onFunction}
        onEvidence={handlers.onEvidence}
      />,
    );
  };
  if (entry.kind === "note" && entry.note !== null) {
    const from = entry.note.from;
    push({ kind: "line", selector: current.selector, view: current.view, line: from }, entry.note.from === entry.note.to ? `L${from}` : `L${entry.note.from}–${entry.note.to}`);
  }
  for (const cite of entry.cites) {
    push(cite);
  }
  if (chips.length === 0) {
    return null;
  }
  return <>{chips}</>;
}

// The summary card, status lines, footer and live region for one pane.
// Notes themselves are placed by CodeView (interleaved or margin).
export function ExplainViewResults({
  runtime,
  title,
  lineCount,
  chipsFor,
}: {
  readonly runtime: ExplainRuntime;
  // Function display name for the pending line.
  readonly title: string;
  readonly lineCount: number;
  readonly chipsFor: (entry: TypedEntry) => ReactNode;
}): JSX.Element | null {
  const { status } = runtime;
  if (status === "idle") {
    return null;
  }
  if (status === "pending") {
    return (
      <p role="status" className="scan-status explain-pending">
        <span aria-hidden="true">✦ </span>Muse is reading {title} · {lineCount} {plural(lineCount, "line", "lines")}
        <b className="cursor" aria-hidden="true" />
        <span className="sr-only">Muse is reading this function.</span>
      </p>
    );
  }
  if (status === "invalid-output") {
    return (
      <div className="muse-explain-status" role="alert">
        <p className="muse-explain-message">Muse&apos;s answer cited code that isn&apos;t there, so we hid it. The code and evidence are unchanged.</p>
        <button type="button" className="button-ghost" onClick={runtime.retry}>
          Try again
        </button>
        <p className="quiet muse-advisory">AI explanation · does not change the score</p>
      </div>
    );
  }
  if (status === "capped") {
    return (
      <div className="muse-explain-status" role="status">
        <p className="muse-explain-message">Daily Muse limit reached. Try again tomorrow.</p>
        <p className="quiet muse-advisory">AI explanation · does not change the score</p>
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div className="muse-explain-status" role="alert">
        <p className="muse-explain-message">Muse didn&apos;t answer. The code and evidence are unchanged.</p>
        <button type="button" className="button-ghost" onClick={runtime.retry}>
          Try again
        </button>
        <p className="quiet muse-advisory">AI explanation · does not change the score</p>
      </div>
    );
  }
  const summaryEntries = runtime.entries.filter((entry) => entry.kind === "summary");
  return (
    <div className="muse-explain-ready">
      {runtime.readyMessage !== null ? (
        <p role="status" className="sr-only">
          {runtime.readyMessage}
        </p>
      ) : null}
      <section className="muse-summary" aria-label="What this function does">
        <h3 className="muse-summary-title">
          <span aria-hidden="true">✦ </span>What this function does
        </h3>
        {runtime.modelId !== null ? <p className="quiet muse-model">Muse · {runtime.modelId}</p> : null}
        {summaryEntries.length === 0 ? (
          <p className="muse-summary-empty">Every model sentence failed the evidence check.</p>
        ) : (
          <ul className="muse-summary-list">
            {summaryEntries.map((entry) => (
              <li key={entry.key}>
                <span aria-hidden="true">
                  {entry.shown}
                  {entry.done ? null : <b className="cursor" aria-hidden="true" />}
                </span>
                <span className="sr-only">{entry.text}</span> {chipsFor(entry)}
              </li>
            ))}
          </ul>
        )}
        {runtime.dropped > 0 ? (
          <p className="quiet muse-dropped">
            {`${runtime.dropped} ${plural(runtime.dropped, "note", "notes")} removed: ${runtime.dropped === 1 ? "it cited" : "they cited"} lines that don't exist.`}
          </p>
        ) : null}
      </section>
      <div className="muse-explain-foot">
        <button type="button" className="button-ghost muse-ask-again" onClick={runtime.askAgain}>
          Ask again
        </button>
        <p className="quiet muse-advisory">AI explanation · does not change the score</p>
      </div>
    </div>
  );
}

// A mounted note body with its typed text and chips, for interleaved
// or margin placement.
export function ExplainNoteBody({
  noteId,
  entry,
  chips,
}: {
  readonly noteId: string;
  readonly entry: TypedEntry;
  readonly chips: ReactNode;
}): JSX.Element {
  return <MuseNote id={noteId} note={entry.note as ExplainCodeNote} shownText={entry.shown} done={entry.done} chips={chips} />;
}
