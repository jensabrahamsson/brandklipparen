import type { JSX, ReactNode } from "react";
import { plainReason, riskLabel, signalKey, signalTitle } from "../lib/signals.ts";
import { selectorDisplayName, selectorShortName, type SelectorName } from "../lib/selectorNames.ts";
import type { ExplanationClaim, Signal } from "../types.ts";
import { claimSummary, extractAccount } from "../lib/claims.ts";
import { toChecksumAddress } from "../lib/checksumAddress.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Pictogram } from "./Pictogram.tsx";
import { EvidenceRow } from "./plugins/EvidenceRow.tsx";

// Merged score rows (round-2 review D-5): one row per scored signal with
// the severity tag, the plain claim sentence and an evidence disclosure.
// The sentence severity always matches the row signal severity, and any
// inline code in claims renders as code without raw backticks. Every
// contract-derived string renders as React text only, so hostile content
// stays inert: no HTML sinks anywhere in this view.
//
// Identity (S-116): the REST layer may repeat signal ids within one
// response, so articles, DOM ids and open state key on the stable
// position-derived signal key, never on the signal id.

export function severityClass(severity: Signal["severity"]): "high" | "medium" | "low" {
  if (severity === "high") {
    return "high";
  }
  if (severity === "low") {
    return "low";
  }
  return "medium";
}

// The claim sentence carries a severity note; strip it so the sentence
// never repeats what the row tag already says (round-3 review D-11).
// Row severity still parses from the raw claim text via
// severityFromClaim, so stripping here loses no information.
export function withSignalSeverity(sentence: string): string {
  return sentence.replace(/ \(severity (low|medium|high)\)/gi, "");
}

// Plain-language strength for the row tag (round-3 review D-11): the
// tag names the risk and the strength, never a bare severity word.
export function signalStrengthWord(severity: Signal["severity"]): string {
  const level = severityClass(severity);
  if (level === "high") {
    return "Strong signal";
  }
  if (level === "low") {
    return "Weak signal";
  }
  return "Moderate signal";
}

// Inline code spans: split on backticks and wrap the fenced parts in
// code elements, so no backtick ever reaches the page. React text only.
export function renderInlineCode(text: string): readonly ReactNode[] {
  return text.split("`").map((part, index) =>
    index % 2 === 1 ? (
      <code key={index} className="inline-code">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

type RowPair = {
  readonly signal: Signal | null;
  readonly signalIndex: number;
  readonly claim: ExplanationClaim | null;
};

// Pair each signal with its claim by risk, then by position (S-116):
// duplicate signal ids can never misattribute evidence because ids are
// never the lookup key. Claims left over after pairing render as extra
// rows with the severity their own text names.
function pairRows(signals: readonly Signal[], claims: readonly ExplanationClaim[]): readonly RowPair[] {
  const used = new Array<boolean>(claims.length).fill(false);
  const rows: RowPair[] = signals.map((signal, signalIndex) => {
    const needle = signal.risk.toLowerCase();
    let pick = -1;
    for (let index = 0; index < claims.length; index += 1) {
      if (!used[index] && (claims[index] as ExplanationClaim).text.toLowerCase().includes(needle)) {
        pick = index;
        break;
      }
    }
    if (pick < 0) {
      for (let index = 0; index < claims.length; index += 1) {
        if (!used[index]) {
          pick = index;
          break;
        }
      }
    }
    if (pick < 0) {
      return { signal, claim: null, signalIndex };
    }
    used[pick] = true;
    return { signal, claim: claims[pick] as ExplanationClaim, signalIndex };
  });
  for (let index = 0; index < claims.length; index += 1) {
    if (!used[index]) {
      rows.push({ signal: null, signalIndex: -1, claim: claims[index] as ExplanationClaim });
    }
  }
  return rows;
}

function severityFromClaim(text: string): Signal["severity"] {
  const match = /\(severity (low|medium|high)\)/i.exec(text);
  const word = match?.[1]?.toLowerCase();
  if (word === "high" || word === "low" || word === "medium") {
    return word;
  }
  return "medium";
}

function AccountChip({ address }: { readonly address: string }): JSX.Element {
  const checksummed = toChecksumAddress(address);
  return (
    <span className="mono numeric" style={{ fontSize: 13 }}>
      Account{" "}
      <span className="addr-full" data-testid="claim-account-full">
        {checksummed}
      </span>{" "}
      <CopyButton value={checksummed} label="Copy account address" />
    </span>
  );
}

function Temporality({ claim }: { readonly claim: ExplanationClaim }): JSX.Element {
  const account = extractAccount(claim.text);
  return (
    <div className="quiet" style={{ marginTop: 4 }}>
      {claim.temporality.kind === "applies-now" ? (
        account === null ? (
          "Applies now"
        ) : (
          <>
            Applies now
            {" · "}
            <span className="chip">
              Owner <AccountChip address={account} /> can change this
            </span>
          </>
        )
      ) : claim.temporality.kind === "can-change-unknown" ? (
        "Owner-controlled · owner not read yet"
      ) : account === null ? (
        <span className="chip">Owner can change this</span>
      ) : (
        <span className="chip">
          Owner <AccountChip address={account} /> can change this
        </span>
      )}
    </div>
  );
}

export function SignalRows({
  signals,
  claims,
  expert,
  address,
  codeHash,
  apiKey,
  names,
  bandHigh,
}: {
  readonly signals: readonly Signal[];
  readonly claims: readonly ExplanationClaim[];
  readonly expert: boolean;
  readonly address: string;
  readonly codeHash: string;
  readonly apiKey: string;
  readonly names: ReadonlyMap<string, SelectorName>;
  // True when the token band is High. A red fill reads as the token's
  // own alarm, so filled severity tags render only on High tokens;
  // Low and Elevated tokens get outline tags (round-3 review D-11).
  readonly bandHigh?: boolean | undefined;
}): JSX.Element {
  const filled = bandHigh === true;
  const rows = pairRows(signals, claims);

  return (
    <div>
      <ol className="why-rows">
        {rows.map((row, index) => {
          const signal = row.signal;
          const claim = row.claim;
          const severity = signal?.severity ?? (claim === null ? "medium" : severityFromClaim(claim.text));
          const sevClass = severityClass(severity);
          const strength = signalStrengthWord(severity);
          const key = signal === null ? `claim-${index}` : signalKey(signal, row.signalIndex);
          const title = signal === null ? null : signalTitle(signal);
          const sentence =
            claim === null
              ? signal === null
                ? ""
                : plainReason(signal)
              : withSignalSeverity(claimSummary(claim.text));
          // A fallback sentence that only repeats the title adds noise
          // (round-3 review D-11), so the body renders only when it says
          // more than the title.
          const body = sentence === "" || sentence === title ? null : sentence;
          const tag = signal === null ? strength : `${riskLabel(signal.risk)} · ${strength.toLowerCase()}`;
          const entries = signal?.evidence ?? [];
          return (
            <li key={key} className={`why-row sev-${sevClass}`}>
              <article id={`signal-${key}`} className="why-article">
                <span className={`sev ${sevClass}${filled ? "" : " ghost"}`}>{tag}</span>
                {title === null ? null : <p className="why-title">{title}</p>}
                {body === null ? null : <p className="claim-text">{renderInlineCode(body)}</p>}
                {claim === null ? null : <Temporality claim={claim} />}
                {entries.length === 0 ? null : (
                  <details className="why-evidence">
                    <summary>
                      <span className="chev chev-closed" aria-hidden="true">
                        <Pictogram name="chevron-right" size={18} />
                      </span>
                      <span className="chev chev-open" aria-hidden="true">
                        <Pictogram name="chevron-down" size={18} />
                      </span>
                      <span>
                        Evidence · {entries.length} {entries.length === 1 ? "place" : "places"}
                      </span>
                    </summary>
                    <ol className="evidence-list">
                      {entries.map((entry, entryIndex) => (
                        <EvidenceRow
                          key={`${entry.selector}-${String(entry.offset)}-${entryIndex}`}
                          address={address}
                          apiKey={apiKey}
                          selector={entry.selector}
                          offset={entry.offset}
                          displayName={selectorDisplayName(entry.selector, names)}
                          shortName={selectorShortName(entry.selector, names)}
                          named={names.has(entry.selector.toLowerCase())}
                          expert={expert}
                          index={entryIndex}
                        />
                      ))}
                    </ol>
                  </details>
                )}
                {signal === null || expert !== true ? null : (
                  <div style={{ marginTop: 8 }}>
                    <CopyButton
                      value={JSON.stringify(
                        { address, codeHash, signal: signal.id, evidence: signal.evidence },
                        null,
                        2,
                      )}
                      label="Copy evidence JSON"
                    />
                  </div>
                )}
              </article>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
