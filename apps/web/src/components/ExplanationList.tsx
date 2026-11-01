// The single score card (round-2 review D-5): every scored pattern in
// one place with its severity rail, plain sentence and evidence rows.
// The card owns at most one Explain trigger, on the heading. When the
// analysis scores nothing, the card says so in one line; the extended
// findings stay linked from the hero strip and the board below.
// Everything renders as React text only, so hostile content stays
// inert: no HTML sinks anywhere.
import type { JSX } from "react";
import type { SelectorName } from "../lib/selectorNames.ts";
import type { ExplanationClaim, Signal } from "../types.ts";
import { Explain } from "./Explain.tsx";
import { SignalRows } from "./SignalList.tsx";

export function ExplanationList({
  claims,
  signals,
  templateVersion,
  expert,
  address,
  codeHash,
  apiKey,
  names,
  bandHigh,
}: {
  readonly claims: readonly ExplanationClaim[];
  readonly signals: readonly Signal[];
  readonly templateVersion: string;
  readonly expert: boolean;
  readonly address: string;
  readonly codeHash: string;
  readonly apiKey: string;
  readonly names: ReadonlyMap<string, SelectorName>;
  // True when the token band is High: filled severity tags stay reserved
  // for High tokens (round-3 review D-11).
  readonly bandHigh?: boolean | undefined;
}): JSX.Element {
  if (signals.length === 0 && claims.length === 0) {
    return <EmptyWhyScore />;
  }
  const count = signals.length;
  const noun = count === 1 ? "pattern" : "patterns";
  const subline = expert ? `Scored patterns · v${templateVersion} · ${count} ${noun}` : `${count} scored ${noun}`;
  return (
    <section className="card" aria-label="Why this score" style={{ marginBottom: 20 }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>
        <span>Why this score</span> <Explain explainKey="explanation:claim" label="Why this score" />
      </h2>
      <p className="quiet numeric" style={{ margin: "0 0 12px" }}>
        {subline}
      </p>
      <SignalRows
        signals={signals}
        claims={claims}
        expert={expert}
        address={address}
        codeHash={codeHash}
        apiKey={apiKey}
        names={names}
        bandHigh={bandHigh}
      />
    </section>
  );
}

function EmptyWhyScore(): JSX.Element {
  return (
    <section className="card" aria-label="Why this score" style={{ marginBottom: 20 }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>
        <span>Why this score</span> <Explain explainKey="explanation:claim" label="Why this score" />
      </h2>
      <p className="muted" style={{ margin: 0 }}>
        No pattern raised the score.
      </p>
    </section>
  );
}
