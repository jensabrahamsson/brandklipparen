// Verified-source empty states (addendum §A1.6). No verified source
// is an informative panel, never an error; a failed lookup is a
// different state with a retry, because "couldn't check" must never
// read as "no source". Sentence case throughout.
import type { JSX } from "react";
import { Pictogram } from "../Pictogram.tsx";

export function SourceEmpty({
  status,
  provider,
  block,
  onRetry,
  onShowDecompiled,
}: {
  readonly status: "none" | "unavailable";
  readonly provider: string;
  readonly block: number | null;
  readonly onRetry: (() => void) | null;
  readonly onShowDecompiled: (() => void) | null;
}): JSX.Element {
  if (status === "unavailable") {
    return (
      <div className="code-empty" role="status">
        <p className="code-empty-title">
          <span aria-hidden="true">
            <Pictogram name="notrun" size={20} />
          </span>{" "}
          Verified source is unavailable
        </p>
        <p className="code-empty-line">Couldn&apos;t reach {provider}. The decompiled code is unaffected.</p>
        {onRetry === null ? null : (
          <button type="button" className="button-ghost" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="code-empty" role="status">
      <p className="code-empty-title">
        <span aria-hidden="true">
          <Pictogram name="source" size={20} />
        </span>{" "}
        No verified source
      </p>
      <p className="code-empty-line">No source published.</p>
      <p className="code-empty-line">Read the decompiled code.</p>
      <p className="code-empty-line quiet">
        Checked {provider}
        {block === null ? "" : ` at block ${block}`}.
      </p>
      {onShowDecompiled === null ? null : (
        <button type="button" className="button-ghost" onClick={onShowDecompiled}>
          Show decompiled
        </button>
      )}
    </div>
  );
}
