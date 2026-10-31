// Copy icon-button (UI v2 §4): a 44x44 transparent box with an 18 px
// copy pictogram, not a text button. Hover and keyboard focus show an
// absolutely positioned "Copy" bubble (fine pointers only, so touch
// focus never pops it); the bubble is the confirmation too ("Copied"
// / "Copy failed", touch included) and never shifts layout. The glyph
// swaps to check/cross with a one-shot glow, the box never changes
// size, the accessible name stays stable, and a single polite live
// region announces once per copy. Copy writes the exact unspaced
// EIP-55 string, never the grouped display. Static under
// prefers-reduced-motion (glyph swap only).
import { useEffect, useId, useRef, useState, type JSX, type MouseEvent } from "react";
import { Pictogram } from "./Pictogram.tsx";

// One announcement per copy through the button's polite live region.
// The accessible button name stays stable; only this text changes.
export function copyStatusText(label: string, state: "idle" | "copied" | "failed"): string {
  if (state === "copied") {
    return `${label.replace(/^Copy\b/, "Copied")}.`;
  }
  if (state === "failed") {
    return "Copy failed.";
  }
  return "";
}

function hoverAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches
  );
}

export function CopyButton({
  value,
  label,
  testId,
}: {
  readonly value: string;
  readonly label: string;
  readonly testId?: string | undefined;
}): JSX.Element {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const [hoverTip, setHoverTip] = useState(false);
  const [focusTip, setFocusTip] = useState(false);
  const timer = useRef<number | null>(null);
  const tipId = useId();
  // Last interaction modality: a tap fires focus (which must not pre-open
  // the idle bubble) before click, while keyboard focus must open it.
  const modality = useRef<"keyboard" | "pointer">("keyboard");

  useEffect(() => {
    return () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
    };
  }, []);

  const scheduleReset = (): void => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
    }
    timer.current = window.setTimeout(() => setState("idle"), 1500);
  };

  const onClick = (event: MouseEvent<HTMLButtonElement>): void => {
    // Live rows stretch their link over the whole row: keep the copy
    // click from navigating.
    event.stopPropagation();
    event.preventDefault();
    const write = async (): Promise<void> => {
      try {
        if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
          throw new Error("clipboard unavailable");
        }
        await navigator.clipboard.writeText(value);
        setState("copied");
      } catch {
        setState("failed");
      } finally {
        scheduleReset();
      }
    };
    void write();
  };

  const tip = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy";
  const showTip = state !== "idle" || hoverTip || focusTip;

  return (
    <span className="copy-wrap">
      <button
        type="button"
        className="icon-btn copy-btn"
        aria-label={label}
        aria-describedby={showTip ? tipId : undefined}
        data-state={state}
        data-testid={testId}
        onClick={onClick}
        onMouseEnter={() => {
          if (hoverAvailable()) {
            setHoverTip(true);
          }
        }}
        onMouseLeave={() => setHoverTip(false)}
        onFocus={() => {
          if (modality.current === "keyboard") {
            setFocusTip(true);
          }
        }}
        onBlur={() => setFocusTip(false)}
        onPointerDown={() => {
          modality.current = "pointer";
        }}
        onKeyDown={() => {
          modality.current = "keyboard";
        }}
      >
        {state === "copied" ? (
          <Pictogram name="check" size={18} />
        ) : state === "failed" ? (
          <Pictogram name="cross" size={18} />
        ) : (
          <Pictogram name="copy" size={18} />
        )}
      </button>
      {showTip ? (
        <span role="tooltip" id={tipId} className="copy-tip">
          {tip}
        </span>
      ) : null}
      <span aria-live="polite" className="copy-status sr-only">
        {copyStatusText(label, state)}
      </span>
    </span>
  );
}
