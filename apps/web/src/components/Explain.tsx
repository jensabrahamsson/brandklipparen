// Accessible explanation trigger (S-113, K-021, K-103, K-507).
// A small focusable button beside the explained item. The text shows on
// hover, on keyboard focus and as a tap-to-toggle on touch; Escape closes
// it. The text lives in a role="tooltip" node linked from the trigger by
// aria-describedby, renders as React text only (never a markup sink).
// On the client the tooltip is portalled to <body> and positioned with
// position:fixed, so no ancestor card, animated section, overflow clip
// or stacking context can paint over it or push the page sideways.
// On narrow viewports it becomes a full-width sheet pinned to the
// bottom of the viewport (16 px gutters, safe-area aware). During SSR
// (no document) it renders inline as before, so server markup is stable.
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type JSX } from "react";
import { createPortal } from "react-dom";
import { explanationFor } from "../lib/explanations.ts";

function hoverAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches
  );
}

export type TooltipPlacement = {
  readonly sheet: boolean;
  readonly style: CSSProperties;
};

// Pure placement: clamp the tooltip inside the viewport with 16 px
// gutters. Narrow viewports (<= 640 px) get a bottom sheet; wider ones
// get a box below the trigger, flipped above when it would cross the
// bottom gutter. No transform is used, so no motion rule is involved.
export function tooltipPlacement(
  rect: { readonly top: number; readonly bottom: number; readonly left: number },
  viewport: { readonly width: number; readonly height: number },
  tip: { readonly width: number; readonly height: number },
): TooltipPlacement {
  if (viewport.width <= 640) {
    return {
      sheet: true,
      style: {
        left: 16,
        right: 16,
        bottom: "calc(16px + env(safe-area-inset-bottom, 0px))",
        top: "auto",
        width: "auto",
        maxWidth: "none",
      },
    };
  }
  const width = Math.min(tip.width > 0 ? tip.width : 280, 280, Math.max(0, viewport.width - 32));
  const left = Math.min(Math.max(16, rect.left - 8), Math.max(16, viewport.width - width - 16));
  const height = tip.height > 0 ? tip.height : 120;
  const below = rect.bottom + 6;
  const top = below + height <= viewport.height - 16 ? below : Math.max(16, rect.top - height - 6);
  return { sheet: false, style: { left, top, width: "max-content", maxWidth: `min(280px, ${Math.max(0, viewport.width - 32)}px)` } };
}

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

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
  const [mounted, setMounted] = useState(false);
  const [placement, setPlacement] = useState<TooltipPlacement | null>(null);
  const tooltipId = useId();
  const entry = explanationFor(explainKey);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLSpanElement | null>(null);
  // Last interaction modality: a tap fires focus (which must not pre-open)
  // before click (which toggles), while keyboard focus must open. Pointer
  // contact marks pointer; any key press marks keyboard, so Tab focus
  // after mouse use still opens.
  const modality = useRef<"keyboard" | "pointer">("keyboard");

  useEffect(() => {
    setMounted(true);
  }, []);

  useIsoLayoutEffect(() => {
    if (!open || !mounted) {
      setPlacement(null);
      return;
    }
    const update = (): void => {
      const wrap = wrapRef.current;
      if (wrap === null || typeof window === "undefined") {
        return;
      }
      const rect = wrap.getBoundingClientRect();
      const tip = tipRef.current;
      const next = tooltipPlacement(
        rect,
        { width: window.innerWidth, height: window.innerHeight },
        { width: tip?.offsetWidth ?? 0, height: tip?.offsetHeight ?? 0 },
      );
      setPlacement((previous) =>
        previous !== null && JSON.stringify(previous.style) === JSON.stringify(next.style) && previous.sheet === next.sheet
          ? previous
          : next,
      );
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, mounted]);

  const tooltip = open ? (
    <span
      role="tooltip"
      id={tooltipId}
      ref={tipRef}
      className={placement?.sheet ? "explain-tooltip explain-tooltip--sheet" : "explain-tooltip"}
      style={mounted && placement !== null ? placement.style : undefined}
    >
      <strong>{entry.title}</strong>
      <span>{entry.body}</span>
    </span>
  ) : null;

  const canPortal = mounted && typeof document !== "undefined" && document.body !== null;

  return (
    <span className="explain" ref={wrapRef}>
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
      {tooltip === null ? null : canPortal ? createPortal(tooltip, document.body) : tooltip}
    </span>
  );
}
