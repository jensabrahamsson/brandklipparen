import { useState, type JSX, type ReactNode } from "react";
import { plainReason, signalKey, signalTitle } from "../lib/signals.ts";
import { selectorDisplayName, selectorShortName, type SelectorName } from "../lib/selectorNames.ts";
import type { ExplanationClaim, Signal } from "../types.ts";
import { claimSummary, extractAccount } from "../lib/claims.ts";
import { toChecksumAddress } from "../lib/checksumAddress.ts";
import { CopyButton } from "./CopyButton.tsx";
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

export function severityWord(severity: Signal["severity"]): string {
  const level = severityClass(severity);
  if (level === "high") {
    return "HIGH";
  }
  if (level === "low") {
    return "LOW";
  }
  return "MED";
}

// The claim sentence carries its own severity note; rewrite it to the
// row signal severity so the title and the sentence can never disagree.
export function withSignalSeverity(sentence: string, severity: Signal["severity"]): string {
  return sentence.replace(/\(severity (low|medium|high)\)/i, `(severity ${severityClass(severity)})`);
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
        "Possible in code · no controlling account found"
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
}: {
  readonly signals: readonly Signal[];
  readonly claims: readonly ExplanationClaim[];
  readonly expert: boolean;
  readonly address: string;
  readonly codeHash: string;
  readonly apiKey: string;
  readonly names: ReadonlyMap<string, SelectorName>;
}): JSX.Element {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const rows = pairRows(signals, claims);

  const copyEvidence = async (key: string, signal: Signal): Promise<void> => {
    const payload = JSON.stringify(
      { address, codeHash, signal: signal.id, evidence: signal.evidence },
      null,
      2,
    );
    try {
      await navigator.clipboard.writeText(payload);
      setCopiedId(key);
    } catch {
      // Clipboard is a convenience only; the JSON stays readable in-view.
    }
  };

  return (
    <div>
      <p aria-live="polite" className="quiet" style={{ position: "absolute", left: -9999 }}>
        {copiedId === null ? "" : `Evidence for ${copiedId} copied.`}
      </p>
      <ol className="why-rows">
        {rows.map((row, index) => {
          const signal = row.signal;
          const claim = row.claim;
          const severity = signal?.severity ?? (claim === null ? "medium" : severityFromClaim(claim.text));
          const sevClass = severityClass(severity);
          const key = signal === null ? `claim-${index}` : signalKey(signal, row.signalIndex);
          const title = signal === null ? null : signalTitle(signal);
          const sentence =
            claim === null
              ? signal === null
                ? ""
                : plainReason(signal)
              : withSignalSeverity(claimSummary(claim.text), severity);
          const entries = signal?.evidence ?? [];
          return (
            <li key={key} className={`why-row sev-${sevClass}`}>
              <article id={`signal-${key}`} className="why-article">
                <span className={`sev ${sevClass}`}>{severityWord(severity)}</span>
                {title === null ? null : <p className="why-title">{title}</p>}
                <p className="claim-text">{renderInlineCode(sentence)}</p>
                {claim === null ? null : <Temporality claim={claim} />}
                {entries.length === 0 ? null : (
                  <details className="why-evidence">
                    <summary>
                      Evidence · {entries.length} {entries.length === 1 ? "place" : "places"}
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
                {signal === null ? null : (
                  <div style={{ marginTop: 8 }}>
                    <button type="button" className="button-ghost" onClick={() => void copyEvidence(key, signal)}>
                      Copy evidence
                    </button>
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
