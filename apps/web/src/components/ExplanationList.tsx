import type { JSX } from "react";
import type { ExplanationClaim } from "../types.ts";

// Full template explanation (design review P0-4): every claim renders,
// labelled with its template version. Temporality uses plain words, and
// each signal link expands and scrolls to its signal in SignalList.
export function ExplanationList({
  claims,
  templateVersion,
  onSignalLink,
}: {
  readonly claims: readonly ExplanationClaim[];
  readonly templateVersion: string;
  readonly onSignalLink: (signalId: string) => void;
}): JSX.Element {
  return (
    <section className="card" aria-label={`Template explanation · v${templateVersion}`} style={{ marginBottom: 20 }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>Why this score</h2>
      <p className="quiet numeric" style={{ margin: "0 0 12px" }}>
        Template explanation · v{templateVersion} · {claims.length} {claims.length === 1 ? "claim" : "claims"}
      </p>
      {claims.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          No template claims for this result.
        </p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {claims.map((claim, index) => (
            <li key={`${claim.text}-${index}`} style={{ marginBottom: 12 }}>
              <div>{claim.text}</div>
              <div className="quiet" style={{ marginTop: 4 }}>
                {claim.temporality.kind === "applies-now" ? "applies now" : "can change"}
                {claim.signalLinks.length > 0 ? (
                  <>
                    {" · signals: "}
                    {claim.signalLinks.map((signalId, linkIndex) => (
                      <span key={signalId}>
                        {linkIndex > 0 ? ", " : null}
                        <button
                          type="button"
                          className="button-ghost"
                          style={{ border: "none", padding: 0, fontSize: 12 }}
                          onClick={() => onSignalLink(signalId)}
                        >
                          {signalId}
                        </button>
                      </span>
                    ))}
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
