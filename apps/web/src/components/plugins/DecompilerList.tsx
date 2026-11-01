// Decompiler function list (UI v2 §5.4, W-6): collapsed per-function
// rows with a summary, a filter, a segmented control, the spec order,
// lazy pseudo-code with pc-level line links (addendum §A1.4), the entry
// evidence row and Expert raw. The route `<selector>` auto-expands and
// focuses its row. Motion is row stagger (M-5), rail ignite plus one
// scanline flicker (M-6) and the approved 180 ms height expand (X-1);
// static under prefers-reduced-motion. Sentence case throughout, and
// the raw cause string never renders outside Expert raw.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type JSX } from "react";
import { Pictogram } from "../Pictogram.tsx";
import { CodeView } from "../code/CodeView.tsx";
import { fetchSnippet } from "../../lib/api.ts";
import { useCountUp, useReducedMotion } from "../../lib/motion.ts";
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
// decompiled and verified-source panes, pc-level line links and the
// entry evidence row. Display text only; the raw cause never renders
// here (it stays in Expert raw below).
function FunctionBody({
  address,
  apiKey,
  fn,
  expert,
  codeView,
  codePc,
  onCopyWholeContract,
}: {
  readonly address: string;
  readonly apiKey: string;
  readonly fn: DecompilerFunction;
  readonly expert: boolean;
  readonly codeView: CodePaneView | undefined;
  readonly codePc: number | undefined;
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
        onCopyWholeContract={onCopyWholeContract}
      />
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
  codeView,
  codePc,
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
  readonly reduce: boolean;
  readonly registerButton: (selector: string, element: HTMLButtonElement | null) => void;
  readonly codeView: CodePaneView | undefined;
  readonly codePc: number | undefined;
  readonly onCopyWholeContract: (() => Promise<string>) | undefined;
}): JSX.Element {
  const [grown, setGrown] = useState(false);
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
                codeView={codeView}
                codePc={codePc}
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

export function DecompilerList({
  address,
  apiKey,
  findings,
  expert,
  initialSelector,
  initialView,
  initialPc,
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
    await navigator.clipboard.writeText(text);
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
                codeView={initialView}
                codePc={initialPc}
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
