// Segmented score bars (Phosphor Console): N ticks, the lit share in
// the band colour with glow. Decorative: every reading also carries the
// number and the band word as text, so risk is never colour-only.
import type { JSX } from "react";

export function SegBar({ filled, total = 10 }: { readonly filled: number; readonly total?: number }): JSX.Element {
  const lit = Math.max(0, Math.min(total, Math.round(filled)));
  return (
    <span className="segs" aria-hidden="true">
      {Array.from({ length: total }, (_, index) => (
        <i key={index} className={index < lit ? "on" : undefined} />
      ))}
    </span>
  );
}
