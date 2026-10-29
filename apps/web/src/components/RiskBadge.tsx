import type { JSX } from "react";
import { riskBand, riskWord } from "../lib/risk.ts";
import { SegBar } from "./SegBar.tsx";

// Risk badge: segmented bar, number and word together (K-103), e.g.
// 10 ticks with 8 lit plus "84 High". Color never carries the meaning
// alone; High also reads as inverse video. Deliberately not a live
// region (design review P1-6): the TokenPage announces Analyzing to
// result once through a single polite status line instead.
export function RiskBadge({ score }: { readonly score: number }): JSX.Element {
  const band = riskBand(score);
  const className =
    band.word === "Low" ? "risk-badge risk-low numeric" : band.word === "Elevated" ? "risk-badge risk-elevated numeric" : "risk-badge risk-high numeric";
  return (
    <span className={className} data-testid="risk-badge" aria-label={`Risk score ${score}, ${band.word}`}>
      <SegBar filled={score / 10} />
      <strong>{score}</strong>
      <span className="risk-word">{riskWord(score)}</span>
    </span>
  );
}
