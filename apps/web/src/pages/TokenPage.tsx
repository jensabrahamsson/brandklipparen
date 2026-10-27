import { useCallback, useEffect, useState, type JSX } from "react";
import { ApiError, analyzeToken, fetchAssessment, fetchHealth } from "../lib/api.ts";
import { isValidAddress } from "../lib/validate.ts";
import { riskWord } from "../lib/risk.ts";
import { signalTitle, strongestSignal } from "../lib/signals.ts";
import { AssessmentPanel } from "../components/AssessmentPanel.tsx";
import { CantTellPanel } from "../components/CantTellPanel.tsx";
import { Gauge } from "../components/Gauge.tsx";
import { RiskBadge } from "../components/RiskBadge.tsx";
import { ScoreRing } from "../components/ScoreRing.tsx";
import { Sidebar } from "../components/Sidebar.tsx";
import { SignalList } from "../components/SignalList.tsx";
import type { AnalyzeResult, AssessmentState, RiskKind } from "../types.ts";

const RISKS: readonly RiskKind[] = ["rug-pull", "honeypot", "bot-pump"];

// Token page (K-021): combined score ring with a meaning sentence, three
// gauges, expandable evidence, Can't-tell panel and sidebar. The fast path
// renders first; while x-deepening-status is pending a placeholder marks
// the deepening's place without faking streamed content.
export function TokenPage({
  address,
  apiKey,
  onHome,
}: {
  readonly address: string;
  readonly apiKey: string;
  readonly onHome: () => void;
}): JSX.Element {
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [assessment, setAssessment] = useState<AssessmentState>({ status: "idle" });
  const [tab, setTab] = useState<"overview" | "assessment">("overview");

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setLoadError(null);
    setAssessment({ status: "idle" });
    analyzeToken(address, apiKey.length === 0 ? null : apiKey).then(
      (value) => {
        if (!cancelled) {
          setResult(value);
        }
      },
      (reason: unknown) => {
        if (!cancelled) {
          setLoadError(reason instanceof Error ? reason.message : "Analysis failed.");
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [address, apiKey]);

  const requestAssessment = useCallback(() => {
    setAssessment({ status: "loading" });
    const key = apiKey.length === 0 ? null : apiKey;
    fetchHealth()
      .then((health) => {
        if (health.assessment && "disabled" in health.assessment) {
          setAssessment({ status: "not-configured" });
          return;
        }
        return fetchAssessment(address, key).then(
          (state) => setAssessment(state),
          (reason: unknown) => {
            if (reason instanceof ApiError && reason.code === "assessment-not-configured") {
              setAssessment({ status: "not-configured" });
            } else {
              setAssessment({ status: "error", message: reason instanceof Error ? reason.message : "Assessment failed." });
            }
          },
        );
      })
      .catch((reason: unknown) => {
        setAssessment({
          status: "error",
          message: reason instanceof Error ? reason.message : "Assessment failed.",
        });
      });
  }, [address, apiKey]);

  if (!isValidAddress(address)) {
    return (
      <div className="page">
        <p role="alert" className="field-error">
          Invalid address: expected 0x followed by 40 hex characters.
        </p>
        <button type="button" className="button-ghost" onClick={onHome}>
          Back to search
        </button>
      </div>
    );
  }

  return (
    <div className="page">
      <button type="button" className="button-ghost" onClick={onHome} style={{ marginBottom: 16 }}>
        ← Back to search
      </button>
      {loadError !== null ? (
        <div className="card" role="alert">
          <p style={{ marginTop: 0 }}>
            <strong>Analysis failed.</strong>
          </p>
          <p className="muted">{loadError}</p>
        </div>
      ) : null}
      {result === null && loadError === null ? <p className="muted">Analyzing bytecode…</p> : null}
      {result !== null && result.kind === "no-contract" ? (
        <div className="card" role="status">
          <p style={{ marginTop: 0 }}>
            <strong>No contract at {result.target}.</strong>
          </p>
          <p className="muted" style={{ marginBottom: 0 }}>
            Block {result.block}: the address holds no bytecode, so there is nothing to score.
          </p>
        </div>
      ) : null}
      {result !== null && result.kind === "assessed" ? (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
            <span className="mono numeric muted" style={{ fontSize: 13 }}>
              {result.target}
            </span>
            <RiskBadge score={result.score} />
          </div>
          <div className="tabs" role="tablist" aria-label="Token views">
            <button type="button" role="tab" className="tab" aria-selected={tab === "overview"} onClick={() => setTab("overview")}>
              Overview
            </button>
            <button
              type="button"
              role="tab"
              className="tab"
              aria-selected={tab === "assessment"}
              onClick={() => setTab("assessment")}
            >
              Contract assessment with Muse
            </button>
          </div>
          {tab === "overview" ? (
            <div>
              <div className="token-grid">
                <div>
                  <section className="card" aria-label="Combined score" style={{ marginBottom: 20 }}>
                    <div className="score-ring-wrap">
                      <ScoreRing score={result.score} />
                      <div style={{ flex: "1 1 240px" }}>
                        <p className="risk-meaning" style={{ fontSize: 22, fontWeight: 600, margin: "0 0 8px" }}>
                          {meaningSentence(result)}
                        </p>
                        {result.explanation.claims[0] !== undefined ? (
                          <p className="muted" style={{ margin: "0 0 8px" }}>
                            {result.explanation.claims[0].text}
                          </p>
                        ) : null}
                        <p className="quiet numeric" style={{ margin: 0 }}>
                          {result.score} {riskWord(result.score)} · model {result.modelVersion} · block {result.block}
                        </p>
                        <p className="quiet" style={{ margin: "4px 0 0" }}>
                          Probabilities are calibrated per the frozen model artifact; see the model card for the
                          calibration report.
                        </p>
                      </div>
                    </div>
                    {result.deepening === "pending" ? (
                      <p className="quiet" style={{ margin: "16px 0 0" }}>
                        Deepening pending: decompiled snippets stream in here when ready. Score and probabilities
                        stand meanwhile.
                      </p>
                    ) : null}
                  </section>
                  <div className="gauges" style={{ marginBottom: 20 }}>
                    {RISKS.map((risk) => {
                      const top = strongestSignal(result.signals, risk);
                      const count = result.signals.filter((signal) => signal.risk === risk).length;
                      return (
                        <Gauge
                          key={risk}
                          kind={risk}
                          probability={result.probabilities[risk]}
                          signalCount={count}
                          reason={top === undefined ? "No tracked patterns for this risk." : signalTitle(top)}
                        />
                      );
                    })}
                  </div>
                  <section className="card" aria-label="Signals" style={{ marginBottom: 20 }}>
                    <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>Signals</h2>
                    <p className="quiet numeric" style={{ margin: "0 0 8px" }}>
                      {result.signals.length} found · sorted by impact on the score
                    </p>
                    <SignalList signals={result.signals} />
                  </section>
                  <CantTellPanel entries={result.cantTell} />
                </div>
                <Sidebar result={result} />
              </div>
            </div>
          ) : (
            <AssessmentPanel state={assessment} score={result.score} onRequest={requestAssessment} />
          )}
        </div>
      ) : null}
    </div>
  );
}

function meaningSentence(result: Extract<AnalyzeResult, { kind: "assessed" }>): string {
  let topRisk: RiskKind = "rug-pull";
  let topValue = -1;
  for (const risk of RISKS) {
    const value = result.probabilities[risk];
    if (value > topValue) {
      topValue = value;
      topRisk = risk;
    }
  }
  const percent = Math.round(topValue * 100);
  const word = riskWord(Math.round(topValue * 100));
  const label = topRisk === "rug-pull" ? "Rug pull" : topRisk === "honeypot" ? "Honeypot" : "Bot-pump";
  return `${word} risk (${percent}% ${label.toLowerCase()}): ${topSummary(topRisk)}`;
}

function topSummary(risk: RiskKind): string {
  if (risk === "honeypot") {
    return "selling can be blocked or taxed away.";
  }
  if (risk === "rug-pull") {
    return "the owner can move or mint funds.";
  }
  return "launch mechanics favor bots.";
}
