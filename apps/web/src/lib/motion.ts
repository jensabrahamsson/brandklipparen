// Shared reduced-motion flag for components that adapt to the viewer
// preference. Read once per mount: the reduced-motion e2e run sets the
// emulation before load, so the first read already carries the tested value.
import { useEffect, useState } from "react";

export function reducedMotionRequested(): boolean {
  // The Motion switch pins the same static end states as the operating
  // system setting (UI v2 §5.6): data-motion="off" counts as reduced.
  if (
    typeof document !== "undefined" &&
    document.documentElement?.dataset?.["motion"] === "off"
  ) {
    return true;
  }
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function useReducedMotion(): boolean {
  return reducedMotionRequested();
}

// One-shot count-up for scores and percents (Phosphor Console): eased
// over durationMs, then flat. Under reduced motion it renders the final
// value at once. Driven by requestAnimationFrame, so it never registers
// a Web Animation and stays invisible to document.getAnimations.
export function useCountUp(target: number, durationMs: number): number {
  const reduce = reducedMotionRequested();
  const [value, setValue] = useState(reduce ? target : 0);
  useEffect(() => {
    if (reduce) {
      setValue(target);
      return;
    }
    let frame = 0;
    const started = performance.now();
    const step = (now: number): void => {
      const progress = Math.min(1, (now - started) / durationMs);
      const eased = 1 - (1 - progress) ** 3;
      setValue(Math.round(target * eased));
      if (progress < 1) {
        frame = requestAnimationFrame(step);
      }
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs, reduce]);
  return value;
}
