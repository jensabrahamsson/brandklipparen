// Animations on/off switch, shown only in Settings: one shared
// `.switch`: a label, a 32x18 track with a knob, and the state word.
// The knob side swaps without a position transition (instant
// justify-content change; colour-only transitions), so there is no
// movement. The box is 44 px on every width.
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
      aria-label="Animations"
      data-testid={testId}
      className="switch"
      onClick={() => {
        const next: MotionPref = on ? "off" : "on";
        setMotion(next);
        writeStoredMotion(next);
      }}
    >
      <span className="switch-label">Animations</span>
      <span className="switch-track" aria-hidden="true">
        <span className="switch-knob" />
      </span>
      <span className="switch-state">{on ? "On" : "Off"}</span>
    </button>
  );
}
