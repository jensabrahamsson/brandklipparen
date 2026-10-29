// Reactive media-query flag (S-133): the verdict hero owns the risk
// breakdown only on wide screens, where the gauges sit beside the dial.
// Narrow screens keep the previous stacked layout untouched. The initial
// value reads the query synchronously so the first paint already matches;
// a listener follows resizes afterwards. No animation, no motion.
import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const list = window.matchMedia(query);
    const sync = (): void => setMatches(list.matches);
    sync();
    list.addEventListener("change", sync);
    return () => list.removeEventListener("change", sync);
  }, [query]);
  return matches;
}
