import type { JSX } from "react";
import { riskBand } from "../lib/risk.ts";
import type { RiskKind } from "../types.ts";
import { Explain } from "./Explain.tsx";

// One risk gauge (K-021): probability as a half-arc, signal count and one
// plain-text reason. No needle, no gradients: an arc in the band color.
const TITLES: Record<RiskKind, string> = {
  "rug-pull": "Rug pull",
  honeypot: "Honeypot",
  "bot-pump": "Bot-pump",
};

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
  const color = band.word === "Low" ? "var(--low)" : band.word === "Elevated" ? "var(--elevated)" : "var(--high)";
  const signalWord = signalCount === 1 ? "signal" : "signals";
  return (
    <section className="card gauge" aria-label={`${TITLES[kind]} gauge: ${percent} percent`}>
      <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>
        <span>{TITLES[kind]}</span> <Explain explainKey={`score:gauge:${kind}`} label={`${TITLES[kind]} gauge`} />
      </h3>
      <p className="quiet numeric" style={{ margin: "0 0 12px" }}>
        {signalCount} {signalWord}
      </p>
      <svg width="140" height="84" viewBox="0 0 140 84" role="img" aria-label={`${percent} percent probability`}>
        <path d="M 14 76 A 56 56 0 0 1 126 76" fill="none" stroke="var(--border-strong)" strokeWidth="12" strokeLinecap="round" />
        <path
          d="M 14 76 A 56 56 0 0 1 126 76"
          fill="none"
          stroke={color}
          strokeWidth="12"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${percent} 100`}
        />
        <text x="70" y="66" textAnchor="middle" fill="var(--text)" fontSize="26" fontWeight="600" className="numeric">
          {percent}%
        </text>
      </svg>
      <p className="muted numeric" style={{ margin: "8px 0 0", fontSize: 14 }}>
        {reason}
      </p>
    </section>
  );
}
