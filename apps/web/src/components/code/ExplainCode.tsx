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
// Reduced motion renders everything at rest with no animation and no
// cursor. Scores, evidence and finding text are never
// touched: this is a labelled advisory overlay with the standing
// footer "AI explanation · does not change the score".
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX, type ReactNode } from "react";
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
import { InterleavedNote, MuseNote } from "./MuseNotes.tsx";

const TICK_MS = 16;
const TICKS_PER_SENTENCE = 37;
const TOTAL_BUDGET_MS = 4000;

// C-29: characters per tick for one sentence, extracted pure so the
// pacing is unit-testable without timers.
export function typingChunk(textLength: number): number {
  return Math.max(1, Math.ceil(textLength / TICKS_PER_SENTENCE));
}

export type ExplainStatus = "idle" | "pending" | "ready" | "invalid-output" | "capped" | "failed";

// C-29: typing progress lives in an external store, not in React
// state. The 16 ms ticks write the store and notify subscribers;
// CodeView subscribes to the sentence-level snapshot (whose
// reference is stable across ticks), while the small overlay leaves
// subscribe to the full snapshot.
export type TypingSnapshot = {
  readonly active: number;
  readonly chars: number;
  readonly finished: boolean;
};

export type SentenceSnapshot = {
  readonly active: number;
  readonly finished: boolean;
};

export type TypingStore = {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => TypingSnapshot;
  readonly getSentence: () => SentenceSnapshot;
  readonly set: (next: TypingSnapshot) => void;
};

export function createTypingStore(): TypingStore {
  const listeners = new Set<() => void>();
  let snapshot: TypingSnapshot = { active: 0, chars: 0, finished: false };
  let sentence: SentenceSnapshot = { active: 0, finished: false };
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    getSentence: () => sentence,
    set: (next) => {
      if (next.active === snapshot.active && next.chars === snapshot.chars && next.finished === snapshot.finished) {
        return;
      }
      snapshot = next;
      if (next.active !== sentence.active || next.finished !== sentence.finished) {
        sentence = { active: next.active, finished: next.finished };
      }
      listeners.forEach((listener) => listener());
    },
  };
}

// Full tick-level snapshot, for the small overlay leaves that render
// the typewriter slice. The snapshot getter doubles as the server
// snapshot so the unit tests can renderToString the leaves.
export function useTypingSnapshot(typing: TypingStore): TypingSnapshot {
  return useSyncExternalStore(typing.subscribe, typing.getSnapshot, typing.getSnapshot);
}

// Sentence-level snapshot, for CodeView: settled entries show in
// full, later entries stay unmounted, the active one types.
export function useSentenceProgress(typing: TypingStore): SentenceSnapshot {
  return useSyncExternalStore(typing.subscribe, typing.getSentence, typing.getSentence);
}

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

// One overlay sentence or note without typing progress: the stable
// part of an entry. Leaves resolve the shown slice from the store.
export type StaticEntry = {
  readonly key: string;
  readonly kind: "summary" | "note";
  readonly text: string;
  readonly note: ExplainCodeNote | null;
  readonly cites: readonly ExplainCodeCite[];
  // Cited lines in this pane (same selector and view, present below).
  readonly lines: readonly number[];
};

// Sentence-level flags for one entry index: settled entries show in
// full, later entries stay unmounted, the active one types.
export function entryDone(sentence: SentenceSnapshot, index: number): boolean {
  return sentence.finished || index < sentence.active;
}

export function entryMounted(sentence: SentenceSnapshot, index: number): boolean {
  return entryDone(sentence, index) || index === sentence.active;
}

export function entryShown(text: string, typing: TypingSnapshot, index: number): string {
  if (typing.finished || index < typing.active) {
    return text;
  }
  if (index > typing.active) {
    return "";
  }
  return text.slice(0, typing.chars);
}

export type ExplainRuntime = {
  readonly status: ExplainStatus;
  readonly provider: string | null;
  readonly modelId: string | null;
  readonly dropped: number;
  readonly staticEntries: readonly StaticEntry[];
  readonly sentence: SentenceSnapshot;
  readonly typing: TypingStore;
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
  block,
  codeHash,
}: {
  readonly address: string;
  readonly apiKey: string | null;
  readonly selector: string;
  readonly view: ExplainCodeView;
  readonly available: boolean;
  readonly paneLines: ReadonlySet<number>;
  readonly lineElement: (line: number) => HTMLLIElement | null;
  readonly block?: number | undefined;
  readonly codeHash?: string | undefined;
}): ExplainRuntime {
  const [status, setStatus] = useState<ExplainStatus>("idle");
  const [data, setData] = useState<Extract<ExplainCodeState, { status: "ready" }> | null>(null);
  const [dropped, setDropped] = useState(0);
  const [provider, setProvider] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  // C-29: tick progress lives in the store, not in React state, so
  // the 16 ms ticks never re-render the host. The host subscribes
  // to the sentence snapshot only (stable across ticks).
  const storeRef = useRef<TypingStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createTypingStore();
  }
  const typing = storeRef.current;
  const sentence = useSentenceProgress(typing);
  const startedAt = useRef(0);
  const requestId = useRef(0);

  const staticMode = reducedMotionRequested() || motionAllowed() === false;

  // Re-opening restores the stored overlay instantly: no new request,
  // no typing replay, full text at rest with cited lines marked.
  useEffect(() => {
    if (!available || status !== "idle") {
      return;
    }
    const settled = peekExplainCode(address, selector, view, block, codeHash);
    if (settled !== null && (settled.status === "ready" || settled.status === "invalid-output" || settled.status === "capped")) {
      if (settled.status === "ready") {
        setData(settled);
        setDropped(settled.droppedClaims);
        setProvider(settled.provider);
        setModelId(settled.modelId);
      }
      setStatus(settled.status);
      setRestored(true);
      typing.set({ ...typing.getSnapshot(), chars: 0, finished: true });
    }
  }, [address, selector, view, available, status, typing, block, codeHash]);

  const staticEntries = useMemo(() => {
    if (data === null) {
      return [];
    }
    const built: StaticEntry[] = [];
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
  // everything at once. Store writes notify the sentence subscribers
  // (the host) and the tick subscribers (the leaves).
  useEffect(() => {
    if (data === null) {
      return;
    }
    if (restored || staticMode) {
      typing.set({ active: staticEntries.length, chars: 0, finished: true });
      return;
    }
    startedAt.current = 0;
    typing.set({ active: 0, chars: 0, finished: false });
  }, [data, restored, staticMode, staticEntries.length, typing]);

  // E-1 read-along: sentences type one at a time while their cited
  // lines ignite; the 4 s total cap reveals the rest at once. Any key,
  // pointer or wheel input finishes the typing and every running
  // animation instantly: the visitor is never made to wait.
  // C-29: one interval per sentence sequence. Ticks write the store
  // instead of React state, so the host never re-renders per tick;
  // the interval clears itself once the store reports finished.
  useEffect(() => {
    if (status !== "ready" || data === null || staticMode) {
      return;
    }
    if (typing.getSnapshot().finished || typing.getSnapshot().active >= staticEntries.length) {
      typing.set({ active: staticEntries.length, chars: 0, finished: true });
      return;
    }
    if (startedAt.current === 0) {
      startedAt.current = Date.now();
    }
    const finish = (): void => {
      finishAll();
      typing.set({ active: staticEntries.length, chars: 0, finished: true });
    };
    const onInput = (): void => {
      finish();
    };
    const timer = window.setInterval(() => {
      const progress = typing.getSnapshot();
      if (progress.finished) {
        window.clearInterval(timer);
        return;
      }
      if (Date.now() - startedAt.current > TOTAL_BUDGET_MS) {
        finish();
        return;
      }
      const entry = staticEntries[progress.active];
      if (entry === undefined) {
        finish();
        return;
      }
      const next = progress.chars + typingChunk(entry.text.length);
      if (next >= entry.text.length) {
        const following = progress.active + 1;
        typing.set({
          active: following,
          chars: 0,
          finished: following >= staticEntries.length,
        });
        return;
      }
      typing.set({ active: progress.active, chars: next, finished: false });
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
  }, [status, data, staticMode, staticEntries, typing]);

  // While a sentence types, its cited lines ignite (E-1); the classes
  // below hold the live and settled states in every mode.
  useEffect(() => {
    if (status !== "ready" || staticMode || sentence.finished) {
      return;
    }
    const entry = staticEntries[sentence.active];
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
  }, [status, staticMode, sentence, staticEntries, lineElement]);

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
    typing.set({ ...typing.getSnapshot(), finished: false });
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

  // C-29: sentence-level aggregates only. The per-tick slice is
  // resolved by the subscribing leaves, so these references stay
  // stable across the 16 ms ticks.
  const liveLines = useMemo(() => {
    if (sentence.finished || staticMode) {
      return new Set<number>();
    }
    return new Set(staticEntries[sentence.active]?.lines ?? []);
  }, [sentence, staticMode, staticEntries]);

  const citedLines = useMemo(() => {
    const out = new Set<number>();
    const doneCount = sentence.finished ? staticEntries.length : sentence.active;
    for (let index = 0; index < doneCount; index += 1) {
      for (const line of staticEntries[index]?.lines ?? []) {
        out.add(line);
      }
    }
    return out;
  }, [sentence, staticEntries]);

  const readyMessage =
    status === "ready" && data !== null
      ? `Muse explanation ready: ${data.summary.length} ${plural(data.summary.length, "summary", "summaries")}, ${data.notes.length} ${plural(data.notes.length, "note", "notes")}.`
      : null;

  return {
    status,
    provider,
    modelId,
    dropped,
    staticEntries,
    sentence,
    typing,
    liveLines,
    citedLines,
    readyMessage,
    request: () => run(() => fetchExplainCode(address, selector, view, apiKey, block, codeHash)),
    retry: () => run(() => refreshExplainCode(address, selector, view, apiKey, block, codeHash)),
    askAgain: () => run(() => refreshExplainCode(address, selector, view, apiKey, block, codeHash)),
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
  entry: Pick<StaticEntry, "kind" | "cites" | "note" | "lines">,
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
// C-29 leaf: this component subscribes to the tick snapshot itself,
// so the typewriter re-renders this small card only, never CodeView.
export function ExplainViewResults({
  store,
  status,
  modelId,
  dropped,
  staticEntries,
  readyMessage,
  title,
  lineCount,
  chipsFor,
  onRetry,
  onAskAgain,
}: {
  readonly store: TypingStore;
  readonly status: ExplainStatus;
  readonly modelId: string | null;
  readonly dropped: number;
  readonly staticEntries: readonly StaticEntry[];
  readonly readyMessage: string | null;
  // Function display name for the pending line.
  readonly title: string;
  readonly lineCount: number;
  readonly chipsFor: (entry: StaticEntry) => ReactNode;
  readonly onRetry: () => void;
  readonly onAskAgain: () => void;
}): JSX.Element | null {
  const typing = useTypingSnapshot(store);
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
        <button type="button" className="button-ghost" onClick={onRetry}>
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
        <button type="button" className="button-ghost" onClick={onRetry}>
          Try again
        </button>
        <p className="quiet muse-advisory">AI explanation · does not change the score</p>
      </div>
    );
  }
  const summaryEntries = staticEntries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.kind === "summary");
  return (
    <div className="muse-explain-ready">
      {readyMessage !== null ? (
        <p role="status" className="sr-only">
          {readyMessage}
        </p>
      ) : null}
      <section className="muse-summary" aria-label="What this function does">
        <h3 className="muse-summary-title">
          <span aria-hidden="true">✦ </span>What this function does
        </h3>
        {modelId !== null ? <p className="quiet muse-model">Muse · {modelId}</p> : null}
        {summaryEntries.length === 0 ? (
          <p className="muse-summary-empty">Every model sentence failed the evidence check.</p>
        ) : (
          <ul className="muse-summary-list">
            {summaryEntries.map(({ entry, index }) => {
              const done = entryDone(typing, index);
              return (
                <li key={entry.key}>
                  <span aria-hidden="true">
                    {entryShown(entry.text, typing, index)}
                    {done ? null : <b className="cursor" aria-hidden="true" />}
                  </span>
                  <span className="sr-only">{entry.text}</span> {chipsFor(entry)}
                </li>
              );
            })}
          </ul>
        )}
        {dropped > 0 ? (
          <details className="muse-details">
            <summary>Details</summary>
            <p className="quiet muse-dropped">
              {`${dropped} ${plural(dropped, "note", "notes")} removed: ${dropped === 1 ? "it cited" : "they cited"} lines that don't exist.`}
            </p>
          </details>
        ) : null}
      </section>
      <div className="muse-explain-foot">
        <button type="button" className="button-ghost muse-ask-again" onClick={onAskAgain}>
          Ask again
        </button>
        <p className="quiet muse-advisory">AI explanation · does not change the score</p>
      </div>
    </div>
  );
}

// A mounted note body with its typed text and chips, for interleaved
// or margin placement. C-29 leaf: the shown slice comes from the
// tick subscription, so typing re-renders this note only.
export function ExplainNoteBody({
  noteId,
  entry,
  index,
  store,
  chips,
}: {
  readonly noteId: string;
  readonly entry: StaticEntry;
  readonly index: number;
  readonly store: TypingStore;
  readonly chips: ReactNode;
}): JSX.Element {
  const typing = useTypingSnapshot(store);
  return (
    <MuseNote
      id={noteId}
      note={entry.note as ExplainCodeNote}
      shownText={entryShown(entry.text, typing, index)}
      done={entryDone(typing, index)}
      chips={chips}
    />
  );
}

// An interleaved note after its range's line (<1600 px). C-29 leaf:
// same tick subscription as the margin body, so CodeView stays at
// sentence granularity while the text types.
export function TypedInterleavedNote({
  noteId,
  note,
  entry,
  index,
  store,
  chips,
}: {
  readonly noteId: string;
  readonly note: ExplainCodeNote;
  readonly entry: StaticEntry;
  readonly index: number;
  readonly store: TypingStore;
  readonly chips: ReactNode;
}): JSX.Element {
  const typing = useTypingSnapshot(store);
  return (
    <InterleavedNote
      noteId={noteId}
      note={note}
      shownText={entryShown(entry.text, typing, index)}
      done={entryDone(typing, index)}
      chips={chips}
      intro={true}
    />
  );
}
