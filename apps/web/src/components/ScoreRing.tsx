import { useEffect, useState, type CSSProperties, type JSX } from "react";
import { riskBand } from "../lib/risk.ts";
import { reducedMotionRequested, useCountUp } from "../lib/motion.ts";

// Combined score dial 0-100 (Phosphor Console): 50 ticks around a core
// number with the band word, so the value survives without color
// (K-103). Ticks light once in sequence through colour and opacity
// only (34 ms stagger); the halo breathes; the number counts up once
// (1.7 s). Under reduced motion everything renders final at once.
const TICKS = 50;
const RADIUS_OUTER = 194;
const RADIUS_INNER = 166;
const CENTER = 200;

function tickEnds(index: number): { x1: number; y1: number; x2: number; y2: number } {
  const angle = (index / TICKS) * Math.PI * 2 - Math.PI / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x1: CENTER + cos * RADIUS_INNER,
    y1: CENTER + sin * RADIUS_INNER,
    x2: CENTER + cos * RADIUS_OUTER,
    y2: CENTER + sin * RADIUS_OUTER,
  };
}

export function ScoreRing({ score }: { readonly score: number }): JSX.Element {
  const band = riskBand(score);
  const bandClass = band.word === "Low" ? "low" : band.word === "Elevated" ? "elevated" : "high";
  const tickColor = band.word === "Low" ? "var(--low)" : band.word === "Elevated" ? "var(--amber)" : "var(--red)";
  const lit = Math.round((Math.min(100, Math.max(0, score)) / 100) * TICKS);
  const shown = useCountUp(score, 1700);
  // One-shot fill: ticks start unlit and flip to lit once on mount with
  // a per-tick transition delay. Under reduced motion the flag starts
  // lit, so the dial is instant and animation-free.
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
  return (
    <div
      role="img"
      aria-label={`Combined score ${score} of 100, ${band.word} risk`}
      className={`score-disc score-dial ${bandClass}`}
      style={{ "--tick": tickColor } as CSSProperties}
    >
      <svg viewBox="0 0 400 400" aria-hidden="true">
        <circle className="inner" cx={CENTER} cy={CENTER} r={150} />
        {Array.from({ length: TICKS }, (_, index) => {
          const ends = tickEnds(index);
          return (
            <line
              key={index}
              className={on && index < lit ? "tick lit" : "tick"}
              x1={ends.x1}
              y1={ends.y1}
              x2={ends.x2}
              y2={ends.y2}
              style={{ transitionDelay: `${index * 34}ms` }}
            />
          );
        })}
      </svg>
      <div className="core">
        <div className="halo" aria-hidden="true" />
        <div className="num numeric">{shown}</div>
        <div className="of">/100</div>
        <div className="bandtag">{band.word.toUpperCase()}</div>
      </div>
    </div>
  );
}
