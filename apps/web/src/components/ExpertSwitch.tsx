// Expert view switch (UI v2 §1.4, K-034; round-3 D-19): the same shared
// `.switch` as Motion: a label, a 32x18 track with a knob, and the state
// word. Same `brandklipparen-ui-mode` key as before; Expert only shows
// already-fetched detail (selectors, raw payloads), never refetches.
// The box is 44 px on every width.
import type { JSX } from "react";
import type { UiMode } from "../lib/uiMode.ts";

export function ExpertSwitch({
  mode,
  onModeChange,
  testId = "expert-switch",
}: {
  readonly mode: UiMode;
  readonly onModeChange: (mode: UiMode) => void;
  readonly testId?: string | undefined;
}): JSX.Element {
  const expert = mode === "expert";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={expert}
      aria-label="Expert view"
      data-testid={testId}
      className="switch"
      onClick={() => onModeChange(expert ? "simple" : "expert")}
    >
      <span className="switch-label">Expert view</span>
      <span className="switch-track" aria-hidden="true">
        <span className="switch-knob" />
      </span>
      <span className="switch-state">{expert ? "On" : "Off"}</span>
    </button>
  );
}
