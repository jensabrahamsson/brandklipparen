// Owner-powers breakdown card (SCORE-6): the first card in the Risk
// breakdown row when a deterministic score floor — or renounced
// ownership — applies. It names the floor facts in plain words and the
// minimum score they set, so a first-time viewer sees why a HIGH score
// sits beside low pattern-model probabilities. Same card frame as the
// gauges; static under prefers-reduced-motion (no motion at all).
import type { JSX } from "react";
import type { AnalyzeSuccess } from "../types.ts";

// Human prefix per floor rule (SCORE-1): the governing group that sets
// the minimum, with the proven facts that feed it.
function factLineFor(scoreFloor: NonNullable<AnalyzeSuccess["scoreFloor"]>): string {
  const facts = scoreFloor.facts.join(", ");
  if (scoreFloor.rule === "owner-can-block-holders") {
    return `Owner can block holders: ${facts}`;
  }
  return `Owner has risky capability: ${facts}`;
}

export function FloorCard({
  scoreFloor,
  ownerState,
}: {
  readonly scoreFloor: AnalyzeSuccess["scoreFloor"];
  readonly ownerState: AnalyzeSuccess["ownerState"];
}): JSX.Element | null {
  if (scoreFloor !== undefined && scoreFloor !== null) {
    const bandClass = scoreFloor.minimum >= 60 ? "high" : scoreFloor.minimum >= 30 ? "elevated" : "low";
    const word = scoreFloor.minimum >= 60 ? "HIGH" : scoreFloor.minimum >= 30 ? "ELEVATED" : "LOW";
    const facts = factLineFor(scoreFloor);
    return (
      <section
        className={`card gauge floor-card ${bandClass}`}
        aria-label={`Owner powers: ${word}. ${facts}. Sets score floor: ${scoreFloor.minimum}.`}
        data-testid="floor-card"
      >
        <div className="gauge-top">
          <h3 className="lab" style={{ margin: "0 0 4px" }}>
            <span className="t">Owner powers</span>
          </h3>
          <span className="band">{word}</span>
        </div>
        <div className="pct" aria-hidden="true">
          {word}
        </div>
        <p className="floor-line">{facts}</p>
        <p className="floor-line floor-sub">{`Sets score floor: ${scoreFloor.minimum}.`}</p>
      </section>
    );
  }
  if (ownerState?.status === "renounced") {
    return (
      <section
        className="card gauge floor-card floor-muted"
        aria-label="Owner powers: owner renounced. Powers may still exist in code."
        data-testid="floor-card"
      >
        <div className="gauge-top">
          <h3 className="lab" style={{ margin: "0 0 4px" }}>
            <span className="t">Owner powers</span>
          </h3>
          <span className="band">Renounced</span>
        </div>
        <div className="pct" aria-hidden="true">
          Owner renounced
        </div>
        <p className="floor-line floor-sub">Powers may still exist in code.</p>
      </section>
    );
  }
  return null;
}
