// Numbered code lines (addendum §A1.5-§A1.6). One `<ol class="code">`
// holds one `<li>` per line: a real-text line number in a narrow
// gutter (screen readers hear "3, require(…)"), an optional gutter
// lamp slot, and tokenised code. Code lines never wrap: the list itself
// scrolls sideways (UI-7), so a long line keeps its shape and the page
// never scrolls sideways. Indentation (`--ind`) is applied as padding.
// Line numbers are never copied (user-select: none).
//
// C-29: each row is a memoised component fed only primitive props,
// so hover sweeps and typing ticks re-render only the rows whose
// data actually changed. Tokenising is memoised per row body. The
// hovered row highlights through CSS :hover; the React hover
// callback only feeds the cross-pane match highlight.
import { Fragment, memo, useCallback, useMemo, type CSSProperties, type JSX, type ReactNode } from "react";
import { Pictogram } from "../Pictogram.tsx";
import {
  hiddenChipText,
  isLongHex,
  shortHex,
  tokenizeCodeLine,
  type CodeRole,
} from "../../lib/codeTokens.ts";

export type CodeLineDatum = {
  readonly lineNumber: number;
  readonly text: string;
  readonly pcs: readonly number[];
};

export type GutterLamp = {
  readonly label: string;
  readonly onActivate: () => void;
  // Evidence lamps use the found glyph; Muse note markers use ✦.
  readonly pictogram?: "found" | "muse" | undefined;
};

function roleClass(role: CodeRole): string {
  return `tk-${role}`;
}

// A hex or code token: long hex shortens in display only (title and
// aria-label hold the full value); hidden characters render as chips.
function CodeToken({ text, role, expert }: { readonly text: string; readonly role: CodeRole; readonly expert: boolean }): JSX.Element {
  if (role === "hidden") {
    const point = hiddenChipText(text);
    return (
      <span className="tk-hidden" title={`Hidden character ${point}`} data-hidden={text}>
        {point}
      </span>
    );
  }
  if (role === "literal" && isLongHex(text) && !expert) {
    return (
      <span className={roleClass(role)} title={text} aria-label={text}>
        {shortHex(text)}
      </span>
    );
  }
  return <span className={roleClass(role)}>{text}</span>;
}

type CodeLineRowProps = {
  readonly idPrefix: string;
  readonly line: CodeLineDatum;
  readonly index: number;
  readonly isTarget: boolean;
  readonly isEvidence: boolean;
  readonly isHighlight: boolean;
  readonly isCited: boolean;
  readonly isLive: boolean;
  readonly lampLabel: string | null;
  readonly lampPictogram: "found" | "muse";
  readonly onLampActivate: (() => void) | null;
  readonly renamedFrom: string | null;
  readonly expert: boolean;
  readonly lineRef: (lineNumber: number, element: HTMLLIElement | null) => void;
  readonly onLineFocus: (lineNumber: number | null) => void;
  readonly onLineHover: (lineNumber: number | null) => void;
};

// Callbacks are excluded on purpose: every callback the row receives
// is an equivalent closure over a stable setter or ref plus the
// row's own line number (see CodeView's stable handlers), so a new
// callback identity with unchanged data props needs no re-render.
// The lamp activator only focuses a stable element id derived from
// the pane and note key, which the label comparison below covers.
function rowPropsEqual(previous: CodeLineRowProps, next: CodeLineRowProps): boolean {
  return (
    previous.idPrefix === next.idPrefix &&
    previous.line.lineNumber === next.line.lineNumber &&
    previous.line.text === next.line.text &&
    previous.index === next.index &&
    previous.isTarget === next.isTarget &&
    previous.isEvidence === next.isEvidence &&
    previous.isHighlight === next.isHighlight &&
    previous.isCited === next.isCited &&
    previous.isLive === next.isLive &&
    previous.lampLabel === next.lampLabel &&
    previous.lampPictogram === next.lampPictogram &&
    previous.renamedFrom === next.renamedFrom &&
    previous.expert === next.expert
  );
}

const CodeLineRow = memo(function CodeLineRow(props: CodeLineRowProps): JSX.Element {
  const {
    idPrefix,
    line,
    index,
    isTarget,
    isEvidence,
    isHighlight,
    isCited,
    isLive,
    lampLabel,
    lampPictogram,
    onLampActivate,
    renamedFrom,
    expert,
    lineRef,
    onLineFocus,
    onLineHover,
  } = props;
  const leading = line.text.match(/^ */)?.[0].length ?? 0;
  const body = line.text.slice(leading);
  const tokens = useMemo(() => tokenizeCodeLine(body), [body]);
  const ref = useCallback(
    (element: HTMLLIElement | null) => {
      lineRef(line.lineNumber, element);
    },
    [lineRef, line.lineNumber],
  );
  return (
    <li
      id={`${idPrefix}-line-${line.lineNumber}`}
      ref={ref}
      tabIndex={-1}
      className={`code-line${isEvidence ? " is-evidence" : ""}${isTarget ? " is-target" : ""}${isHighlight ? " is-match" : ""}${isCited ? " is-cited" : ""}${isLive ? " is-cited-live" : ""}`}
      style={{ "--i": Math.min(index, 8), "--ind": leading } as CSSProperties}
      onFocus={() => onLineFocus(line.lineNumber)}
      onBlur={() => onLineFocus(null)}
      onMouseEnter={() => onLineHover(line.lineNumber)}
      onMouseLeave={() => onLineHover(null)}
    >
      {lampLabel === null || onLampActivate === null ? (
        <span className="code-lamp-slot" aria-hidden="true" />
      ) : (
        <button type="button" className="code-lamp" aria-label={lampLabel} onClick={onLampActivate}>
          <Pictogram name={lampPictogram} size={16} />
        </button>
      )}
      <span className="code-no" aria-hidden="true">
        {line.lineNumber}
      </span>{" "}
      <code className="code-text">
        {tokens.map((token, tokenIndex) =>
          token.role === "name" && renamedFrom !== null && token.text === renamedFrom ? (
            <span key={tokenIndex} className="tk-name tk-renamed">
              {token.text}
            </span>
          ) : (
            <CodeToken key={tokenIndex} text={token.text} role={token.role} expert={expert} />
          ),
        )}
      </code>
    </li>
  );
}, rowPropsEqual);

export function CodeLines({
  idPrefix,
  lines,
  functionName,
  targetLine,
  evidenceLines,
  highlightLines,
  citedLines,
  liveLines,
  noteAfterLine,
  gutterLampFor,
  renamedFrom,
  expert,
  lineRef,
  onLineFocus,
  onLineHover,
}: {
  readonly idPrefix: string;
  readonly lines: readonly CodeLineDatum[];
  readonly functionName: string;
  readonly targetLine: number | null;
  readonly evidenceLines: ReadonlySet<number>;
  readonly highlightLines: ReadonlySet<number>;
  // VS-2 read-along: faint cited background for settled sentences and
  // the live style while a sentence types. Absent without an overlay.
  readonly citedLines?: ReadonlySet<number> | undefined;
  readonly liveLines?: ReadonlySet<number> | undefined;
  // VS-2 interleaved notes (<1600 px): a note node after its range, or
  // null. Absent without an overlay or at margin widths. Notes render
  // outside the memoised row so typing updates still reach them.
  readonly noteAfterLine?: ((lineNumber: number) => ReactNode | null) | undefined;
  readonly gutterLampFor: (lineNumber: number) => GutterLamp | null;
  readonly renamedFrom: string | null;
  readonly expert: boolean;
  readonly lineRef: (lineNumber: number, element: HTMLLIElement | null) => void;
  readonly onLineFocus: (lineNumber: number | null) => void;
  readonly onLineHover: (lineNumber: number | null) => void;
}): JSX.Element {
  return (
    // The list scrolls sideways, so it takes a tab stop of its own: a
    // keyboard user can reach the hidden end of a long line.
    <ol className="code" tabIndex={0} aria-label={`Code lines for ${functionName}`}>
      {lines.map((line, index) => {
        const lamp = gutterLampFor(line.lineNumber);
        const note = noteAfterLine?.(line.lineNumber) ?? null;
        return (
          <Fragment key={line.lineNumber}>
            <CodeLineRow
              idPrefix={idPrefix}
              line={line}
              index={index}
              isTarget={targetLine === line.lineNumber}
              isEvidence={evidenceLines.has(line.lineNumber)}
              isHighlight={highlightLines.has(line.lineNumber)}
              isCited={citedLines?.has(line.lineNumber) ?? false}
              isLive={liveLines?.has(line.lineNumber) ?? false}
              lampLabel={lamp?.label ?? null}
              lampPictogram={lamp?.pictogram ?? "found"}
              onLampActivate={lamp === null ? null : lamp.onActivate}
              renamedFrom={renamedFrom}
              expert={expert}
              lineRef={lineRef}
              onLineFocus={onLineFocus}
              onLineHover={onLineHover}
            />
            {note}
          </Fragment>
        );
      })}
    </ol>
  );
}
