import { useEffect, useState, type JSX } from "react";
import { riskBand } from "../lib/risk.ts";
import type { RiskKind } from "../types.ts";
import { reducedMotionRequested, useCountUp } from "../lib/motion.ts";

// One risk gauge (Phosphor Console): probability as a 20-segment bar
// that lights once (45 ms stagger, per-gauge offset), the percent
// counting up once (1.5 s), plus signal count and one plain-text
// reason. Number and band word travel together, so the reading never
// depends on colour alone. The gauge carries no "?" of its own (R2-5,
// D-17): the reason line beside it already explains it, and the shared
// help lives in the "Risk breakdown" heading popover.
const TITLES: Record<RiskKind, string> = {
  "rug-pull": "Rug pull",
  honeypot: "Honeypot",
  "bot-pump": "Bot-pump",
};

const SEGMENTS = 20;

export function Gauge({
  kind,
  probability,
  signalCount,
  reason,
}: {
  readonly kind: RiskKind;
  readonly probability: number;
  readonly signalCount: number;
  readonly reason: string;
}): JSX.Element {
  const percent = Math.round(probability * 100);
  const band = riskBand(percent);
  const bandClass = band.word === "Low" ? "low" : band.word === "Elevated" ? "elevated" : "high";
  const lit = Math.round(probability * SEGMENTS);
  const shown = useCountUp(percent, 1500);
  const reduce = reducedMotionRequested();
  const [on, setOn] = useState(reduce);
  useEffect(() => {
    if (reduce) {
      return;
    }
    let inner = 0;
    const frame = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setOn(true));
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(inner);
    };
  }, [reduce]);
  const signalWord = signalCount === 1 ? "signal" : "signals";
  return (
    <section className={`card gauge ${bandClass}`} aria-label={`${TITLES[kind]}: ${percent} percent`}>
      <div className="gauge-top">
        <h3 className="lab" style={{ margin: "0 0 4px" }}>
          <span className="t">{TITLES[kind]}</span>
        </h3>
        <span className="band">{band.word.toUpperCase()}</span>
      </div>
      <div className="pct numeric" role="img" aria-label={`${percent} percent probability`}>
        {shown}%
      </div>
      <div className="bar20" aria-hidden="true">
        {Array.from({ length: SEGMENTS }, (_, index) => (
          <i
            key={index}
            className={on && index < lit ? "lit" : undefined}
            style={{ transitionDelay: `${300 + index * 45}ms` }}
          />
        ))}
      </div>
      <p className="why">{reason}</p>
      <p className="cnt numeric">{signalCount === 0 ? "no signals" : `${signalCount} ${signalWord}`}</p>
    </section>
  );
}
