// Pointer-driven card tilt (S-114, K-021, K-103).
// Small pure helpers plus one delegated hook: the page marks tilt-ready
// cards with data-tilt and one container listener steers the hovered card
// through CSS variables, one style write per animation frame, so there is
// no layout thrash and no re-render. Text stays flat: only the card plane
// rotates a few degrees, never the glyphs themselves. Reduced motion
// disables the hook entirely; CSS carries the matching static fallback.
import { useEffect, useRef } from "react";

// Maximum tilt in either axis: a calm few degrees, never a flip.
export const MAX_TILT_DEG = 4;

export function clampTilt(degrees: number): number {
  if (degrees > MAX_TILT_DEG) {
    return MAX_TILT_DEG;
  }
  if (degrees < -MAX_TILT_DEG) {
    return -MAX_TILT_DEG;
  }
  return degrees;
}

// CSS variables for the hovered card from pointer ratios in [0, 1].
// Reduced motion answers with no variables, so the card stays flat.
export function tiltVars(ratioX: number, ratioY: number, reducedMotion: boolean): Record<string, string> {
  if (reducedMotion) {
    return {};
  }
  const clampedX = Math.min(1, Math.max(0, ratioX));
  const clampedY = Math.min(1, Math.max(0, ratioY));
  return {
    "--tilt-ry": `${clampTilt((clampedX - 0.5) * 2 * MAX_TILT_DEG).toFixed(2)}deg`,
    "--tilt-rx": `${clampTilt((0.5 - clampedY) * 2 * MAX_TILT_DEG).toFixed(2)}deg`,
  };
}

function reducedMotionRequested(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function clearCard(card: HTMLElement): void {
  card.style.removeProperty("--tilt-rx");
  card.style.removeProperty("--tilt-ry");
  card.classList.remove("tilt-live");
}

// Delegated tilt for a container of [data-tilt] cards. Pointer position
// maps to card-relative ratios; the single rAF write touches only CSS
// variables on the hovered card, so scrolling and layout stay untouched.
export function useTiltGroup<T extends HTMLElement>(): React.RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const root = ref.current;
    if (root === null || reducedMotionRequested()) {
      return;
    }
    let frame = 0;
    let current: HTMLElement | null = null;
    const onMove = (event: PointerEvent): void => {
      const target = (event.target as HTMLElement | null)?.closest?.("[data-tilt]") as HTMLElement | null;
      if (target === null || !root.contains(target)) {
        return;
      }
      const rect = target.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return;
      }
      const ratioX = (event.clientX - rect.left) / rect.width;
      const ratioY = (event.clientY - rect.top) / rect.height;
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
      current = target;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (current === null || !current.isConnected) {
          return;
        }
        const vars = tiltVars(ratioX, ratioY, false);
        for (const [name, value] of Object.entries(vars)) {
          current.style.setProperty(name, value);
        }
        current.classList.add("tilt-live");
      });
    };
    const onLeave = (): void => {
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
      if (current !== null) {
        clearCard(current);
        current = null;
      }
    };
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerleave", onLeave);
    return () => {
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
    };
  }, []);
  return ref;
}

// Shared reduced-motion flag for components that switch rendering
// (the investigate graph renders flat 2D when this is true). Read once
// per mount: the reduced-motion e2e run sets the emulation before load,
// so the first read already carries the tested value.
export function useReducedMotion(): boolean {
  return reducedMotionRequested();
}
