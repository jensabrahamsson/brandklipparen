import type { JSX } from "react";
import { riskBand, riskWord } from "../lib/risk.ts";

// Risk badge: number and word together (K-103), e.g. "84 High".
// Color never carries the meaning alone. Deliberately not a live region
// (design review P1-6): the TokenPage announces Analyzing-to-result once
// through a single polite status line instead.
export function RiskBadge({ score }: { readonly score: number }): JSX.Element {
  const band = riskBand(score);
  const className =
    band.word === "Low" ? "risk-badge risk-low numeric" : band.word === "Elevated" ? "risk-badge risk-elevated numeric" : "risk-badge risk-high numeric";
  return (
    <span className={className} data-testid="risk-badge" aria-label={`Risk score ${score}, ${band.word}`}>
      <strong>{score}</strong>
      <span>{riskWord(score)}</span>
    </span>
  );
}
