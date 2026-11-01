// The single score card (round-2 review D-5): every scored pattern in
// one place with its severity rail, plain sentence and evidence rows.
// The card owns at most one Explain trigger, on the heading. When the
// analysis scores nothing, the card names the extended findings with
// links to their detail views instead of showing two empty cards.
// Everything renders as React text only, so hostile content stays
// inert: no HTML sinks anywhere.
import type { JSX } from "react";
import type { SelectorName } from "../lib/selectorNames.ts";
import type { ExplanationClaim, Signal } from "../types.ts";
import { pluginHref } from "../lib/pluginCopy.ts";
import type { BoardTile } from "./plugins/PluginBoard.tsx";
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
  extendedTiles,
  allIds,
}: {
  readonly claims: readonly ExplanationClaim[];
  readonly signals: readonly Signal[];
  readonly templateVersion: string;
  readonly expert: boolean;
  readonly address: string;
  readonly codeHash: string;
  readonly apiKey: string;
  readonly names: ReadonlyMap<string, SelectorName>;
  readonly extendedTiles: readonly BoardTile[];
  readonly allIds: readonly string[];
}): JSX.Element {
  if (signals.length === 0 && claims.length === 0) {
    return (
      <EmptyWhyScore address={address} extendedTiles={extendedTiles} allIds={allIds} />
    );
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
      />
    </section>
  );
}

function EmptyWhyScore({
  address,
  extendedTiles,
  allIds,
}: {
  readonly address: string;
  readonly extendedTiles: readonly BoardTile[];
  readonly allIds: readonly string[];
}): JSX.Element {
  const extended = extendedTiles.filter((tile) => tile.state === "extended");
  return (
    <section className="card" aria-label="Why this score" style={{ marginBottom: 20 }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>
        <span>Why this score</span> <Explain explainKey="explanation:claim" label="Why this score" />
      </h2>
      {extended.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          No scored pattern found in the code we could read.
        </p>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          No scored pattern. Extended analysis found {extended.length} more (not in score):{" "}
          {extended.map((tile, index) => (
            <span key={tile.pluginId}>
              {index > 0 ? ", " : null}
              <a href={pluginHref(address, tile.pluginId, allIds)}>{tile.copy.title}</a>
            </span>
          ))}
          .
        </p>
      )}
    </section>
  );
}
