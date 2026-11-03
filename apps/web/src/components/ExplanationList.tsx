// The single score card (round-2 review D-5): every scored pattern in
// one place with its severity rail, plain sentence and evidence rows.
// The card owns at most one Explain trigger, on the heading. When the
// analysis scores nothing, the card says so in one line; the extended
// findings stay linked from the hero strip and the board below.
// Everything renders as React text only, so hostile content stays
// inert: no HTML sinks anywhere.
import type { JSX } from "react";
import type { SelectorName } from "../lib/selectorNames.ts";
import type { AnalyzeSuccess } from "../types.ts";
import type { ExplanationClaim, Signal } from "../types.ts";
import { toChecksumAddress } from "../lib/checksumAddress.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Explain } from "./Explain.tsx";
import { SignalRows } from "./SignalList.tsx";

type ScoreFloor = NonNullable<AnalyzeSuccess["scoreFloor"]>;
type OwnerState = NonNullable<AnalyzeSuccess["ownerState"]>;

// SCORE-6: the floor leads Why-this-score in plain words, so the card
// never reads "Nothing raised the score." on a floored HIGH token
// without saying what set the minimum.
export function floorLeadSentence(floor: ScoreFloor): string {
  const facts = floor.facts.join(", ");
  const what =
    floor.rule === "owner-can-block-holders" ? `Owner can block holders (${facts})` : `Owner has risky capability (${facts})`;
  return `${what}. Sets score floor: ${floor.minimum}.`;
}

// SCORE-6: renounced ownership names the getter, the address and the
// block, so the reader sees the powers exist in code but no longer
// apply.
export function renouncedLeadSentence(ownerState: OwnerState | null | undefined): string | null {
  if (ownerState?.status !== "renounced" || ownerState.getter === null || ownerState.address === null) {
    return null;
  }
  return `Owner powers may exist in code, but the owner is renounced (${ownerState.getter} returns ${toChecksumAddress(ownerState.address)} at block ${ownerState.block}).`;
}

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
  block,
  scoreFloorLabel,
  scoreFloor,
  ownerState,
}: {
  readonly claims: readonly ExplanationClaim[];
  readonly signals: readonly Signal[];
  readonly templateVersion: string;
  readonly expert: boolean;
  readonly address: string;
  readonly codeHash: string;
  readonly apiKey: string;
  readonly names: ReadonlyMap<string, SelectorName>;
  readonly block?: number | undefined;
  // True when the token band is High: filled severity tags stay reserved
  // for High tokens (round-3 review D-11).
  readonly bandHigh?: boolean | undefined;
  // Deterministic floor behind the score (SCORE-1), shown verbatim in
  // the score explanation area when a floor rule applies. Superseded by
  // `scoreFloor`, which renders the plain-words lead sentence.
  readonly scoreFloorLabel?: string | undefined;
  // SCORE-6: the structured floor and owner state. When present, the
  // card leads with the floor (or the renounced line) instead of the
  // raw label.
  readonly scoreFloor?: ScoreFloor | undefined;
  readonly ownerState?: OwnerState | undefined;
}): JSX.Element {
  const lead = scoreFloor === undefined ? null : floorLeadSentence(scoreFloor);
  const renounced = scoreFloor === undefined ? renouncedLeadSentence(ownerState) : null;
  const showLabel = scoreFloorLabel !== undefined && lead === null;
  if (signals.length === 0 && claims.length === 0 && lead === null && renounced === null) {
    if (!showLabel) {
      return <EmptyWhyScore />;
    }
    return (
      <section className="card" aria-label="Why this score" style={{ marginBottom: 20 }}>
        <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>
          <span>Why this score</span> <Explain explainKey="explanation:claim" label="Why this score" />
        </h2>
        <p className="muted" style={{ margin: "0 0 12px" }}>
          Nothing raised the score.
        </p>
        <p className="muted score-floor" style={{ margin: 0 }}>
          {scoreFloorLabel}
        </p>
      </section>
    );
  }
  if (signals.length === 0 && claims.length === 0) {
    return (
      <section className="card" aria-label="Why this score" style={{ marginBottom: 20 }}>
        <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>
          <span>Why this score</span> <Explain explainKey="explanation:claim" label="Why this score" />
        </h2>
        {lead === null && renounced === null ? (
          <p className="muted" style={{ margin: "0 0 12px" }}>
            Nothing raised the score.
          </p>
        ) : (
          <p className="muted score-floor" style={{ margin: "0 0 12px" }}>
            {lead ?? renounced}
            {renounced !== null && ownerState !== undefined && ownerState.address !== null ? (
              <>
                {" "}
                <CopyButton value={toChecksumAddress(ownerState.address)} label="Copy owner address" />
              </>
            ) : null}
          </p>
        )}
        {lead === null && renounced === null ? null : (
          <p className="muted" style={{ margin: 0 }}>
            Nothing raised the score.
          </p>
        )}
      </section>
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
      {lead === null && renounced === null ? null : (
        <p className="muted score-floor" style={{ margin: "0 0 12px" }}>
          {lead ?? renounced}
          {renounced !== null && ownerState !== undefined && ownerState.address !== null ? (
            <>
              {" "}
              <CopyButton value={toChecksumAddress(ownerState.address)} label="Copy owner address" />
            </>
          ) : null}
        </p>
      )}
      <p className="quiet numeric" style={{ margin: "0 0 12px" }}>
        {subline}
      </p>
      {showLabel ? (
        <p className="muted score-floor" style={{ margin: "0 0 12px" }}>
          {scoreFloorLabel}
        </p>
      ) : null}
      <SignalRows
        signals={signals}
        claims={claims}
        expert={expert}
        address={address}
        codeHash={codeHash}
        apiKey={apiKey}
        names={names}
        bandHigh={bandHigh}
        block={block}
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
        Nothing raised the score.
      </p>
    </section>
  );
}
