import { useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { ApiError, analyzeToken, fetchAssessment, fetchHealth } from "../lib/api.ts";
import { isValidAddress } from "../lib/validate.ts";
import { riskWord } from "../lib/risk.ts";
import { combinedScoreLine, emptyGaugeReason, plainReason, signalTitle, sortByImpact, strongestSignal } from "../lib/signals.ts";
import { AssessmentPanel } from "../components/AssessmentPanel.tsx";
import { CantTellPanel } from "../components/CantTellPanel.tsx";
import { ExplanationList } from "../components/ExplanationList.tsx";
import { Gauge } from "../components/Gauge.tsx";
import { RiskBadge } from "../components/RiskBadge.tsx";
import { ScoreRing } from "../components/ScoreRing.tsx";
import { Sidebar } from "../components/Sidebar.tsx";
import { SignalList } from "../components/SignalList.tsx";
import type { AnalyzeResult, AssessmentState, ProviderInfo, RiskKind } from "../types.ts";

const RISKS: readonly RiskKind[] = ["rug-pull", "honeypot", "bot-pump"];
const RISK_SHORT: Record<RiskKind, string> = { "rug-pull": "Rug", honeypot: "Honey", "bot-pump": "Bot" };

// Deepening polls (design review P0-6): 1.5 s cadence, capped at 10.
const DEEPEN_POLL_MS = 1500;
const DEEPEN_POLL_MAX = 10;

type Tab = "overview" | "assessment";

// Token page: combined score ring with a meaning sentence, three gauges,
// full template explanation, expandable evidence, Can't-tell panel and
// sidebar. The fast path renders first; while x-deepening-status is
// pending the page re-reads /v1/analyze on a capped poll and merges
// snippets only: score and probabilities are asserted unchanged and the
// deterministic result object is otherwise kept intact. When the poll cap
// exhausts, the streaming promise hides instead of leaving a lying line.
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
  const [loadError, setLoadError] = useState<{ title: string; detail: string } | null>(null);
  const [assessment, setAssessment] = useState<AssessmentState>({ status: "idle" });
  const [provider, setProvider] = useState<ProviderInfo>({ status: "loading" });
  const [tab, setTab] = useState<Tab>("overview");
  const [attempt, setAttempt] = useState(0);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [openSignals, setOpenSignals] = useState<ReadonlySet<string>>(new Set());
  const deepeningPolls = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setLoadError(null);
    setElapsed(null);
    setAssessment({ status: "idle" });
    deepeningPolls.current = 0;
    const started = performance.now();
    const key = apiKey.length === 0 ? null : apiKey;
    analyzeToken(address, key).then(
      (value) => {
        if (cancelled) {
          return;
        }
        setElapsed((performance.now() - started) / 1000);
        setResult(value);
        if (value.kind === "assessed") {
          setOpenSignals(new Set(sortByImpact(value.signals).slice(0, 1).map((signal) => signal.id)));
          recordRecent(value);
        }
      },
      (reason: unknown) => {
        if (!cancelled) {
          setElapsed((performance.now() - started) / 1000);
          setLoadError(errorCopy(reason));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [address, apiKey, attempt]);

  useEffect(() => {
    let cancelled = false;
    fetchHealth().then(
      (health) => {
        if (cancelled) {
          return;
        }
        if ("disabled" in health.assessment) {
          setProvider({ status: "disabled" });
        } else {
          setProvider({ status: "ready", provider: health.assessment.provider, modelId: health.assessment.modelId });
        }
      },
      () => {
        if (!cancelled) {
          setProvider({ status: "disabled" });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const deepening = result?.kind === "assessed" ? result.deepening : undefined;
  const resultKind = result?.kind;
  useEffect(() => {
    if (resultKind !== "assessed" || deepening !== "pending") {
      return;
    }
    const key = apiKey.length === 0 ? null : apiKey;
    const timer = window.setInterval(() => {
      deepeningPolls.current += 1;
      const polls = deepeningPolls.current;
      analyzeToken(address, key).then(
        (fresh) => {
          if (fresh.kind !== "assessed") {
            return;
          }
          const done = fresh.deepening === "ready" || polls >= DEEPEN_POLL_MAX;
          if (done) {
            window.clearInterval(timer);
          }
          setResult((previous) => (previous === null ? previous : mergeDeepeningResult(previous, fresh, done)));
        },
        () => {
          if (polls >= DEEPEN_POLL_MAX) {
            window.clearInterval(timer);
            setResult((previous) =>
              previous !== null && previous.kind === "assessed" && previous.deepening === "pending"
                ? { ...previous, deepening: "unavailable" }
                : previous,
            );
          }
        },
      );
    }, DEEPEN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [address, apiKey, resultKind, deepening]);

  const requestAssessment = useCallback(() => {
    setAssessment({ status: "loading" });
    const key = apiKey.length === 0 ? null : apiKey;
    fetchHealth()
      .then((health) => {
        if ("disabled" in health.assessment) {
          setProvider({ status: "disabled" });
          setAssessment({ status: "not-configured" });
          return;
        }
        setProvider({ status: "ready", provider: health.assessment.provider, modelId: health.assessment.modelId });
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

  const toggleSignal = useCallback((signalId: string) => {
    setOpenSignals((previous) => {
      const next = new Set(previous);
      if (next.has(signalId)) {
        next.delete(signalId);
      } else {
        next.add(signalId);
      }
      return next;
    });
  }, []);

  const jumpToSignal = useCallback(
    (signalId: string) => {
      setTab("overview");
      setOpenSignals((previous) => new Set(previous).add(signalId));
      window.setTimeout(() => {
        document.getElementById(`signal-${CSS.escape(signalId)}`)?.scrollIntoView({ block: "start" });
      }, 0);
    },
    [],
  );

  const onTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const order: Tab[] = ["overview", "assessment"];
      const current = order.indexOf(tab);
      let next: number | null = null;
      if (event.key === "ArrowRight") {
        next = (current + 1) % order.length;
      } else if (event.key === "ArrowLeft") {
        next = (current - 1 + order.length) % order.length;
      } else if (event.key === "Home") {
        next = 0;
      } else if (event.key === "End") {
        next = order.length - 1;
      }
      if (next === null) {
        return;
      }
      event.preventDefault();
      const target = order[next] as Tab;
      setTab(target);
      document.getElementById(`tab-${target}`)?.focus();
    },
    [tab],
  );

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
      <p role="status" className="muted numeric" style={{ margin: "0 0 12px" }}>
        {result === null && loadError === null
          ? "Analyzing bytecode…"
          : loadError !== null
            ? "Analysis failed."
            : `Analysis complete${elapsed === null ? "" : ` in ${elapsed.toFixed(1)} s`}.`}
      </p>
      {loadError !== null ? (
        <div className="card" role="alert">
          <p style={{ marginTop: 0 }}>
            <strong>{loadError.title}</strong>
          </p>
          <p className="muted">{loadError.detail}</p>
          <button type="button" className="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry
          </button>
        </div>
      ) : null}
      {result === null && loadError === null ? <LoadingSkeleton /> : null}
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
        <AssessedView
          result={result}
          elapsed={elapsed}
          tab={tab}
          onTab={setTab}
          onTabKeyDown={onTabKeyDown}
          assessment={assessment}
          provider={provider}
          onRequestAssessment={requestAssessment}
          openSignals={openSignals}
          onToggleSignal={toggleSignal}
          onSignalLink={jumpToSignal}
        />
      ) : null}
    </div>
  );
}

function AssessedView({
  result,
  elapsed,
  tab,
  onTab,
  onTabKeyDown,
  assessment,
  provider,
  onRequestAssessment,
  openSignals,
  onToggleSignal,
  onSignalLink,
}: {
  readonly result: Extract<AnalyzeResult, { kind: "assessed" }>;
  readonly elapsed: number | null;
  readonly tab: Tab;
  readonly onTab: (tab: Tab) => void;
  readonly onTabKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly assessment: AssessmentState;
  readonly provider: ProviderInfo;
  readonly onRequestAssessment: () => void;
  readonly openSignals: ReadonlySet<string>;
  readonly onToggleSignal: (signalId: string) => void;
  readonly onSignalLink: (signalId: string) => void;
}): JSX.Element {
  const sorted = sortByImpact(result.signals);
  const templateBySignal = new Map<string, string>();
  for (const claim of result.explanation.claims) {
    for (const signalId of claim.signalLinks) {
      if (!templateBySignal.has(signalId)) {
        templateBySignal.set(signalId, claim.text);
      }
    }
  }
  const templateLine = (signalId: string): string | undefined => templateBySignal.get(signalId);
  return (
    <div>
      <div className="compact-strip" aria-label="Result summary">
        <span className="numeric">
          <strong>{result.score}</strong> {riskWord(result.score)}
        </span>
        <span className="numeric compact-strip-probs">
          {RISKS.map((risk) => `${RISK_SHORT[risk]} ${Math.round(result.probabilities[risk] * 100)}%`).join(" · ")}
        </span>
        <span className="mono numeric compact-strip-hash" title={result.codeHash}>
          {result.codeHash}
        </span>
        <RiskBadge score={result.score} />
      </div>
      <div className="tabs" role="tablist" aria-label="Token views" onKeyDown={onTabKeyDown}>
        <button
          type="button"
          role="tab"
          id="tab-overview"
          aria-controls="panel-overview"
          aria-selected={tab === "overview"}
          tabIndex={tab === "overview" ? 0 : -1}
          className="tab"
          onClick={() => onTab("overview")}
        >
          Overview
        </button>
        <button
          type="button"
          role="tab"
          id="tab-assessment"
          aria-controls="panel-assessment"
          aria-selected={tab === "assessment"}
          tabIndex={tab === "assessment" ? 0 : -1}
          className="tab"
          onClick={() => onTab("assessment")}
        >
          Contract assessment
        </button>
      </div>
      <div role="tabpanel" id="panel-overview" aria-labelledby="tab-overview" hidden={tab !== "overview"}>
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
                      <p className="muted" style={{ margin: "0 0 8px" }}>
                        {combinedScoreLine(result.score, result.probabilities)}
                      </p>
                      <p className="quiet numeric" style={{ margin: 0 }}>
                        {result.score} {riskWord(result.score)} · model {result.modelVersion} · block {result.block}
                        {elapsed === null ? "" : ` · Fast path ${elapsed.toFixed(1)} s`}
                      </p>
                      <p className="quiet" style={{ margin: "4px 0 0" }}>
                        Calibration report: see the model card. The v1 REST response carries no calibration
                        numbers, so none are shown here.
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
                        reason={top === undefined ? emptyGaugeReason() : plainReason(top)}
                      />
                    );
                  })}
                </div>
                <ExplanationList
                  claims={result.explanation.claims}
                  templateVersion={result.explanation.templateVersion}
                  onSignalLink={onSignalLink}
                />
                <section className="card" aria-label="Signals" style={{ marginBottom: 20 }}>
                  <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>Signals</h2>
                  <p className="quiet numeric" style={{ margin: "0 0 8px" }}>
                    {result.signals.length} found · sorted by impact on the score
                  </p>
                  <SignalList
                    signals={sorted}
                    target={result.target}
                    codeHash={result.codeHash}
                    deepening={result.deepening}
                    open={openSignals}
                    onToggle={onToggleSignal}
                    templateLine={templateLine}
                  />
                </section>
                <CantTellPanel entries={result.cantTell} />
              </div>
              <Sidebar result={result} />
            </div>
          </div>
        ) : null}
      </div>
      <div role="tabpanel" id="panel-assessment" aria-labelledby="tab-assessment" hidden={tab !== "assessment"}>
        {tab === "assessment" ? (
          <AssessmentPanel state={assessment} score={result.score} provider={provider} onRequest={onRequestAssessment} />
        ) : null}
      </div>
    </div>
  );
}

function LoadingSkeleton(): JSX.Element {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = performance.now();
    const timer = window.setInterval(() => setSeconds((performance.now() - started) / 1000), 100);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div aria-hidden="true">
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="skeleton skeleton-ring" />
        <p className="quiet numeric" style={{ margin: "12px 0 0" }}>
          Loading result… {seconds.toFixed(1)} s
        </p>
      </div>
      <div className="gauges" style={{ marginBottom: 20 }}>
        <div className="skeleton skeleton-gauge" />
        <div className="skeleton skeleton-gauge" />
        <div className="skeleton skeleton-gauge" />
      </div>
      <div className="card">
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line" />
      </div>
    </div>
  );
}

function sameProbabilities(
  left: Extract<AnalyzeResult, { kind: "assessed" }>["probabilities"],
  right: Extract<AnalyzeResult, { kind: "assessed" }>["probabilities"],
): boolean {
  return left["rug-pull"] === right["rug-pull"] && left.honeypot === right.honeypot && left["bot-pump"] === right["bot-pump"];
}

// Design review P0-6: deepening polls merge snippets only. Score and
// probabilities are asserted unchanged: a mismatched refresh is dropped so
// the deterministic result never moves under the reader. When the poll cap
// exhausts without readiness, the caller marks the result unavailable so
// the streaming promise hides.
export function mergeDeepeningResult(
  previous: AnalyzeResult,
  fresh: AnalyzeResult,
  pollsExhausted: boolean,
): AnalyzeResult {
  if (previous.kind !== "assessed" || fresh.kind !== "assessed") {
    return previous;
  }
  if (fresh.score !== previous.score || sameProbabilities(fresh.probabilities, previous.probabilities) === false) {
    return previous;
  }
  return { ...previous, deepening: fresh.deepening === "ready" ? "ready" : pollsExhausted ? "unavailable" : "pending" };
}

// Design review P1-14: HTTP failures map to useful copy with a retry path.
export function errorCopy(reason: unknown): { title: string; detail: string } {
  if (reason instanceof ApiError) {
    if (reason.status === 401) {
      return {
        title: "Analysis needs an API key.",
        detail: "The REST API rejected the request (401): set a valid API key and try again.",
      };
    }
    if (reason.status === 429) {
      return {
        title: "Rate limited.",
        detail: "Too many requests (429): wait a moment, then retry.",
      };
    }
    if (reason.status >= 500) {
      return {
        title: "The analysis service is down.",
        detail: `Server error (${reason.status}): the REST API failed; retry in a bit.`,
      };
    }
    return { title: "Analysis failed.", detail: reason.message };
  }
  return { title: "Analysis failed.", detail: reason instanceof Error ? reason.message : "Analysis failed." };
}

function recordRecent(value: Extract<AnalyzeResult, { kind: "assessed" }>): void {
  try {
    const raw = sessionStorage.getItem("brandklipparen-recent");
    const previous = raw === null ? [] : (JSON.parse(raw) as unknown);
    const entries = Array.isArray(previous) ? previous : [];
    const top = strongestSignal(value.signals, topRisk(value));
    const entry = {
      address: value.target,
      score: value.score,
      word: riskWord(value.score),
      probabilities: value.probabilities,
      topSignal: top === undefined ? null : signalTitle(top),
      at: Date.now(),
    };
    const next = [entry, ...entries.filter((item) => (item as { address?: string }).address !== value.target)].slice(0, 5);
    sessionStorage.setItem("brandklipparen-recent", JSON.stringify(next));
  } catch {
    // Session storage is a convenience only; the app works without it.
  }
}

function topRisk(result: Extract<AnalyzeResult, { kind: "assessed" }>): RiskKind {
  let best: RiskKind = "rug-pull";
  let bestValue = -1;
  for (const risk of RISKS) {
    const value = result.probabilities[risk];
    if (value > bestValue) {
      bestValue = value;
      best = risk;
    }
  }
  return best;
}

function meaningSentence(result: Extract<AnalyzeResult, { kind: "assessed" }>): string {
  let topRiskValue: RiskKind = "rug-pull";
  let topValue = -1;
  for (const risk of RISKS) {
    const value = result.probabilities[risk];
    if (value > topValue) {
      topValue = value;
      topRiskValue = risk;
    }
  }
  const percent = Math.round(topValue * 100);
  const word = riskWord(Math.round(topValue * 100));
  const label = topRiskValue === "rug-pull" ? "Rug pull" : topRiskValue === "honeypot" ? "Honeypot" : "Bot-pump";
  return `${word} risk (${percent}% ${label.toLowerCase()}): ${topSummary(topRiskValue)}`;
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
