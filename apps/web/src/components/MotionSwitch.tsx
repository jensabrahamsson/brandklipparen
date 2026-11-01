// Motion on/off switch (UI v2 §5.6, W-10, WCAG 2.2.2). One
// `role="switch"` in the page footer: on follows the operating-system
// setting, off pins `data-motion="off"` on <html> so every auto-starting
// loop (the tube shimmer, the dial halo, pending cursors) stops. Same
// `brandklipparen-motion` key as the footer on both pages. The box is
// 44 px on every width.
import { useEffect, useState, type JSX } from "react";
import { applyMotionPref, readStoredMotion, writeStoredMotion, type MotionPref } from "../lib/motionPref.ts";

export function MotionSwitch({ testId = "motion-switch" }: { readonly testId?: string | undefined }): JSX.Element {
  const [motion, setMotion] = useState<MotionPref>(() => readStoredMotion());
  useEffect(() => {
    applyMotionPref(motion);
  }, [motion]);
  const on = motion === "on";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Motion"
      data-testid={testId}
      className="motion-switch"
      onClick={() => {
        const next: MotionPref = on ? "off" : "on";
        setMotion(next);
        writeStoredMotion(next);
      }}
    >
      <span className="motion-switch-state" aria-hidden="true">
        {on ? "On" : "Off"}
      </span>
      Motion
    </button>
  );
}
