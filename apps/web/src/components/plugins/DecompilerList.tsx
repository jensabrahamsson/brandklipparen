// Decompiler function list (UI v2 §5.4, W-6): collapsed per-function
// rows with a summary, a filter, a segmented control, the spec order,
// lazy pseudo-code with pc-level line links (addendum §A1.4), the entry
// evidence row and Expert raw. The route `<selector>` auto-expands and
// focuses its row. Motion is row stagger (M-5), rail ignite plus one
// scanline flicker (M-6) and the approved 180 ms height expand (X-1);
// static under prefers-reduced-motion. Sentence case throughout, and
// the raw cause string never renders outside Expert raw.
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type JSX } from "react";
import { Pictogram } from "../Pictogram.tsx";
import { EvidenceRow } from "./EvidenceRow.tsx";
import { fetchSnippet, type SnippetResult } from "../../lib/api.ts";
import { useCountUp, useReducedMotion } from "../../lib/motion.ts";
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
const SNIPPET_LIMIT = 30;

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

type SnippetState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly result: SnippetResult }
  | { readonly kind: "failed" };

// Expanded function body: pseudo-code with pc-level line links plus the
// entry evidence row (addendum §A1.4). The evidence offset highlights
// its line through "Show in code" (rendered inside the evidence row),
// and evidence lines carry a gutter lamp back to that button. Without
// pcs every line is function-level only and the honest note names that.
// Display text only; the raw cause never renders here.
function FunctionBody({
  address,
  apiKey,
  fn,
  expert,
  showInCodeId,
}: {
  readonly address: string;
  readonly apiKey: string;
  readonly fn: DecompilerFunction;
  readonly expert: boolean;
  readonly showInCodeId: string;
}): JSX.Element {
  const [snippet, setSnippet] = useState<SnippetState>({ kind: "idle" });
  const [linesOpen, setLinesOpen] = useState(false);
  const [targetLine, setTargetLine] = useState<number | null>(null);
  const reduce = useReducedMotion();
  const loading = useRef(false);
  const lineRefs = useRef(new Map<number, HTMLLIElement>());

  useEffect(() => {
    if (snippet.kind !== "idle" || loading.current) {
      return;
    }
    loading.current = true;
    setSnippet({ kind: "loading" });
    const key = apiKey.length === 0 ? null : apiKey;
    fetchSnippet(address, fn.selector, key).then(
      (result) => {
        loading.current = false;
        setSnippet({ kind: "ready", result });
      },
      () => {
        loading.current = false;
        setSnippet({ kind: "failed" });
      },
    );
  }, [snippet, address, fn.selector, apiKey]);

  if (snippet.kind === "loading") {
    return (
      <p role="status" className="scan-status">
        {reduce ? "Loading…" : "Scanning…"}
        {reduce ? null : <b className="cursor" aria-hidden="true" />}
      </p>
    );
  }
  if (snippet.kind === "failed" || snippet.kind === "idle") {
    return <p className="muted">Readable code is not available for this function.</p>;
  }
  const lines = snippet.result.lines;
  const hasPcs = lines.some((line) => line.pcs.length > 0);
  const entryLine =
    fn.entryPc === null ? null : (lines.find((line) => line.pcs.includes(fn.entryPc as number)) ?? null);
  const shown = linesOpen ? lines : lines.slice(0, SNIPPET_LIMIT);
  const showInCode = (): void => {
    if (entryLine === null) {
      return;
    }
    setTargetLine(entryLine.lineNumber);
    lineRefs.current.get(entryLine.lineNumber)?.focus({ preventScroll: true });
    lineRefs.current.get(entryLine.lineNumber)?.scrollIntoView({ block: "nearest" });
  };
  const entryHex = fn.entryPc === null ? "unknown" : `0x${fn.entryPc.toString(16)}`;
  return (
    <div className="decompiler-code">
      <ol className="snippet-lines code-lines">
        {shown.map((line, index) => {
          const isEvidence = entryLine !== null && entryLine.lineNumber === line.lineNumber;
          const isTarget = targetLine === line.lineNumber;
          return (
            <li
              key={line.lineNumber}
              id={`${showInCodeId}-line-${line.lineNumber}`}
              ref={(element) => {
                if (element === null) {
                  lineRefs.current.delete(line.lineNumber);
                } else {
                  lineRefs.current.set(line.lineNumber, element);
                }
              }}
              tabIndex={-1}
              className={`snippet-line code-line${isEvidence ? " is-evidence" : ""}${isTarget ? " is-target" : ""}`}
              style={{ "--i": Math.min(index, 8) } as CSSProperties}
            >
              {isEvidence ? (
                <button
                  type="button"
                  className="code-lamp"
                  aria-label={`Evidence at ${entryHex}: back to the evidence row`}
                  onClick={() => document.getElementById(showInCodeId)?.focus()}
                >
                  <Pictogram name="found" size={16} />
                </button>
              ) : null}
              <span className="snippet-no" aria-hidden="true">
                {line.lineNumber}
              </span>{" "}
              <span className="snippet-text">{line.text}</span>
            </li>
          );
        })}
      </ol>
      {lines.length > SNIPPET_LIMIT && !linesOpen ? (
        <button type="button" className="button-ghost snippet-more" onClick={() => setLinesOpen(true)}>
          Show all {lines.length} lines
        </button>
      ) : null}
      {!hasPcs || entryLine === null ? (
        <p className="muted code-link-note">Linked by function. Line-level links need a newer server.</p>
      ) : null}
      <ol className="evidence-list decompiler-evidence">
        <EvidenceRow
          address={address}
          apiKey={apiKey}
          selector={fn.selector}
          offset={fn.entryPc}
          displayName={fn.displayName}
          shortName={fn.name ?? fn.displayName}
          named={fn.named}
          expert={expert}
          index={0}
          showInCodeId={entryLine === null ? undefined : showInCodeId}
          onShowInCode={entryLine === null ? null : showInCode}
        />
      </ol>
    </div>
  );
}

// One collapsed row plus its expanded body (UI v2 §5.4): the plain
// sentence, pseudo-code, the entry evidence row and Expert raw. The
// expand wrapper animates grid-template-rows 0fr to 1fr (X-1); collapse
// unmounts at once. Expanding never scrolls, so nothing above the row
// moves.
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
  reduce,
  registerButton,
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
  readonly reduce: boolean;
  readonly registerButton: (selector: string, element: HTMLButtonElement | null) => void;
}): JSX.Element {
  const [grown, setGrown] = useState(false);
  const showInCodeId = useId();
  useEffect(() => {
    if (!open || reduce) {
      setGrown(false);
      return;
    }
    const frame = requestAnimationFrame(() => setGrown(true));
    return () => {
      cancelAnimationFrame(frame);
      setGrown(false);
    };
  }, [open, reduce]);
  const expanded = open && (reduce || grown);
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
                showInCodeId={showInCodeId}
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

export function DecompilerList({
  address,
  apiKey,
  findings,
  expert,
  initialSelector,
}: {
  readonly address: string;
  readonly apiKey: string;
  readonly findings: readonly PluginFindingView[];
  readonly expert: boolean;
  // Route `<selector>` (UI v2 §1.3): this row starts expanded and focused.
  readonly initialSelector?: string | undefined;
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
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => {
    const initial = normalizeSelector(initialSelector);
    if (initial === null) {
      return new Set();
    }
    return all.some((fn) => fn.selector.toLowerCase() === initial) ? new Set([initial]) : new Set();
  });
  const reduce = useReducedMotion();
  const filterId = useId();
  const listId = useId();
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    const initial = normalizeSelector(initialSelector);
    if (initial === null) {
      return;
    }
    buttons.current.get(initial)?.focus();
  }, [initialSelector]);

  const visible = useMemo(() => filterDecompilerFunctions(all, query, segment), [all, query, segment]);
  const shown = showAll ? visible : visible.slice(0, ROW_LIMIT);
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
                reduce={reduce}
                registerButton={registerButton}
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
