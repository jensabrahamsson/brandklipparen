// Readable template explanation (S-120, S-134): every claim renders as
// one short summary first, labelled with its template version.
// Temporality reads as a "Can change" chip or "applies now"; the
// controlling account shows in full with copy; the raw locations sit in
// a keyboard-operable disclosure grouped by selector. Signal links
// expand and scroll to their signal in SignalList. Everything renders
// as React text only, so hostile content stays inert: no HTML sinks
// anywhere.
import type { JSX } from "react";
import { signalKey, signalTitle } from "../lib/signals.ts";
import { claimSummary, evidenceLocationCount, extractAccount, extractEvidenceGroups } from "../lib/claims.ts";
import type { ExplanationClaim, Signal } from "../types.ts";
import { Explain } from "./Explain.tsx";
import { CopyButton } from "./CopyButton.tsx";

function AccountChip({ address }: { readonly address: string }): JSX.Element {
  return (
    <span className="mono numeric" style={{ fontSize: 13 }}>
      Account{" "}
      <span className="addr-full" data-testid="claim-account-full">
        {address}
      </span>{" "}
      <CopyButton value={address} label="Copy account address" />
    </span>
  );
}

function ClaimEvidence({ text }: { readonly text: string }): JSX.Element | null {
  const groups = extractEvidenceGroups(text);
  if (groups.length === 0) {
    return null;
  }
  const locations = evidenceLocationCount(groups);
  return (
    <details style={{ marginTop: 8 }}>
      <summary>
        Evidence · {locations} {locations === 1 ? "location" : "locations"}
      </summary>
      <ul className="mono" style={{ listStyle: "none", padding: 0, fontSize: 13 }}>
        {groups.map((group) => (
          <li key={`${group.selector}|${group.line ?? ""}|${group.snippet ?? ""}`} style={{ marginBottom: 8 }}>
            <span>{group.selector}</span>
            {group.offsets.length > 0 ? (
              <span className="quiet">
                {" "}
                · offsets {group.offsets.map((offset) => `0x${offset.toString(16)}`).join(", ")}
              </span>
            ) : null}
            {group.hasNoOffset ? <span className="quiet"> · no byte offset</span> : null}
            {group.snippet === null || group.line === null ? null : (
              <div className="quiet">
                decompiled line {group.line} reads &quot;{group.snippet}&quot;
              </div>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function ExplanationList({
  claims,
  signals,
  templateVersion,
  expert,
  onSignalLink,
}: {
  readonly claims: readonly ExplanationClaim[];
  readonly signals: readonly Signal[];
  readonly templateVersion: string;
  readonly expert: boolean;
  readonly onSignalLink: (key: string) => void;
}): JSX.Element {
  const versionLine =
    expert === true
      ? `Template explanation · v${templateVersion}`
      : "Template explanation";
  return (
    <section className="card" aria-label={versionLine} style={{ marginBottom: 20 }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>
        <span>Why this score</span> <Explain explainKey="explanation:claim" label="Template claims" />
      </h2>
      <p className="quiet numeric" style={{ margin: "0 0 12px" }}>
        {versionLine} · {claims.length} {claims.length === 1 ? "claim" : "claims"}
      </p>
      {claims.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          No template claims for this result.
        </p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {claims.map((claim, index) => {
            const account = extractAccount(claim.text);
            return (
              <li key={`${claim.text.slice(0, 32)}-${index}`} style={{ marginBottom: 12 }}>
                <div className="claim-text">{claimSummary(claim.text)}</div>
                <div className="quiet" style={{ marginTop: 4 }}>
                  {claim.temporality.kind === "applies-now" ? (
                    "applies now"
                  ) : (
                    <span className="chip">Owner can turn this on later</span>
                  )}
                  {account === null ? null : (
                    <>
                      {" · "}
                      <AccountChip address={account} />
                    </>
                  )}
                  {claim.signalLinks.length > 0 ? (
                    <>
                      {" · signals: "}
                      {claim.signalLinks.map((signalId, linkIndex) => {
                        const targetIndex = signals.findIndex((signal) => signal.id === signalId);
                        if (targetIndex < 0) {
                          return null;
                        }
                        const target = signals[targetIndex] as Signal;
                        const key = signalKey(target, targetIndex);
                        return (
                          <span key={`${signalId}-${linkIndex}`}>
                            {linkIndex > 0 ? ", " : null}
                            <button
                              type="button"
                              className="button-ghost"
                              style={{ border: "none", padding: 0, fontSize: 12 }}
                              onClick={() => onSignalLink(key)}
                            >
                              {signalTitle(target)}
                            </button>
                          </span>
                        );
                      })}
                    </>
                  ) : null}
                </div>
                <ClaimEvidence text={claim.text} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
