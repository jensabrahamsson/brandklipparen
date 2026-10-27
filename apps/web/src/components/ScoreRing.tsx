import type { JSX } from "react";
import { riskBand } from "../lib/risk.ts";

// Combined score ring 0-100 (K-021): an SVG arc in the band color with the
// number and word as text, so the value survives without color (K-103).
export function ScoreRing({ score }: { readonly score: number }): JSX.Element {
  const band = riskBand(score);
  const color = band.word === "Low" ? "var(--low)" : band.word === "Elevated" ? "var(--elevated)" : "var(--high)";
  const radius = 64;
  const circumference = 2 * Math.PI * radius;
  const filled = (Math.min(100, Math.max(0, score)) / 100) * circumference;
  return (
    <div role="img" aria-label={`Combined score ${score} of 100, ${band.word} risk`}>
      <svg width="168" height="168" viewBox="0 0 168 168">
        <circle cx="84" cy="84" r={radius} fill="none" stroke="var(--border)" strokeWidth="14" />
        <circle
          cx="84"
          cy="84"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="14"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference}`}
          transform="rotate(-90 84 84)"
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
