// Shared copy-to-clipboard button (S-134): one "Copied" announcement
// per copy through a single polite live region. The button keeps a real
// 44x44 tap box on touch (the global touch rule) while looking small;
// the visible confirmation is the button itself (Copy -> Copied, or
// Copy failed) through colour only for about 1.5 s with no movement,
// and stays static under reduced motion (no animation or transform).
// The live region is screen-reader-only so it reserves no layout space,
// and the accessible button name stays stable while it announces.
import { useEffect, useRef, useState, type JSX, type MouseEvent } from "react";

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
  const timer = useRef<number | null>(null);

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

  return (
    <span className="copy-wrap">
      <button
        type="button"
        className={`button-ghost copy-btn${state === "idle" ? "" : ` is-${state}`}`}
        aria-label={label}
        data-testid={testId}
        onClick={onClick}
      >
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
      </button>
      <span aria-live="polite" className="copy-status sr-only">
        {state === "copied" ? "Copied." : state === "failed" ? "Copy failed." : ""}
      </span>
    </span>
  );
}
