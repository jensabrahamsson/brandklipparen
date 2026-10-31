// Accessible explanation trigger (S-113, K-021, K-103, K-507).
// A small focusable button beside the explained item. The text shows on
// hover, on keyboard focus and as a tap-to-toggle on touch; Escape closes
// it. The text lives in a role="tooltip" node linked from the trigger by
// aria-describedby, renders as React text only (never a markup sink), and
// sits below the trigger so it never covers the numbers beside it.
import { useId, useRef, useState, type JSX } from "react";
import { explanationFor } from "../lib/explanations.ts";

function hoverAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches
  );
}

export function Explain({
  explainKey,
  label,
  defaultOpen = false,
}: {
  readonly explainKey: string;
  readonly label: string;
  readonly defaultOpen?: boolean | undefined;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const tooltipId = useId();
  const entry = explanationFor(explainKey);
  // Last interaction modality: a tap fires focus (which must not pre-open)
  // before click (which toggles), while keyboard focus must open. Pointer
  // contact marks pointer; any key press marks keyboard, so Tab focus
  // after mouse use still opens.
  const modality = useRef<"keyboard" | "pointer">("keyboard");
  return (
    <span className="explain">
      <button
        type="button"
        className="explain-trigger"
        data-testid={`explain-${explainKey}`}
        aria-label={`Explain ${label}`}
        aria-expanded={open}
        aria-describedby={open ? tooltipId : undefined}
        onClick={() => setOpen((value) => !value)}
        onMouseEnter={() => {
          if (hoverAvailable()) {
            setOpen(true);
          }
        }}
        onMouseLeave={() => {
          if (hoverAvailable()) {
            setOpen(false);
          }
        }}
        onFocus={() => {
          if (modality.current === "keyboard") {
            setOpen(true);
          }
        }}
        onBlur={() => setOpen(false)}
        onPointerDown={() => {
          modality.current = "pointer";
        }}
        onKeyDown={(event) => {
          modality.current = "keyboard";
          if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      >
        <span className="q" aria-hidden="true">
          ?
        </span>
      </button>
      {open ? (
        <span role="tooltip" id={tooltipId} className="explain-tooltip">
          <strong>{entry.title}</strong>
          <span>{entry.body}</span>
        </span>
      ) : null}
    </span>
  );
}
