// Shared reduced-motion flag for components that adapt to the viewer
// preference. Read once per mount: the reduced-motion e2e run sets the
// emulation before load, so the first read already carries the tested value.
export function reducedMotionRequested(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function useReducedMotion(): boolean {
  return reducedMotionRequested();
}
