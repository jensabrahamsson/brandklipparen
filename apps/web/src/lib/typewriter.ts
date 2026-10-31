// Typewriter reveal for the plugin detail status sentence and Muse
// status lines (UI v2 §5.6 M-4): JS slices the visible copy, 16 ms per
// tick, capped at 600 ms total (longer strings reveal in word-sized
// chunks), with a blinking block cursor while typing. The full text
// always stays in the accessibility tree, and under reduced motion the
// full text renders at once with no cursor. No Web Animation is ever
// registered, so the effect stays invisible to document.getAnimations.
import { useEffect, useState } from "react";
import { reducedMotionRequested } from "./motion.ts";

const TICK_MS = 16;
const BUDGET_MS = 600;

export type Typewriter = {
  // The visible slice; the caller renders the full text separately as
  // screen-reader-only text so the accessible name never changes.
  readonly shown: string;
  readonly done: boolean;
};

export function useTypewriter(text: string): Typewriter {
  const reduce = reducedMotionRequested();
  const [count, setCount] = useState(() => (reduce ? text.length : 0));
  useEffect(() => {
    if (reduce) {
      setCount(text.length);
      return;
    }
    if (text.length === 0) {
      return;
    }
    const ticks = Math.max(1, Math.floor(BUDGET_MS / TICK_MS));
    const chunk = Math.max(1, Math.ceil(text.length / ticks));
    let revealed = 0;
    const timer = window.setInterval(() => {
      revealed += chunk;
      if (revealed >= text.length) {
        window.clearInterval(timer);
        setCount(text.length);
        return;
      }
      setCount(revealed);
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [text, reduce]);
  return { shown: text.slice(0, count), done: count >= text.length };
}
