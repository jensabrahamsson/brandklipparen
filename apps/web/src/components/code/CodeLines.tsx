// Numbered code lines (addendum §A1.5-§A1.6). One `<ol class="code">`
// holds one `<li>` per line: a real-text line number in a ch-wide
// gutter (screen readers hear "3, require(…)"), an optional gutter
// lamp slot, and tokenised code. Long lines wrap with a hanging
// indent (`--ind`); line numbers stay top-aligned and are never
// copied (user-select: none). No inner scroll, ever.
import type { CSSProperties, JSX } from "react";
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

export function CodeLines({
  idPrefix,
  lines,
  functionName,
  targetLine,
  evidenceLines,
  highlightLines,
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
  readonly gutterLampFor: (lineNumber: number) => GutterLamp | null;
  readonly renamedFrom: string | null;
  readonly expert: boolean;
  readonly lineRef: (lineNumber: number, element: HTMLLIElement | null) => void;
  readonly onLineFocus: (lineNumber: number | null) => void;
  readonly onLineHover: (lineNumber: number | null) => void;
}): JSX.Element {
  return (
    <ol className="code" aria-label={`Code lines for ${functionName}`}>
      {lines.map((line, index) => {
        const lamp = gutterLampFor(line.lineNumber);
        const isTarget = targetLine === line.lineNumber;
        const isEvidence = evidenceLines.has(line.lineNumber);
        const isHighlight = highlightLines.has(line.lineNumber);
        const leading = line.text.match(/^ */)?.[0].length ?? 0;
        const body = line.text.slice(leading);
        return (
          <li
            key={line.lineNumber}
            id={`${idPrefix}-line-${line.lineNumber}`}
            ref={(element) => lineRef(line.lineNumber, element)}
            tabIndex={-1}
            className={`code-line${isEvidence ? " is-evidence" : ""}${isTarget ? " is-target" : ""}${isHighlight ? " is-match" : ""}`}
            style={{ "--i": Math.min(index, 8), "--ind": leading } as CSSProperties}
            onFocus={() => onLineFocus(line.lineNumber)}
            onBlur={() => onLineFocus(null)}
            onMouseEnter={() => onLineHover(line.lineNumber)}
            onMouseLeave={() => onLineHover(null)}
          >
            {lamp === null ? (
              <span className="code-lamp-slot" aria-hidden="true" />
            ) : (
              <button type="button" className="code-lamp" aria-label={lamp.label} onClick={lamp.onActivate}>
                <Pictogram name="found" size={16} />
              </button>
            )}
            <span className="code-no" aria-hidden="true">
              {line.lineNumber}
            </span>{" "}
            <code className="code-text">
              {tokenizeCodeLine(body).map((token, tokenIndex) =>
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
      })}
    </ol>
  );
}
