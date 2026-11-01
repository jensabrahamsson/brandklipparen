// One evidence row in the plugin detail view (UI v2 §5.3): where in
// the code a finding was seen. The name comes from the decompiler
// payload of the same analysis; the copy writes `selector@offset name`;
// the expand loads the readable snippet lazily, once per selector.
// Everything renders as inert text under the strict CSP: no HTML sink.
import { useId, useRef, useState, type CSSProperties, type JSX } from "react";
import { Pictogram } from "../Pictogram.tsx";
import { CopyButton } from "../CopyButton.tsx";
import { fetchSnippet, type SnippetResult } from "../../lib/api.ts";
import { useReducedMotion } from "../../lib/motion.ts";

export function offsetHex(offset: number | null): string {
  return offset === null ? "unknown" : `0x${offset.toString(16)}`;
}

// The clipboard text for an evidence row: `selector@offset name`, for
// example "0x095ea7b3@0x2140 approve(address,uint256)".
export function evidenceCopyText(selector: string, offset: number | null, displayName: string): string {
  return `${selector}@${offsetHex(offset)} ${displayName}`;
}

type SnippetState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly result: SnippetResult }
  | { readonly kind: "failed" };

const SNIPPET_LIMIT = 30;

function SnippetLines({ result }: { readonly result: SnippetResult }): JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const lines = showAll ? result.lines : result.lines.slice(0, SNIPPET_LIMIT);
  return (
    <div className="snippet">
      <ol className="snippet-lines">
        {lines.map((line) => (
          <li key={line.lineNumber} value={line.lineNumber} className="snippet-line">
            <span className="snippet-no" aria-hidden="true">
              {line.lineNumber}
            </span>{" "}
            <span className="snippet-text">{line.text}</span>
          </li>
        ))}
      </ol>
      {result.lines.length > SNIPPET_LIMIT && !showAll ? (
        <button type="button" className="button-ghost snippet-more" onClick={() => setShowAll(true)}>
          Show all {result.lines.length} lines
        </button>
      ) : null}
    </div>
  );
}

export function EvidenceRow({
  address,
  apiKey,
  selector,
  offset,
  displayName,
  shortName,
  named,
  expert,
  index,
  showInCodeId,
  onShowInCode,
}: {
  readonly address: string;
  readonly apiKey: string;
  readonly selector: string;
  readonly offset: number | null;
  // Row-1 name: the decompiler signature when known, else the fallback.
  readonly displayName: string;
  // Short name for the copy accessible name.
  readonly shortName: string;
  // True when the name came from the decompiler readout.
  readonly named: boolean;
  readonly expert: boolean;
  readonly index: number;
  // Line-link target (addendum §A1.4): when the expanded code view holds
  // the offset's line, this id plus handler render a "Show in code"
  // button that highlights and focuses it. Absent otherwise.
  readonly showInCodeId?: string | undefined;
  readonly onShowInCode?: (() => void) | null | undefined;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [snippet, setSnippet] = useState<SnippetState>({ kind: "idle" });
  const regionId = useId();
  const reduce = useReducedMotion();
  const loading = useRef(false);
  const offsetText = offsetHex(offset);

  const toggle = (): void => {
    const next = !expanded;
    setExpanded(next);
    if (next && snippet.kind === "idle" && !loading.current) {
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
    }
  };

  return (
    <li className="evidence-row" style={{ "--i": Math.min(index, 8) } as CSSProperties}>
      <div className="evidence-top">
        <span className="evidence-name" title={named ? "Name from the public selector table" : undefined}>
          {displayName}
        </span>
        <span className="evidence-at">
          at <span className="mono">{offsetText}</span>
        </span>
        <CopyButton
          value={evidenceCopyText(selector, offset, displayName)}
          label={`Copy evidence ${shortName} at ${offsetText}`}
          testId={`copy-evidence-${selector}-${offsetText}`}
        />
        <button
          type="button"
          className="icon-btn evidence-expand"
          aria-expanded={expanded}
          aria-controls={regionId}
          aria-label={`Readable code for ${displayName} at ${offsetText}`}
          onClick={toggle}
        >
          <Pictogram name={expanded ? "chevron-down" : "chevron-right"} size={18} />
        </button>
      </div>
      <p className="evidence-sub mono">
        {selector} · {displayName}
      </p>
      {expert ? (
        <p className="evidence-expert mono">
          PC {offsetText} · selector {selector}
        </p>
      ) : null}
      {showInCodeId !== undefined && onShowInCode !== null && onShowInCode !== undefined ? (
        <button type="button" id={showInCodeId} className="button-ghost evidence-code-link" onClick={onShowInCode}>
          Show in code
        </button>
      ) : null}
      {expanded ? (
        <div className="evidence-snippet" id={regionId} role="region" aria-label={`Readable code for ${displayName} at ${offsetText}`}>
          {snippet.kind === "loading" ? (
            <p role="status" className="scan-status">
              {reduce ? "Loading…" : "Scanning…"}
              {reduce ? null : <b className="cursor" aria-hidden="true" />}
            </p>
          ) : snippet.kind === "failed" ? (
            <p className="muted">Readable code is not available for this function.</p>
          ) : snippet.kind === "ready" ? (
            <SnippetLines result={snippet.result} />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
