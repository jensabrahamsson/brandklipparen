// Code view per function (addendum §A1): Decompiled and Verified
// source panes with tabs below 1100 px and side by side above,
// provenance badges, linking, highlighting and empty states.
// VS-2 ("Explain this code") mounts here: the header buttons explain
// the active pane, the summary card sits above the code, and notes
// anchor to their lines (interleaved below 1600 px, margin notes at
// 1600 px and above). Scores, evidence and finding text are untouched.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from "react";
import { CopyButton } from "../CopyButton.tsx";
import { CodeLines, type CodeLineDatum, type GutterLamp } from "./CodeLines.tsx";
import { ProvenanceBadge, type ProvenanceKind } from "./ProvenanceBadge.tsx";
import { SourceEmpty } from "./SourceEmpty.tsx";
import { fetchSnippet, type ExplainCodeNote, type SnippetResult } from "../../lib/api.ts";
import { clearSourceCache, fetchSource, findSourceFile, findSourceFunction, sourceFunctionLines, type SourceResult } from "../../lib/source.ts";
import { motionAllowed, pulseKeyframes, runSequence } from "../../lib/explainMotion.ts";
import { useMediaQuery } from "../../lib/useMediaQuery.ts";
import { toChecksumAddress } from "../../lib/checksumAddress.ts";
import { useReducedMotion } from "../../lib/motion.ts";
import type { CodePaneView } from "../../lib/route.ts";
import {
  ExplainCodeButton,
  ExplainNoteBody,
  ExplainViewResults,
  TypedInterleavedNote,
  entryChips,
  entryMounted,
  useExplainCodeView,
  type ExplainRuntime,
  type StaticEntry,
} from "./ExplainCode.tsx";
import { MarginNotes, noteRangeLabel } from "./MuseNotes.tsx";
import type { CiteMaps } from "./CitationChip.tsx";

// One known evidence id: a sentence-case label plus the code locations
// that prove it (selector + decompiled offset).
export type ExplainEvidenceEntry = {
  readonly label: string;
  readonly targets: readonly { readonly selector: string; readonly offset: number | null }[];
};

// VS-2 context for one function: who may be explained, how citation
// targets resolve, and where cross-function chips navigate.
export type ExplainContext = {
  // False when /health reports the code-explain feature unavailable:
  // no button, no consent line, no dead control.
  readonly available: boolean;
  // Lower-cased selector to short display name, every function of this
  // contract (for cross-function chips).
  readonly functions: ReadonlyMap<string, string>;
  // Known evidence ids (every plugin finding of this analysis): a
  // sentence-case label plus the code locations that prove it.
  readonly evidence: ReadonlyMap<string, ExplainEvidenceEntry>;
  readonly onFunctionCite: (selector: string, view: CodePaneView, line: number) => void;
};

export type CodeFocusRequest = {
  readonly view: CodePaneView;
  readonly line: number;
  readonly nonce: number;
};

const SNIPPET_LIMIT = 30;
const CONTEXT_LINES = 10;
const WHOLE_FILE_LINE_CAP = 1500;
const VIEW_STORAGE_KEY = "brandklipparen-code-view";

type SnippetState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly result: SnippetResult }
  | { readonly kind: "failed" };

type LoadedSource =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly result: SourceResult }
  | { readonly kind: "failed" };

function rememberedView(): CodePaneView | null {
  try {
    const stored = window.sessionStorage.getItem(VIEW_STORAGE_KEY);
    return stored === "decompiled" || stored === "source" ? stored : null;
  } catch {
    return null;
  }
}

function pcHex(pc: number | null): string {
  return pc === null ? "unknown" : `0x${pc.toString(16)}`;
}

function lineForPc(lines: readonly CodeLineDatum[], pc: number): CodeLineDatum | null {
  return lines.find((line) => line.pcs.includes(pc)) ?? null;
}

// First function name in `function NAME(` form, for the E-6 rename
// comparison against the verified name.
function decompiledFunctionName(lines: readonly CodeLineDatum[]): string | null {
  for (const line of lines) {
    const match = /function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line.text);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return null;
}

// Copy writes the full function text with no notes: full hex, every
// line, joined with newlines. Display shortening never leaks in.
export function codeCopyText(lines: readonly { readonly text: string }[]): string {
  return lines.map((line) => line.text).join("\n");
}

export function CodeView({
  address,
  apiKey,
  selector,
  title,
  nameFrom,
  entryPc,
  startPc,
  endPc,
  unresolvedJumps,
  block,
  initialView,
  initialPc,
  expert,
  evidenceLabel,
  explainAction,
  explain,
  focusRequest,
  onFocusConsumed,
  onCopyWholeContract,
}: {
  readonly address: string;
  readonly apiKey: string;
  readonly selector: string;
  // Decompiled display name, e.g. "addBlackList(address)".
  readonly title: string;
  // Where the header name came from.
  readonly nameFrom: "verified" | "table" | "unnamed";
  readonly entryPc: number | null;
  readonly startPc: number | null;
  readonly endPc: number | null;
  readonly unresolvedJumps: number;
  readonly block?: number | null | undefined;
  readonly initialView?: CodePaneView | undefined;
  readonly initialPc?: number | undefined;
  readonly expert: boolean;
  // Label for the entry-evidence gutter lamp, e.g. "Evidence at 0xc8:
  // back to the evidence row". Null when the entry offset is unknown.
  readonly evidenceLabel: string | null;
  // VS-2 slot: the "Explain this code" action mounts here. The consent
  // line below the header renders only when this is present.
  readonly explainAction?: ReactNode | undefined;
  // VS-2 explanation context: header buttons, summary and line-anchored
  // notes. Absent when the feature is unavailable: no button, no panel.
  readonly explain?: ExplainContext | undefined;
  // Cross-function chip focus (VS-2): switch to the cited pane and
  // focus its line with one E-2 pulse.
  readonly focusRequest?: CodeFocusRequest | null | undefined;
  readonly onFocusConsumed?: (() => void) | undefined;
  readonly onCopyWholeContract?: (() => Promise<string>) | undefined;
}): JSX.Element {
  const wide = useMediaQuery("(min-width: 1100px)");
  const reduce = useReducedMotion();
  const [snippet, setSnippet] = useState<SnippetState>({ kind: "idle" });
  const [source, setSource] = useState<LoadedSource>({ kind: "idle" });
  const [sourceNonce, setSourceNonce] = useState(0);
  const [view, setView] = useState<CodePaneView>(() => {
    if (initialView !== undefined) {
      return initialView;
    }
    if (typeof window !== "undefined") {
      const stored = rememberedView();
      if (stored !== null) {
        return stored;
      }
    }
    return initialPc === undefined ? "source" : "decompiled";
  });
  const [targetPc, setTargetPc] = useState<number | null>(initialPc ?? null);
  const [expandedLines, setExpandedLines] = useState(false);
  const [aboveCount, setAboveCount] = useState(0);
  const [belowCount, setBelowCount] = useState(0);
  const [wholeFile, setWholeFile] = useState(false);
  const [activeDecompiled, setActiveDecompiled] = useState<number | null>(null);
  const [activeSource, setActiveSource] = useState<number | null>(null);
  const [wholeCopy, setWholeCopy] = useState<string | null>(null);
  const lineEls = useRef(new Map<number, HTMLLIElement>());
  const sourceLineEls = useRef(new Map<number, HTMLLIElement>());
  const tabDecompiled = useRef<HTMLButtonElement | null>(null);
  const tabSource = useRef<HTMLButtonElement | null>(null);
  const baseId = useId();
  const loading = useRef(false);
  const sourceLoading = useRef(false);
  const mountedTarget = useRef(initialPc ?? null);
  const margin = useMediaQuery("(min-width: 1600px)");
  // C-29: hover only feeds the cross-pane match highlight. It is
  // throttled by requestAnimationFrame and kept in stable callbacks
  // so memoised line rows are not invalidated; the hovered row
  // itself highlights through CSS :hover.
  const hoverFrame = useRef(0);
  useEffect(() => () => {
    if (hoverFrame.current !== 0) {
      window.cancelAnimationFrame(hoverFrame.current);
    }
  }, []);
  const hoverLater = useCallback((apply: () => void): void => {
    if (hoverFrame.current !== 0) {
      window.cancelAnimationFrame(hoverFrame.current);
    }
    hoverFrame.current = window.requestAnimationFrame(() => {
      hoverFrame.current = 0;
      apply();
    });
  }, []);
  const handleDecLineRef = useCallback((lineNumber: number, element: HTMLLIElement | null): void => {
    if (element === null) {
      lineEls.current.delete(lineNumber);
    } else {
      lineEls.current.set(lineNumber, element);
    }
  }, []);
  const handleSrcLineRef = useCallback((lineNumber: number, element: HTMLLIElement | null): void => {
    if (element === null) {
      sourceLineEls.current.delete(lineNumber);
    } else {
      sourceLineEls.current.set(lineNumber, element);
    }
  }, []);
  const handleDecFocus = useCallback((lineNumber: number | null): void => {
    setActiveDecompiled(lineNumber);
  }, []);
  const handleSrcFocus = useCallback((lineNumber: number | null): void => {
    setActiveSource(lineNumber);
  }, []);
  const handleDecHover = useCallback(
    (lineNumber: number | null): void => {
      hoverLater(() => setActiveDecompiled(lineNumber));
    },
    [hoverLater],
  );
  const handleSrcHover = useCallback(
    (lineNumber: number | null): void => {
      hoverLater(() => setActiveSource(lineNumber));
    },
    [hoverLater],
  );
  // C-29: stable element lookups for the explain ignite effect, so it
  // fires once per sentence instead of on every host render.
  const handleDecLineElement = useCallback((line: number): HTMLLIElement | null => {
    return lineEls.current.get(line) ?? null;
  }, []);
  const handleSrcLineElement = useCallback((line: number): HTMLLIElement | null => {
    return sourceLineEls.current.get(line) ?? null;
  }, []);
  // VS-2 read-along state: the Notes switch (header, after a result
  // exists) and the chip-to-line target (E-2 pulse style).
  const [notesOn, setNotesOn] = useState(true);
  const [citeTarget, setCiteTarget] = useState<{ readonly pane: CodePaneView; readonly line: number } | null>(null);
  const [pendingFocus, setPendingFocus] = useState<CodeFocusRequest | null>(null);
  const explainAvailable = explain?.available === true;

  useEffect(() => {
    if (snippet.kind !== "idle" || loading.current) {
      return;
    }
    loading.current = true;
    setSnippet({ kind: "loading" });
    fetchSnippet(address, selector, apiKey.length === 0 ? null : apiKey).then(
      (result) => {
        loading.current = false;
        setSnippet({ kind: "ready", result });
      },
      () => {
        loading.current = false;
        setSnippet({ kind: "failed" });
      },
    );
  }, [snippet, address, selector, apiKey]);

  useEffect(() => {
    if (source.kind !== "idle" || sourceLoading.current) {
      return;
    }
    sourceLoading.current = true;
    setSource({ kind: "loading" });
    fetchSource(address, apiKey.length === 0 ? null : apiKey).then(
      (result) => {
        sourceLoading.current = false;
        setSource({ kind: "ready", result });
      },
      () => {
        sourceLoading.current = false;
        setSource({ kind: "failed" });
      },
    );
  }, [source, sourceNonce, address, apiKey]);

  const lines: readonly CodeLineDatum[] = snippet.kind === "ready" ? snippet.result.lines : [];
  const hasPcs = lines.some((line) => line.pcs.length > 0);
  const targetLine = targetPc === null ? null : lineForPc(lines, targetPc);

  const sourceResult: SourceResult | null = source.kind === "ready" ? source.result : null;
  const sourceFn = sourceResult === null ? null : findSourceFunction(sourceResult, selector);
  const provider = sourceResult?.provider ?? "Sourcify and Etherscan";

  // "unavailable" (could not check) arrives two ways: a failed fetch
  // or an HTTP-200 body whose status is "unavailable". Both render the
  // retry state, never the "none" empty state and never code.
  const sourceUnavailable = source.kind === "failed" || sourceResult?.status === "unavailable";
  const verifiedKind: ProvenanceKind | null =
    sourceUnavailable
      ? "unavailable"
      : sourceResult !== null && sourceResult.status === "verified"
        ? provider.toLowerCase().includes("etherscan")
          ? "explorer"
          : sourceResult.match === "partial"
            ? "verified-partial"
            : "verified-full"
        : source.kind === "ready"
          ? "none"
          : null;

  const mismatch = sourceResult !== null && sourceResult.status === "verified" && sourceFn === null;
  const sourceFile = sourceResult === null ? null : sourceFn === null ? null : findSourceFile(sourceResult, sourceFn.file);
  // C-29: memoise the splits so `shownSource` (and through it
  // `sourceLineSet` and the explain entries) keeps a stable identity
  // across unrelated renders such as typing ticks.
  const functionBody = useMemo(
    () => (sourceFile === null || sourceFn === null ? [] : sourceFunctionLines(sourceFile, sourceFn)),
    [sourceFile, sourceFn],
  );
  const wholeFileLines = useMemo(() => (sourceFile === null ? [] : sourceFile.content.split("\n")), [sourceFile]);
  const canWholeFile = wholeFileLines.length > 0 && wholeFileLines.length <= WHOLE_FILE_LINE_CAP;

  const sourceFirstLine = sourceFn === null ? 1 : sourceFn.startLine - aboveCount;
  const sourceLastLine = sourceFn === null ? 0 : sourceFn.endLine + belowCount;
  const startLine = sourceFn?.startLine ?? 1;
  const shownSource: CodeLineDatum[] = useMemo(
    () =>
      wholeFile
        ? wholeFileLines.map((text, index) => ({ lineNumber: index + 1, text, pcs: [] as readonly number[] }))
        : functionBody.map((text, index) => ({
            lineNumber: startLine + index,
            text,
            pcs: [] as readonly number[],
          })),
    [wholeFile, wholeFileLines, functionBody, startLine],
  );

  // E-5 line correspondence through the source map: each decompiled
  // line knows its source lines via its pcs, and back.
  const pcToLine = sourceResult?.pcToLine ?? {};
  const decompiledToSource = useMemo(() => {
    const map = new Map<number, number[]>();
    if (sourceFn === null) {
      return map;
    }
    for (const line of lines) {
      const targets = new Set<number>();
      for (const pc of line.pcs) {
        const entry = pcToLine[String(pc)];
        if (entry !== undefined && entry.file === sourceFn.file) {
          targets.add(entry.line);
        }
      }
      if (targets.size > 0) {
        map.set(line.lineNumber, [...targets].sort((a, b) => a - b));
      }
    }
    return map;
  }, [lines, pcToLine, sourceFn]);
  const sourceToDecompiled = useMemo(() => {
    const map = new Map<number, number[]>();
    for (const [from, targets] of decompiledToSource) {
      for (const target of targets) {
        const list = map.get(target) ?? [];
        list.push(from);
        map.set(target, list);
      }
    }
    return map;
  }, [decompiledToSource]);
  const hasSourceMap = decompiledToSource.size > 0;

  const highlightSource: ReadonlySet<number> = useMemo(() => {
    if (activeDecompiled === null) {
      return new Set();
    }
    return new Set(decompiledToSource.get(activeDecompiled) ?? []);
  }, [activeDecompiled, decompiledToSource]);
  const highlightDecompiled: ReadonlySet<number> = useMemo(() => {
    if (activeSource === null) {
      return new Set();
    }
    return new Set(sourceToDecompiled.get(activeSource) ?? []);
  }, [activeSource, sourceToDecompiled]);

  // E-6: the verified name replaces the decompiled one. Renamed
  // identifiers cross-fade; the chip and legend name the origin.
  const verifiedName = sourceFn?.name ?? sourceFn?.signature?.replace(/\(.*$/, "") ?? null;
  const decompiledName = useMemo(() => decompiledFunctionName(lines), [lines]);
  const renamedFrom = verifiedName !== null && decompiledName !== null && verifiedName !== decompiledName ? decompiledName : null;

  const sourcePaneReady = verifiedKind === "verified-full" || verifiedKind === "verified-partial" || verifiedKind === "explorer";
  const sourceHasCode = sourcePaneReady && !mismatch;

  // VS-2 read-along runtimes, one per pane: each pane explains its own
  // view, and the session cache makes re-opens instant with no request.
  const apiKeyOrNull = apiKey.length === 0 ? null : apiKey;
  const decompiledLineSet = useMemo(() => new Set(lines.map((line) => line.lineNumber)), [lines]);
  const sourceLineSet = useMemo(
    () => new Set(shownSource.map((line) => line.lineNumber)),
    [shownSource],
  );
  const decRuntime = useExplainCodeView({
    address,
    apiKey: apiKeyOrNull,
    selector,
    view: "decompiled",
    available: explainAvailable,
    paneLines: decompiledLineSet,
    lineElement: handleDecLineElement,
  });
  const srcRuntime = useExplainCodeView({
    address,
    apiKey: apiKeyOrNull,
    selector,
    view: "source",
    available: explainAvailable,
    paneLines: sourceLineSet,
    lineElement: handleSrcLineElement,
  });
  const runtimeFor = (pane: CodePaneView): ExplainRuntime => (pane === "decompiled" ? decRuntime : srcRuntime);
  const anyReady = decRuntime.status === "ready" || srcRuntime.status === "ready";
  // The button explains the visible code pane: when the active view
  // has no code (unverified, unavailable or mismatch), it explains
  // the decompiled pane instead of firing a doomed request.
  const explainsView: CodePaneView =
    view === "source" && !sourceHasCode ? "decompiled" : view;

  // Chip to line (E-2): focus the cited line in its pane, set the
  // target style and play exactly one pulse.
  const focusExplainedLine = (pane: CodePaneView, line: number): void => {
    setCiteTarget({ pane, line });
    const elements = pane === "decompiled" ? lineEls : sourceLineEls;
    const element = elements.current.get(line);
    if (element === null || element === undefined) {
      return;
    }
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "center" });
    if (motionAllowed() && !reduce) {
      void runSequence([{ element, keyframes: pulseKeyframes(), options: { duration: 760 } }]);
    }
  };

  const focusNoteById = (id: string): void => {
    const element = document.getElementById(id);
    if (element === null) {
      return;
    }
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "center" });
  };

  const focusEntryEvidence = (): void => {
    const element = document.getElementById(`${baseId}-entry`);
    if (element !== null) {
      element.focus({ preventScroll: true });
      element.scrollIntoView({ block: "center" });
      return;
    }
    if (view !== "decompiled") {
      chooseView("decompiled");
      window.setTimeout(() => {
        const retry = document.getElementById(`${baseId}-entry`);
        retry?.focus({ preventScroll: true });
        retry?.scrollIntoView({ block: "center" });
      }, 50);
    }
  };

  // Cross-function chip focus: take over the row's request, switch to
  // the cited pane, then focus its line once the code is in.
  useEffect(() => {
    if (focusRequest === null || focusRequest === undefined) {
      return;
    }
    setPendingFocus((previous) => (previous?.nonce === focusRequest.nonce ? previous : focusRequest));
    onFocusConsumed?.();
  }, [focusRequest, onFocusConsumed]);

  useEffect(() => {
    if (pendingFocus === null) {
      return;
    }
    if (view !== pendingFocus.view) {
      chooseView(pendingFocus.view);
      return;
    }
    const elements = pendingFocus.view === "decompiled" ? lineEls : sourceLineEls;
    const paneLines = pendingFocus.view === "decompiled" ? lines : shownSource;
    if (paneLines.length === 0) {
      return;
    }
    const element = elements.current.get(pendingFocus.line);
    if (element === null || element === undefined) {
      setPendingFocus(null);
      return;
    }
    setCiteTarget({ pane: pendingFocus.view, line: pendingFocus.line });
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "center" });
    if (motionAllowed() && !reduce) {
      void runSequence([{ element, keyframes: pulseKeyframes(), options: { duration: 760 } }]);
    }
    setPendingFocus(null);
  }, [pendingFocus, view, lines, shownSource, reduce]);

  const evidenceLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const [id, entry] of explain?.evidence ?? []) {
      labels.set(id, entry.label);
    }
    return labels;
  }, [explain]);

  // Evidence chip (E-2): when the finding names a location in this
  // function, focus that line; otherwise fall back to the entry row.
  const focusEvidence = (id: string): void => {
    const entry = explain?.evidence.get(id);
    const target = entry?.targets.find(
      (candidate) => candidate.selector.toLowerCase() === selector.toLowerCase() && candidate.offset !== null,
    );
    if (target !== undefined && target.offset !== null) {
      const line = lineForPc(lines, target.offset);
      if (line !== null) {
        if (view !== "decompiled") {
          chooseView("decompiled");
        }
        setPendingFocus({ view: "decompiled", line: line.lineNumber, nonce: Date.now() });
        return;
      }
    }
    focusEntryEvidence();
  };

  const chipsFor =
    (pane: CodePaneView) =>
    (entry: StaticEntry): JSX.Element | null => {
      const maps: CiteMaps = {
        lines: pane === "decompiled" ? decompiledLineSet : sourceLineSet,
        functions: explain?.functions ?? new Map(),
        evidence: evidenceLabels,
      };
      const node = entryChips(
        entry,
        { selector, view: pane },
        maps,
        {
          onLine: (line) => focusExplainedLine(pane, line),
          onFunction: (targetSelector, targetView, line) => explain?.onFunctionCite(targetSelector, targetView, line),
          onEvidence: (target) => focusEvidence(target),
        },
      );
      return node === null ? null : <>{node}</>;
    };

  // Several notes may share one anchor line (their ranges end on the
  // same line): every mounted note after the line renders, in order.
  // Mounting is sentence-level, so placement stays stable across the
  // 16 ms ticks; the shown slice resolves inside the note leaves.
  const noteEntriesAfter = (
    runtime: ExplainRuntime,
    lineNumber: number,
  ): readonly { readonly entry: StaticEntry; readonly index: number }[] => {
    if (!notesOn) {
      return [];
    }
    const placed: { entry: StaticEntry; index: number }[] = [];
    runtime.staticEntries.forEach((entry, index) => {
      if (
        entry.kind === "note" &&
        entryMounted(runtime.sentence, index) &&
        entry.note !== null &&
        entry.note.to === lineNumber
      ) {
        placed.push({ entry, index });
      }
    });
    return placed;
  };

  const noteEntryAt = (
    runtime: ExplainRuntime,
    lineNumber: number,
  ): { readonly entry: StaticEntry; readonly index: number } | null => {
    if (!notesOn) {
      return null;
    }
    for (const [index, entry] of runtime.staticEntries.entries()) {
      if (
        entry.kind === "note" &&
        entryMounted(runtime.sentence, index) &&
        entry.note !== null &&
        entry.note.from === lineNumber
      ) {
        return { entry, index };
      }
    }
    return null;
  };

  const noteLampFor =
    (pane: CodePaneView, paneId: string, runtime: ExplainRuntime) =>
    (lineNumber: number): GutterLamp | null => {
      if (!notesOn) {
        return null;
      }
      const placed = noteEntryAt(runtime, lineNumber);
      if (placed === null || placed.entry.note === null) {
        return null;
      }
      const id = `${paneId}-note-${placed.entry.key}`;
      return {
        label: `Muse note for ${noteRangeLabel(placed.entry.note)}`,
        pictogram: "muse",
        onActivate: () => focusNoteById(id),
      };
    };

  const focusLine = (pc: number, lineNumber: number): void => {
    setTargetPc(pc);
    const element = lineEls.current.get(lineNumber);
    if (element === null || element === undefined) {
      return;
    }
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "center" });
    if (motionAllowed() && !reduce) {
      void runSequence([{ element, keyframes: pulseKeyframes(), options: { duration: 760 } }]);
    }
  };

  const showInCode = (): void => {
    if (entryPc === null) {
      return;
    }
    const entry = lineForPc(lines, entryPc);
    if (entry === null) {
      return;
    }
    focusLine(entryPc, entry.lineNumber);
  };

  // E-2 on arrival with a pc: focus the line, set the target style
  // and play one pulse. Without pcs no line is ever guessed.
  useEffect(() => {
    if (snippet.kind !== "ready" || mountedTarget.current === null || mountedTarget.current === undefined) {
      return;
    }
    const pc = mountedTarget.current;
    mountedTarget.current = null;
    const entry = lineForPc(snippet.result.lines, pc);
    if (entry !== null) {
      setTargetPc(pc);
      const element = lineEls.current.get(entry.lineNumber);
      element?.focus({ preventScroll: true });
      element?.scrollIntoView({ block: "center" });
      if (element !== undefined && motionAllowed()) {
        void runSequence([{ element, keyframes: pulseKeyframes(), options: { duration: 760 } }]);
      }
    }
  }, [snippet]);

  const chooseView = (next: CodePaneView): void => {
    setView(next);
    try {
      window.sessionStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // Private mode: the choice still holds for this page.
    }
  };

  const onTabsKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") {
      return;
    }
    event.preventDefault();
    if (event.key === "Home") {
      chooseView("decompiled");
      tabDecompiled.current?.focus();
      return;
    }
    if (event.key === "End") {
      chooseView("source");
      tabSource.current?.focus();
      return;
    }
    if (view === "decompiled" && event.key === "ArrowRight") {
      chooseView("source");
      tabSource.current?.focus();
    } else if (view === "source" && event.key === "ArrowLeft") {
      chooseView("decompiled");
      tabDecompiled.current?.focus();
    }
  };

  const shown = expandedLines ? lines : lines.slice(0, SNIPPET_LIMIT);
  const entryLineNumber = entryPc === null ? null : (lineForPc(lines, entryPc)?.lineNumber ?? null);
  const evidenceLines = useMemo(
    () => (entryLineNumber === null ? new Set<number>() : new Set([entryLineNumber])),
    [entryLineNumber],
  );

  const copyText = view === "source" ? codeCopyText(shownSource) : codeCopyText(lines);
  const copyLabel = view === "source" ? `Copy verified source of ${title}` : `Copy decompiled ${title}`;

  const showWholeContract = async (): Promise<void> => {
    if (onCopyWholeContract === undefined) {
      return;
    }
    setWholeCopy(await onCopyWholeContract());
  };

  // VS-2 margin notes for one pane (≥1600 px): the pane reserves a
  // right margin, notes top-align to their first cited line and stack
  // when they would overlap. Code line heights never change.
  const renderMarginNotes = (pane: CodePaneView, paneId: string, runtime: ExplainRuntime): JSX.Element | null => {
    if (!margin || !notesOn || runtime.status !== "ready") {
      return null;
    }
    const mounted: { entry: StaticEntry; index: number }[] = [];
    runtime.staticEntries.forEach((entry, index) => {
      if (entry.kind === "note" && entryMounted(runtime.sentence, index) && entry.note !== null) {
        mounted.push({ entry, index });
      }
    });
    if (mounted.length === 0) {
      return null;
    }
    const elements = pane === "decompiled" ? lineEls : sourceLineEls;
    return (
      <MarginNotes
        notes={mounted.map(({ entry }) => ({
          id: `${paneId}-note-${entry.key}`,
          from: (entry.note as ExplainCodeNote).from,
        }))}
        renderNote={(id) => {
          const placed = mounted.find((candidate) => `${paneId}-note-${candidate.entry.key}` === id);
          if (placed === undefined) {
            return null;
          }
          return (
            <ExplainNoteBody
              noteId={id}
              entry={placed.entry}
              index={placed.index}
              store={runtime.typing}
              chips={chipsFor(pane)(placed.entry)}
            />
          );
        }}
        lineTop={(line) => elements.current.get(line)?.offsetTop ?? null}
      />
    );
  };

  // VS-2 interleaved note after a line (<1600 px): an indented callout
  // between its range's lines. Null at margin widths, when notes are
  // off, or without a mounted note for the line.
  const renderInterleavedNote =
    (pane: CodePaneView, paneId: string, runtime: ExplainRuntime) =>
    (lineNumber: number): ReactNode | null => {
      if (margin) {
        return null;
      }
      const after = noteEntriesAfter(runtime, lineNumber);
      if (after.length === 0) {
        return null;
      }
      return (
        <>
          {after.map(({ entry, index }) =>
            entry.note === null ? null : (
              <TypedInterleavedNote
                key={`${paneId}-note-${entry.key}`}
                noteId={`${paneId}-note-${entry.key}`}
                note={entry.note}
                entry={entry}
                index={index}
                store={runtime.typing}
                chips={chipsFor(pane)(entry)}
              />
            ),
          )}
        </>
      );
    };

  const renderDecompiledPane = (paneId: string): JSX.Element => (
    <section className={`code-pane${explainAvailable ? " explainable" : ""}`} aria-label="Decompiled from bytecode">
      <div className="code-pane-head">
        <ProvenanceBadge kind="decompiled" />
        {renamedFrom !== null ? <p className="code-names muted">Names: from verified source.</p> : null}
      </div>
      {explainAvailable ? (
        <ExplainViewResults
          store={decRuntime.typing}
          status={decRuntime.status}
          modelId={decRuntime.modelId}
          dropped={decRuntime.dropped}
          staticEntries={decRuntime.staticEntries}
          readyMessage={decRuntime.readyMessage}
          title={title}
          lineCount={lines.length}
          chipsFor={chipsFor("decompiled")}
          onRetry={decRuntime.retry}
          onAskAgain={decRuntime.askAgain}
        />
      ) : null}
      {renderMarginNotes("decompiled", paneId, decRuntime)}
      {snippet.kind === "loading" ? (
        <p role="status" className="scan-status">
          {reduce ? "Loading…" : "Scanning…"}
          {reduce ? null : <b className="cursor" aria-hidden="true" />}
        </p>
      ) : snippet.kind === "failed" || snippet.kind === "idle" ? (
        <p className="muted">Readable code is not available for this function.</p>
      ) : (
        <>
          <CodeLines
            idPrefix={`${paneId}-dec`}
            lines={shown}
            functionName={title}
            targetLine={citeTarget?.pane === "decompiled" ? citeTarget.line : (targetLine?.lineNumber ?? null)}
            evidenceLines={evidenceLines}
            highlightLines={highlightDecompiled}
            citedLines={decRuntime.citedLines}
            liveLines={decRuntime.liveLines}
            noteAfterLine={renderInterleavedNote("decompiled", paneId, decRuntime)}
            gutterLampFor={(lineNumber) =>
              evidenceLabel !== null && entryLineNumber === lineNumber
                ? { label: evidenceLabel, onActivate: () => document.getElementById(`${baseId}-entry`)?.focus() }
                : (noteLampFor("decompiled", paneId, decRuntime)(lineNumber) ?? null)
            }
            renamedFrom={renamedFrom}
            expert={expert}
            lineRef={handleDecLineRef}
            onLineFocus={handleDecFocus}
            onLineHover={handleDecHover}
          />
          {lines.length > SNIPPET_LIMIT && !expandedLines ? (
            <button type="button" className="button-ghost snippet-more" onClick={() => setExpandedLines(true)}>
              Show all {lines.length} lines
            </button>
          ) : null}
          {!hasPcs ? (
            <p className="muted code-link-note">Linked by function. Line-level links need a newer server.</p>
          ) : null}
          {activeDecompiled !== null && (decompiledToSource.get(activeDecompiled) ?? []).length > 0 ? (
            <button
              type="button"
              className="button-ghost code-context-link"
              onClick={() => {
                const first = (decompiledToSource.get(activeDecompiled as number) ?? [])[0];
                if (first === undefined) {
                  return;
                }
                const element = sourceLineEls.current.get(first);
                element?.focus({ preventScroll: true });
                element?.scrollIntoView({ block: "center" });
              }}
            >
              Show in verified source
            </button>
          ) : null}
          <ol className="evidence-list decompiler-evidence">
            <li className="evidence-row" id={`${baseId}-entry`} tabIndex={-1}>
              <div className="evidence-top">
                <span className="evidence-name">{title}</span>
                <span className="evidence-at">
                  at <span className="mono">{pcHex(entryPc)}</span>
                </span>
                {entryLineNumber === null ? null : (
                  <button type="button" className="button-ghost evidence-code-link" onClick={showInCode}>
                    Show in code
                  </button>
                )}
              </div>
            </li>
          </ol>
        </>
      )}
    </section>
  );

  const renderSourcePane = (paneId: string): JSX.Element => (
    <section className={`code-pane${explainAvailable ? " explainable" : ""}`} aria-label="Verified source">
      <div className="code-pane-head">
        {verifiedKind === null ? (
          <p className="code-badge muted">Checking verified source…</p>
        ) : (
          <ProvenanceBadge kind={verifiedKind} />
        )}
        {sourceFile !== null ? <p className="code-file muted">{sourceFile.path}</p> : null}
        <p className="code-honesty muted">Verified means published, not safe. Names and comments are the author&apos;s claims.</p>
      </div>
      {explainAvailable && sourceHasCode ? (
        <ExplainViewResults
          store={srcRuntime.typing}
          status={srcRuntime.status}
          modelId={srcRuntime.modelId}
          dropped={srcRuntime.dropped}
          staticEntries={srcRuntime.staticEntries}
          readyMessage={srcRuntime.readyMessage}
          title={title}
          lineCount={shownSource.length}
          chipsFor={chipsFor("source")}
          onRetry={srcRuntime.retry}
          onAskAgain={srcRuntime.askAgain}
        />
      ) : null}
      {renderMarginNotes("source", paneId, srcRuntime)}
      {source.kind === "loading" || source.kind === "idle" ? (
        <p role="status" className="scan-status">
          {reduce ? "Loading…" : "Looking for verified source…"}
          {reduce ? null : <b className="cursor" aria-hidden="true" />}
        </p>
      ) : sourceUnavailable ? (
        <SourceEmpty
          status="unavailable"
          provider={provider}
          block={block ?? null}
          onRetry={() => {
            // An HTTP-200 "unavailable" body is a cached success, so drop
            // it before refetching; a failed fetch already cleared itself.
            clearSourceCache();
            sourceLoading.current = false;
            setSource({ kind: "idle" });
            setSourceNonce((nonce) => nonce + 1);
          }}
          onShowDecompiled={null}
        />
      ) : sourceResult?.status === "none" ? (
        <SourceEmpty
          status="none"
          provider={provider}
          block={block ?? null}
          onRetry={null}
          onShowDecompiled={wide ? null : () => chooseView("decompiled")}
        />
      ) : mismatch || sourceFile === null || sourceFn === null ? (
        <div className="code-empty" role="status">
          <p className="code-empty-title">Not in the verified source</p>
          <p className="code-empty-line">The dispatcher has this function, but the published source does not define it.</p>
        </div>
      ) : (
        <>
          {sourceFirstLine > 1 && !wholeFile ? (
            <button type="button" className="button-ghost snippet-more" onClick={() => setAboveCount((count) => count + CONTEXT_LINES)}>
              Show 10 lines above
            </button>
          ) : null}
          <CodeLines
            idPrefix={`${paneId}-src`}
            lines={shownSource}
            functionName={title}
            targetLine={citeTarget?.pane === "source" ? citeTarget.line : null}
            evidenceLines={new Set()}
            highlightLines={highlightSource}
            citedLines={srcRuntime.citedLines}
            liveLines={srcRuntime.liveLines}
            noteAfterLine={renderInterleavedNote("source", paneId, srcRuntime)}
            gutterLampFor={(lineNumber) => noteLampFor("source", paneId, srcRuntime)(lineNumber)}
            renamedFrom={null}
            expert={expert}
            lineRef={handleSrcLineRef}
            onLineFocus={handleSrcFocus}
            onLineHover={handleSrcHover}
          />
          {!wholeFile && sourceLastLine < wholeFileLines.length ? (
            <button type="button" className="button-ghost snippet-more" onClick={() => setBelowCount((count) => count + CONTEXT_LINES)}>
              Show 10 lines below
            </button>
          ) : null}
          {expert && !wholeFile && canWholeFile ? (
            <button type="button" className="button-ghost snippet-more" onClick={() => setWholeFile(true)}>
              Show whole file
            </button>
          ) : null}
          {expert && !canWholeFile && wholeFileLines.length > WHOLE_FILE_LINE_CAP ? (
            <p className="muted code-link-note">
              Large file — open this contract on Sourcify.{" "}
              <a
                href={`https://sourcify.dev/#/lookup/${encodeURIComponent(toChecksumAddress(address))}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ display: "inline-flex", alignItems: "center", minHeight: 44 }}
              >
                Open on Sourcify
              </a>
            </p>
          ) : null}
          {activeSource !== null && (sourceToDecompiled.get(activeSource) ?? []).length > 0 ? (
            <button
              type="button"
              className="button-ghost code-context-link"
              onClick={() => {
                const first = (sourceToDecompiled.get(activeSource as number) ?? [])[0];
                if (first === undefined) {
                  return;
                }
                const element = lineEls.current.get(first);
                element?.focus({ preventScroll: true });
                element?.scrollIntoView({ block: "center" });
              }}
            >
              Show in decompiled line
            </button>
          ) : null}
          {!hasSourceMap ? <p className="muted code-link-note">Linked by function</p> : null}
        </>
      )}
    </section>
  );

  const bytes = startPc !== null && endPc !== null ? endPc - startPc : null;
  const tabLabelSource =
    source.kind === "ready" && sourceResult?.status === "none" ? "Verified source · none" : "Verified source";

  return (
    <div className="code-view">
      <div className="code-head">
        <p className="code-title">
          {title} <span className="mono code-selector">{selector}</span>{" "}
          <span className="code-name-chip">
            {nameFrom === "verified"
              ? "name from verified source"
              : nameFrom === "table"
                ? "name from public selector table"
                : "unnamed"}
          </span>{" "}
          {mismatch ? <span className="code-mismatch-chip">Not in the verified source</span> : null}
        </p>
        {bytes !== null || unresolvedJumps > 0 ? (
          <p className="code-meta muted">
            {startPc !== null ? `Starts at ${pcHex(startPc)}` : "Start unknown"}
            {bytes !== null ? ` · ${bytes.toLocaleString("en-US")} bytes` : ""}
            {unresolvedJumps > 0 ? ` · partly read: ${unresolvedJumps} jumps were not followed` : ""}
          </p>
        ) : null}
        <div className="code-actions">
          <CopyButton value={copyText} label={copyLabel} testId={`copy-function-${selector}`} />
          {expert && onCopyWholeContract !== undefined ? (
            <button type="button" className="button-ghost" onClick={() => void showWholeContract()}>
              Copy whole decompiled contract
            </button>
          ) : null}
          {explainAction}
          {explainAvailable ? (
            wide && sourceHasCode ? (
              <>
                <ExplainCodeButton
                  label="Explain decompiled"
                  consentId={`${baseId}-explain-consent`}
                  busy={decRuntime.status === "pending"}
                  testId={`explain-code-decompiled-${selector}`}
                  onPress={decRuntime.request}
                />
                <ExplainCodeButton
                  label="Explain verified source"
                  consentId={`${baseId}-explain-consent`}
                  busy={srcRuntime.status === "pending"}
                  testId={`explain-code-source-${selector}`}
                  onPress={srcRuntime.request}
                />
              </>
            ) : (
              <ExplainCodeButton
                label="Explain this code"
                consentId={`${baseId}-explain-consent`}
                busy={runtimeFor(explainsView).status === "pending"}
                testId={`explain-code-${selector}`}
                onPress={runtimeFor(explainsView).request}
              />
            )
          ) : null}
          {anyReady ? (
            <button
              type="button"
              role="switch"
              aria-checked={notesOn}
              aria-label="Muse notes"
              className="button-ghost"
              onClick={() => setNotesOn((value) => !value)}
            >
              Notes: {notesOn ? "On" : "Off"}
            </button>
          ) : null}
        </div>
        {explainAvailable || (explainAction !== undefined && explainAction !== null) ? (
          <p className="code-consent muted" id={`${baseId}-explain-consent`}>
            Sends this function&apos;s code to Muse Spark 1.3. One request.
          </p>
        ) : null}
      </div>
      {wholeCopy !== null ? <span className="sr-only" role="status">Whole contract copied.</span> : null}
      {wide ? (
        <div className="code-panes">
          {renderDecompiledPane(`${baseId}-wide`)}
          {renderSourcePane(`${baseId}-wide`)}
        </div>
      ) : (
        <div className="code-tabs-wrap">
          <div className="code-tabs" role="tablist" aria-label={`Code views for ${title}`} onKeyDown={onTabsKey}>
            <button
              ref={tabDecompiled}
              type="button"
              role="tab"
              id={`${baseId}-tab-dec`}
              aria-selected={view === "decompiled"}
              aria-controls={`${baseId}-panel`}
              tabIndex={view === "decompiled" ? 0 : -1}
              className="code-tab"
              onClick={() => chooseView("decompiled")}
            >
              Decompiled
            </button>
            <button
              ref={tabSource}
              type="button"
              role="tab"
              id={`${baseId}-tab-src`}
              aria-selected={view === "source"}
              aria-controls={`${baseId}-panel`}
              tabIndex={view === "source" ? 0 : -1}
              className="code-tab"
              onClick={() => chooseView("source")}
            >
              {tabLabelSource}
            </button>
          </div>
          <div
            role="tabpanel"
            id={`${baseId}-panel`}
            aria-labelledby={view === "decompiled" ? `${baseId}-tab-dec` : `${baseId}-tab-src`}
            tabIndex={0}
            className="code-panel"
          >
            {view === "decompiled" ? renderDecompiledPane(baseId) : renderSourcePane(baseId)}
          </div>
        </div>
      )}
    </div>
  );
}
