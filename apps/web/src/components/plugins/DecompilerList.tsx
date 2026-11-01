// Decompiler function list (UI v2 §5.4, W-6): collapsed per-function
// rows with a summary, a filter, a segmented control, the spec order,
// lazy pseudo-code with pc-level line links (addendum §A1.4), the entry
// evidence row and Expert raw. The route `<selector>` auto-expands and
// focuses its row. Motion is opacity and glow only, one shot per expand;
// static under prefers-reduced-motion. Sentence case throughout, and
// the raw cause string never renders outside Expert raw.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type JSX } from "react";
import { Pictogram } from "../Pictogram.tsx";
import { CodeView, type CodeFocusRequest, type ExplainContext, type ExplainEvidenceEntry } from "../code/CodeView.tsx";
import { fetchSnippet } from "../../lib/api.ts";
import { useCountUp } from "../../lib/motion.ts";
import type { CodePaneView } from "../../lib/route.ts";
import {
  annotationChipText,
  decompilerCountLine,
  decompilerFunctionSentence,
  decompilerStatusWord,
  decompilerSummaryLine,
  filterDecompilerFunctions,
  parseDecompilerFunctions,
  sortDecompilerFunctions,
  summarizeDecompilerFunctions,
  type DecompilerFunction,
  type DecompilerSegment,
} from "../../lib/decompilerView.ts";
import type { PluginFindingView } from "../PluginsPanel.tsx";

const ROW_LIMIT = 12;

function normalizeSelector(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{8}$/.test(trimmed)) {
    return null;
  }
  return trimmed.toLowerCase();
}

function statusGlyph(status: DecompilerFunction["status"]): "found" | "partial" | "error" {
  if (status === "partly-read") {
    return "partial";
  }
  if (status === "error") {
    return "error";
  }
  return "found";
}

function statusClass(status: DecompilerFunction["status"]): string {
  if (status === "partly-read") {
    return "is-partly";
  }
  if (status === "error") {
    return "is-error";
  }
  return "is-complete";
}

// Expanded function body: the code view (addendum §A1) with the
// decompiled and verified-source panes, pc-level line links, the entry
// evidence row and the VS-2 read-along. Display text only; the raw
// cause never renders here (it stays in Expert raw below).
function FunctionBody({
  address,
  apiKey,
  fn,
  expert,
  codeView,
  codePc,
  explain,
  focusRequest,
  onFocusConsumed,
  onCopyWholeContract,
}: {
  readonly address: string;
  readonly apiKey: string;
  readonly fn: DecompilerFunction;
  readonly expert: boolean;
  readonly codeView: CodePaneView | undefined;
  readonly codePc: number | undefined;
  readonly explain: ExplainContext;
  readonly focusRequest: CodeFocusRequest | null;
  readonly onFocusConsumed: () => void;
  readonly onCopyWholeContract: (() => Promise<string>) | undefined;
}): JSX.Element {
  const entryHex = fn.entryPc === null ? "unknown" : `0x${fn.entryPc.toString(16)}`;
  return (
    <div className="decompiler-code">
      <CodeView
        address={address}
        apiKey={apiKey}
        selector={fn.selector}
        title={fn.displayName}
        nameFrom={fn.named ? "table" : "unnamed"}
        entryPc={fn.entryPc}
        startPc={fn.startPc}
        endPc={fn.endPc}
        unresolvedJumps={fn.unresolvedJumps}
        initialView={codeView}
        initialPc={codePc}
        expert={expert}
        evidenceLabel={fn.entryPc === null ? null : `Evidence at ${entryHex}: back to the evidence row`}
        explain={explain}
        focusRequest={focusRequest}
        onFocusConsumed={onFocusConsumed}
        onCopyWholeContract={onCopyWholeContract}
      />
    </div>
  );
}

// One collapsed row plus its expanded body (UI v2 §5.4): the plain
// sentence, pseudo-code, the entry evidence row and Expert raw. The
// body renders at rest height the moment it opens (no height motion);
// collapse unmounts at once. Expanding never scrolls, so nothing above
// the row moves.
function DecompilerRow({
  address,
  apiKey,
  fn,
  expert,
  open,
  onToggle,
  buttonId,
  regionId,
  index,
  registerButton,
  codeView,
  codePc,
  explain,
  focusRequest,
  onFocusConsumed,
  onCopyWholeContract,
}: {
  readonly address: string;
  readonly apiKey: string;
  readonly fn: DecompilerFunction;
  readonly expert: boolean;
  readonly open: boolean;
  readonly onToggle: (selector: string) => void;
  readonly buttonId: string;
  readonly regionId: string;
  readonly index: number;
  readonly registerButton: (selector: string, element: HTMLButtonElement | null) => void;
  readonly codeView: CodePaneView | undefined;
  readonly codePc: number | undefined;
  readonly explain: ExplainContext;
  readonly focusRequest: CodeFocusRequest | null;
  readonly onFocusConsumed: () => void;
  readonly onCopyWholeContract: (() => Promise<string>) | undefined;
}): JSX.Element {
  const expanded = open;
  const chips = fn.annotations
    .map((annotation) => annotationChipText(annotation))
    .filter((chip): chip is string => chip !== null);
  return (
    <li className="decompiler-item" style={{ "--i": Math.min(index, 8) } as CSSProperties}>
      <button
        type="button"
        id={buttonId}
        ref={(element) => registerButton(fn.selector, element)}
        className={`decompiler-row ${statusClass(fn.status)}`}
        aria-expanded={open}
        aria-controls={regionId}
        data-testid={`decompiler-row-${fn.selector}`}
        onClick={() => onToggle(fn.selector)}
      >
        <span className="lamp decompiler-lamp" aria-hidden="true">
          <Pictogram name={statusGlyph(fn.status)} size={20} />
        </span>
        <span className="sr-only">{decompilerStatusWord(fn.status)}.</span>
        <span className="decompiler-name">{fn.displayName}</span>
        <span className="decompiler-selector mono">{fn.selector}</span>
        {fn.ownerOnly ? <span className="owner-tag">Owner-only</span> : null}
        {chips.map((chip) => (
          <span key={chip} className="decompiler-chip">
            {chip}
          </span>
        ))}
        <span className="decompiler-chev" aria-hidden="true">
          <Pictogram name={open ? "chevron-down" : "chevron-right"} size={20} />
        </span>
      </button>
      <div className={`decompiler-expand${expanded ? " is-open" : ""}`}>
        <div className="decompiler-expand-clip">
          {open ? (
            <div className="decompiler-body" id={regionId} role="region" aria-labelledby={buttonId}>
              <p className="decompiler-sentence">{decompilerFunctionSentence(fn)}</p>
              <FunctionBody
                address={address}
                apiKey={apiKey}
                fn={fn}
                expert={expert}
                codeView={codeView}
                codePc={codePc}
                explain={explain}
                focusRequest={focusRequest}
                onFocusConsumed={onFocusConsumed}
                onCopyWholeContract={onCopyWholeContract}
              />
              {expert ? (
                <dl className="decompiler-raw" data-testid={`decompiler-raw-${fn.selector}`}>
                  <div>
                    <dt>Annotations</dt>
                    <dd>{fn.annotations.length > 0 ? fn.annotations.join(", ") : "None"}</dd>
                  </div>
                  <div>
                    <dt>Cause</dt>
                    <dd>{fn.cause ?? "None"}</dd>
                  </div>
                  <div>
                    <dt>Entry pc</dt>
                    <dd>{fn.entryPc === null ? "Unknown" : `0x${fn.entryPc.toString(16)}`}</dd>
                  </div>
                  <div>
                    <dt>Start pc</dt>
                    <dd>{fn.startPc === null ? "Unknown" : `0x${fn.startPc.toString(16)}`}</dd>
                  </div>
                  <div>
                    <dt>End pc</dt>
                    <dd>{fn.endPc === null ? "Unknown" : `0x${fn.endPc.toString(16)}`}</dd>
                  </div>
                  <div>
                    <dt>Name</dt>
                    <dd>{fn.name ?? "None"}</dd>
                  </div>
                  <div>
                    <dt>Selector</dt>
                    <dd>{fn.selector}</dd>
                  </div>
                  <div>
                    <dt>Signature</dt>
                    <dd>{fn.signature ?? "None"}</dd>
                  </div>
                  <div>
                    <dt>Unresolved jumps</dt>
                    <dd>{fn.unresolvedJumps}</dd>
                  </div>
                </dl>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

const SEGMENTS: readonly { id: DecompilerSegment; label: string }[] = Object.freeze([
  { id: "all", label: "All" },
  { id: "owner-only", label: "Owner-only" },
  { id: "named", label: "Named" },
]);

// Short display name for a cross-function citation chip: `transfer()`.
function shortFunctionName(fn: DecompilerFunction): string {
  if (fn.name !== null && fn.name.length > 0) {
    return `${fn.name}()`;
  }
  if (fn.signature !== null) {
    const name = fn.signature.replace(/\(.*$/, "");
    if (name.length > 0) {
      return `${name}()`;
    }
  }
  return `Function ${fn.selector}`;
}

export type ExplainFocusTarget = {
  readonly key: string;
  readonly view: CodePaneView;
  readonly line: number;
  readonly nonce: number;
};

export function DecompilerList({
  address,
  apiKey,
  findings,
  expert,
  initialSelector,
  initialView,
  initialPc,
  explainAvailable,
  evidenceIndex,
}: {
  readonly address: string;
  readonly apiKey: string;
  readonly findings: readonly PluginFindingView[];
  readonly expert: boolean;
  // Route `<selector>` (UI v2 §1.3): this row starts expanded and focused.
  readonly initialSelector?: string | undefined;
  // Route view and pc (addendum §A1.1): the code view's initial pane and
  // the offset whose line to target.
  readonly initialView?: CodePaneView | undefined;
  readonly initialPc?: number | undefined;
  // VS-2: false when /health reports the code-explain feature
  // unavailable (no buttons, no dead control). Defaults to available
  // so older callers keep the explicit-request behaviour.
  readonly explainAvailable?: boolean | undefined;
  // VS-2 evidence chips: every plugin finding of this analysis, id to
  // label plus the code locations that prove it.
  readonly evidenceIndex?: ReadonlyMap<string, ExplainEvidenceEntry> | undefined;
}): JSX.Element {
  const all = useMemo(
    () => sortDecompilerFunctions(parseDecompilerFunctions(findings.map((finding) => finding.payload))),
    [findings],
  );
  const summary = useMemo(() => summarizeDecompilerFunctions(all), [all]);
  const countedTotal = useCountUp(summary.total, 600);
  const countedNamed = useCountUp(summary.named, 600);
  const countedPartly = useCountUp(summary.partlyRead, 600);
  const [query, setQuery] = useState("");
  const [segment, setSegment] = useState<DecompilerSegment>("all");
  const visible = useMemo(() => filterDecompilerFunctions(all, query, segment), [all, query, segment]);
  // A deep link past the row cap starts with the full list, so the
  // target row exists on the first render (effects never run under
  // renderToString, and the focus effect below needs the button).
  const [showAll, setShowAll] = useState(() => {
    const initial = normalizeSelector(initialSelector);
    if (initial === null) {
      return false;
    }
    return visible.findIndex((fn) => fn.selector.toLowerCase() === initial) >= ROW_LIMIT;
  });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => {
    const initial = normalizeSelector(initialSelector);
    if (initial === null) {
      return new Set();
    }
    return all.some((fn) => fn.selector.toLowerCase() === initial) ? new Set([initial]) : new Set();
  });
  const filterId = useId();
  const listId = useId();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  // Focus the deep-linked row once it is rendered, on the next frame
  // so the button is mounted. Keyed on the shown rows because the
  // target may arrive only after the cap is lifted; the guard keeps a
  // later filter keystroke from stealing focus back.
  const focusedInitial = useRef<string | null>(null);
  useEffect(() => {
    const initial = normalizeSelector(initialSelector);
    if (initial === null || focusedInitial.current === initial) {
      return;
    }
    if (!visible.some((fn) => fn.selector.toLowerCase() === initial)) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const target = buttons.current.get(initial);
      if (target !== undefined) {
        target.focus();
        focusedInitial.current = initial;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [initialSelector, visible, showAll]);

  const shown = useMemo(() => (showAll ? visible : visible.slice(0, ROW_LIMIT)), [showAll, visible]);
  // Expert only: copy the whole decompiled contract as plain text, one
  // cached snippet request per function, full hex and no notes.
  const copyWholeContract = useCallback(async (): Promise<string> => {
    const key = apiKey.length === 0 ? null : apiKey;
    const parts: string[] = [];
    for (const fn of all) {
      try {
        const result = await fetchSnippet(address, fn.selector, key);
        parts.push(`// ${fn.selector} ${fn.displayName}\n${result.lines.map((line) => line.text).join("\n")}`);
      } catch {
        parts.push(`// ${fn.selector}: readable code is not available`);
      }
    }
    const text = parts.join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard is a convenience only; the caller still receives the
      // text and the sweep stays quiet without a page error.
    }
    return text;
  }, [all, address, apiKey]);
  const registerButton = (selector: string, element: HTMLButtonElement | null): void => {
    if (element === null) {
      buttons.current.delete(selector.toLowerCase());
    } else {
      buttons.current.set(selector.toLowerCase(), element);
    }
  };
  const toggle = (selector: string): void => {
    const key = selector.toLowerCase();
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // VS-2 cross-function chips: every function of this contract resolves
  // by lower-cased selector to its short name. A chip press expands the
  // target row (when collapsed) and focuses the cited line with one
  // E-2 pulse; the row clears the request once its CodeView takes over.
  const explainFunctions = useMemo(() => {
    const map = new Map<string, string>();
    for (const fn of all) {
      map.set(fn.selector.toLowerCase(), shortFunctionName(fn));
    }
    return map;
  }, [all]);
  const [focusTarget, setFocusTarget] = useState<ExplainFocusTarget | null>(null);
  const onFunctionCite = useCallback((targetSelector: string, targetView: CodePaneView, line: number): void => {
    const key = targetSelector.toLowerCase();
    setExpanded((previous) => (previous.has(key) ? previous : new Set(previous).add(key)));
    setFocusTarget({ key, view: targetView, line, nonce: Date.now() });
  }, []);
  const clearFocusTarget = useCallback((): void => {
    setFocusTarget(null);
  }, []);
  const explain: ExplainContext = useMemo(
    () => ({
      available: explainAvailable ?? true,
      functions: explainFunctions,
      evidence: evidenceIndex ?? new Map(),
      onFunctionCite,
    }),
    [explainAvailable, explainFunctions, evidenceIndex, onFunctionCite],
  );

  return (
    <section className="card detail-decompiler" aria-label="Functions">
      <h2>Functions</h2>
      <p className="decompiler-summary numeric" data-testid="decompiler-summary">
        {decompilerSummaryLine({
          total: countedTotal,
          named: countedNamed,
          partlyRead: countedPartly,
          jumps: summary.jumps,
        })}
      </p>
      <p className="muted decompiler-explain">
        Partly read means some internal jumps could not be followed yet. The functions still exist; only their insides
        are incomplete.
      </p>
      <div className="decompiler-filter">
        <label htmlFor={filterId}>Filter functions</label>
        <input
          id={filterId}
          className="input"
          type="search"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="decompiler-seg" role="group" aria-label="Function filter">
          {SEGMENTS.map((option) => (
            <button
              key={option.id}
              type="button"
              className="decompiler-seg-btn"
              aria-pressed={segment === option.id}
              onClick={() => setSegment(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="decompiler-count numeric" role="status">
          {decompilerCountLine(visible.length, all.length)}
        </p>
      </div>
      {visible.length === 0 ? (
        <p className="muted">No functions match this filter.</p>
      ) : (
        <ol className="decompiler-list" aria-label="Decompiled functions">
          {shown.map((fn, index) => {
            const key = fn.selector.toLowerCase();
            return (
              <DecompilerRow
                key={fn.selector}
                address={address}
                apiKey={apiKey}
                fn={fn}
                expert={expert}
                open={expanded.has(key)}
                onToggle={toggle}
                buttonId={`${listId}-${fn.selector}-button`}
                regionId={`${listId}-${fn.selector}-body`}
                index={index}
                registerButton={registerButton}
                codeView={initialView}
                codePc={initialPc}
                explain={explain}
                focusRequest={
                  focusTarget !== null && focusTarget.key === key
                    ? { view: focusTarget.view, line: focusTarget.line, nonce: focusTarget.nonce }
                    : null
                }
                onFocusConsumed={clearFocusTarget}
                onCopyWholeContract={copyWholeContract}
              />
            );
          })}
        </ol>
      )}
      {visible.length > ROW_LIMIT && !showAll ? (
        <button type="button" className="button-ghost decompiler-more" onClick={() => setShowAll(true)}>
          Show all {visible.length} functions
        </button>
      ) : null}
    </section>
  );
}
