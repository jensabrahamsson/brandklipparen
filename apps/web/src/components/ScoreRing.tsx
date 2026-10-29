import { useEffect, useState, type CSSProperties, type JSX } from "react";
import { riskBand } from "../lib/risk.ts";
import { reducedMotionRequested } from "../lib/motion.ts";

// Combined score ring 0-100 (K-021): an SVG arc in the band color with the
// number and word as text, so the value survives without color (K-103).
// The static material treatment (S-121) is a radial inner disc behind the
// arc plus a soft band-coloured glow on the arc itself. Both are static:
// no animation, no transform on hover. (The rotate attribute only moves
// the arc start to the top; it carries no CSS transform or motion.)
export function ScoreRing({ score }: { readonly score: number }): JSX.Element {
  const band = riskBand(score);
  const color = band.word === "Low" ? "var(--low)" : band.word === "Elevated" ? "var(--elevated)" : "var(--high)";
  const glow =
    band.word === "Low"
      ? "color-mix(in srgb, var(--low) 30%, transparent)"
      : band.word === "Elevated"
        ? "color-mix(in srgb, var(--elevated) 30%, transparent)"
        : "color-mix(in srgb, var(--high) 30%, transparent)";
  const radius = 64;
  const circumference = 2 * Math.PI * radius;
  const filled = (Math.min(100, Math.max(0, score)) / 100) * circumference;
  // One-shot draw (S-122): the arc opens from 0 to the value once on
  // mount over --dur-slow. Under reduced motion it renders final at once,
  // so the ring is instant and animation-free.
  const reduce = reducedMotionRequested();
  const [drawn, setDrawn] = useState(reduce);
  useEffect(() => {
    if (reduce) {
      return;
    }
    let inner = 0;
    const frame = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setDrawn(true));
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(inner);
    };
  }, [reduce]);
  const dash = drawn ? filled : 0;
  return (
    <div role="img" aria-label={`Combined score ${score} of 100, ${band.word} risk`} className="score-disc">
      <svg width="168" height="168" viewBox="0 0 168 168">
        <circle cx="84" cy="84" r={radius} fill="none" stroke="var(--border-strong)" strokeWidth="14" />
        <circle
          cx="84"
          cy="84"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="14"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
          transform="rotate(-90 84 84)"
          className="score-arc"
          style={{ "--arc-glow": glow } as CSSProperties}
        />
        <text x="84" y="82" textAnchor="middle" fill="var(--text)" fontSize="40" fontWeight="600" className="numeric">
          {score}
        </text>
        <text x="84" y="106" textAnchor="middle" fill="var(--text-2)" fontSize="13">
          of 100
        </text>
      </svg>
      <div className="numeric" style={{ textAlign: "center", fontWeight: 600 }}>
        {score} {band.word}
      </div>
    </div>
  );
}
