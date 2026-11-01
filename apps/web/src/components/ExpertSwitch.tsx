// Expert view switch (UI v2 §1.4, K-034): one `role="switch"` in the
// toolbar and on plugin detail pages. Same `brandklipparen-ui-mode` key
// as before; Expert only shows already-fetched detail (selectors, raw
// payloads), never refetches. The box is 44 px on every width.
import type { JSX } from "react";
import { Pictogram } from "./Pictogram.tsx";
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
      className="expert-switch"
      onClick={() => onModeChange(expert ? "simple" : "expert")}
    >
      <span aria-hidden="true" className="expert-switch-icon">
        <Pictogram name="expert" size={20} />
      </span>
      Expert view
    </button>
  );
}
