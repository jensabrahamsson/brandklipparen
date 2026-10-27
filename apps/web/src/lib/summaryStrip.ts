import { useEffect, useState, type RefObject } from "react";

// Summary strip visibility rule for the token result view: on the Overview
// tab the compact strip appears only after the combined score ring has
// scrolled out of view, so it never covers the ring or the gauge cards.
export function ringOutOfView(isIntersecting: boolean | undefined): boolean {
  return isIntersecting === false;
}

// Shorten a code hash for the one-line strip. Short fixtures stay whole;
// long hashes keep a recognizable head and tail with the full value kept
// in the element title.
export function truncateHash(hash: string): string {
  if (hash.length <= 14) {
    return hash;
  }
  return `${hash.slice(0, 10)}…${hash.slice(-4)}`;
}

// Observes the combined score section and reports when it has left the
// viewport. observeKey re-subscribes when the observed node remounts (for
// example when switching tabs unmounts and remounts the Overview panel).
export function useRingOutOfView(ref: RefObject<Element | null>, observeKey: unknown = null): boolean {
  const [outOfView, setOutOfView] = useState(false);
  useEffect(() => {
    setOutOfView(false);
    const target = ref.current;
    if (target === null || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        setOutOfView(entry === undefined ? false : ringOutOfView(entry.isIntersecting));
      },
      { threshold: 0 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [ref, observeKey]);
  return outOfView;
}
