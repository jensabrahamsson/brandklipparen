// One designed unavailable state for AI features (S-123): a neutral grey
// "Unavailable" pill with an outline icon (never the brand dot), one plain
// sentence, and a disabled primary button. The reason is linked from the
// button through aria-describedby so screen readers hear it. No operator
// instructions appear here: no env var names, no "set its key".
import { useId, type JSX } from "react";

export function FeatureUnavailable({
  title,
  reason,
  actionLabel,
}: {
  readonly title: string;
  readonly reason: string;
  readonly actionLabel: string;
}): JSX.Element {
  const reasonId = useId();
  return (
    <div>
      <p style={{ margin: "0 0 8px" }}>
        <span className="unavailable-pill">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          <span>
            {title}: Unavailable
          </span>
        </span>
      </p>
      <p id={reasonId} className="muted" style={{ margin: "0 0 12px" }}>
        {reason}
      </p>
      <button type="button" className="button" disabled aria-disabled="true" aria-describedby={reasonId}>
        {actionLabel}
      </button>
    </div>
  );
}
