// Pending scan status (UI v2 §5.6 M-8): the waiting line for snippet,
// proof, Explain, Ask and investigation requests. While the request is
// pending it shows the text with a blinking block cursor and three tiny
// lamps breathing on a 3 s period with 0 / 1 / 2 s phase offsets. The
// whole line unmounts on completion, so the loops never outlive the
// wait. Under reduced motion it renders the static text only. Glow
// comes from the elevation tokens only.
import type { JSX } from "react";
import { useReducedMotion } from "../lib/motion.ts";

export function ScanStatus({ text }: { readonly text: string }): JSX.Element {
  const reduce = useReducedMotion();
  if (reduce) {
    return (
      <p role="status" className="scan-status">
        {text}
      </p>
    );
  }
  return (
    <p role="status" className="scan-status">
      <span>{text}</span>
      <b className="cursor" aria-hidden="true" />
      <span className="scan-lamps" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </p>
  );
}
