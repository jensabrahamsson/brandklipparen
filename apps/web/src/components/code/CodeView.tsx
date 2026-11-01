// Code view per function (addendum §A1): Decompiled and Verified
// source panes with tabs below 1100 px and side by side above,
// provenance badges, linking, highlighting and empty states.
// The function header leaves a clear slot for VS-2 ("Explain this
// code") through the explainAction prop; nothing AI renders here yet.
import { useEffect, useId, useMemo, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from "react";
import { CopyButton } from "../CopyButton.tsx";
import { CodeLines, type CodeLineDatum } from "./CodeLines.tsx";
import { ProvenanceBadge, type ProvenanceKind } from "./ProvenanceBadge.tsx";
import { SourceEmpty } from "./SourceEmpty.tsx";
import { fetchSnippet, type SnippetResult } from "../../lib/api.ts";
import { clearSourceCache, fetchSource, findSourceFile, findSourceFunction, sourceFunctionLines, type SourceResult } from "../../lib/source.ts";
import { motionAllowed, pulseKeyframes, runSequence } from "../../lib/explainMotion.ts";
import { useMediaQuery } from "../../lib/useMediaQuery.ts";
import { useReducedMotion } from "../../lib/motion.ts";
import type { CodePaneView } from "../../lib/route.ts";

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
  const functionBody = sourceFile === null || sourceFn === null ? [] : sourceFunctionLines(sourceFile, sourceFn);
  const wholeFileLines = sourceFile === null ? [] : sourceFile.content.split("\n");
  const canWholeFile = wholeFileLines.length > 0 && wholeFileLines.length <= WHOLE_FILE_LINE_CAP;

  const sourceFirstLine = sourceFn === null ? 1 : sourceFn.startLine - aboveCount;
  const sourceLastLine = sourceFn === null ? 0 : sourceFn.endLine + belowCount;
  const shownSource: CodeLineDatum[] = wholeFile
    ? wholeFileLines.map((text, index) => ({ lineNumber: index + 1, text, pcs: [] as readonly number[] }))
    : functionBody.map((text, index) => ({
        lineNumber: (sourceFn?.startLine ?? 1) + index,
        text,
        pcs: [] as readonly number[],
      }));

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

  const renderDecompiledPane = (paneId: string): JSX.Element => (
    <section className="code-pane" aria-label="Decompiled from bytecode">
      <div className="code-pane-head">
        <ProvenanceBadge kind="decompiled" />
        {renamedFrom !== null ? <p className="code-names muted">Names: from verified source.</p> : null}
      </div>
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
            targetLine={targetLine?.lineNumber ?? null}
            evidenceLines={evidenceLines}
            highlightLines={highlightDecompiled}
            gutterLampFor={(lineNumber) =>
              evidenceLabel !== null && entryLineNumber === lineNumber
                ? { label: evidenceLabel, onActivate: () => document.getElementById(`${baseId}-entry`)?.focus() }
                : null
            }
            renamedFrom={renamedFrom}
            expert={expert}
            lineRef={(lineNumber, element) => {
              if (element === null) {
                lineEls.current.delete(lineNumber);
              } else {
                lineEls.current.set(lineNumber, element);
              }
            }}
            onLineFocus={(lineNumber) => setActiveDecompiled(lineNumber)}
            onLineHover={(lineNumber) => setActiveDecompiled(lineNumber)}
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
    <section className="code-pane" aria-label="Verified source">
      <div className="code-pane-head">
        {verifiedKind === null ? (
          <p className="code-badge muted">Checking verified source…</p>
        ) : (
          <ProvenanceBadge kind={verifiedKind} />
        )}
        {sourceFile !== null ? <p className="code-file muted">{sourceFile.path}</p> : null}
        <p className="code-honesty muted">Verified means published, not safe. Names and comments are the author&apos;s claims.</p>
      </div>
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
            targetLine={null}
            evidenceLines={new Set()}
            highlightLines={highlightSource}
            gutterLampFor={() => null}
            renamedFrom={null}
            expert={expert}
            lineRef={(lineNumber, element) => {
              if (element === null) {
                sourceLineEls.current.delete(lineNumber);
              } else {
                sourceLineEls.current.set(lineNumber, element);
              }
            }}
            onLineFocus={(lineNumber) => setActiveSource(lineNumber)}
            onLineHover={(lineNumber) => setActiveSource(lineNumber)}
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
              The file is too large to show here.{" "}
              <a href="https://sourcify.dev" rel="noopener noreferrer">
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
        </div>
        {explainAction === undefined || explainAction === null ? null : (
          <p className="code-consent muted" id={`${baseId}-explain-consent`}>
            Sends this function&apos;s code to Muse Spark 1.3. One request.
          </p>
        )}
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
