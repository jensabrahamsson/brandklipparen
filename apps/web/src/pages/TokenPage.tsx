import { useCallback, useEffect, useRef, useState, type CSSProperties, type JSX, type KeyboardEvent, type SyntheticEvent } from "react";
import { ApiError, analyzeToken, fetchAssessment, fetchHealth, fetchPersonalizeStatus, fetchPlugins, requestInvestigation, requestPersonalizeMapping } from "../lib/api.ts";
import { ExpertDetail } from "../components/ExpertDetail.tsx";
import { PluginsPanel } from "../components/PluginsPanel.tsx";
import type { PluginListEntry } from "../components/PluginsPanel.tsx";
import { toPluginResultViews } from "../lib/plugins.ts";
import { isValidAddress } from "../lib/validate.ts";
import { planLayout } from "../lib/layout.ts";
import { readStoredCustomize, readStoredMode, writeStoredCustomize, writeStoredMode } from "../lib/uiMode.ts";
import type { UiMode } from "../lib/uiMode.ts";
import { fetchLiveTokens } from "../lib/liveTokens.ts";
import type { LiveTokenEntry } from "../lib/liveTokens.ts";
import { resolveTokenIdentity } from "../lib/tokenIdentity.ts";
import { TokenHeader } from "../components/TokenHeader.tsx";
import { clearStoredPriorities, readStoredPriorities, writeStoredPriorities } from "../lib/priorities.ts";
import { matchPriorities } from "../lib/matcher.ts";
import { PrioritiesField } from "../components/PrioritiesField.tsx";
import {
  applyAiSectionOrder,
  parsePersonalizeEnvelope,
  readStoredAiPersonalize,
  requiredFlooredSections,
  writeStoredAiPersonalize,
} from "../lib/personalize.ts";
import type { AiPersonalizeSpec, PersonalizeContext } from "../lib/personalize.ts";
import { riskBand, riskWord } from "../lib/risk.ts";
import { toAiAvailability, type AiFeatureAvailability } from "../lib/capabilities.ts";
import { assignTemplateLines } from "../lib/claims.ts";
import {
  combinedScoreLine,
  emptyGaugeReason,
  plainReason,
  riskLabel,
  signalKey,
  signalTitle,
  sortByImpact,
  strongestSignal,
} from "../lib/signals.ts";
import { AssessmentPanel } from "../components/AssessmentPanel.tsx";
import { ExplainPanel } from "../components/ExplainPanel.tsx";
import { FieldPicker, PICKABLE_SECTIONS } from "../components/FieldPicker.tsx";
import { StreamView } from "../components/StreamView.tsx";
import { InvestigationPanel } from "../components/InvestigationPanel.tsx";
import { OnchainPanel } from "../components/OnchainPanel.tsx";
import { CantTellPanel } from "../components/CantTellPanel.tsx";
import { ExplanationList } from "../components/ExplanationList.tsx";
import { Gauge } from "../components/Gauge.tsx";
import { ScoreRing } from "../components/ScoreRing.tsx";
import { truncateHash, useRingOutOfView } from "../lib/summaryStrip.ts";
import { Sidebar } from "../components/Sidebar.tsx";
import { SignalList } from "../components/SignalList.tsx";
import { Explain } from "../components/Explain.tsx";
import type { AnalyzeResult, AssessmentState, InvestigationState, InvestigationStep, ProviderInfo, RiskKind } from "../types.ts";
import { RISK_SHORT } from "../lib/risk.ts";

const RISKS: readonly RiskKind[] = ["rug-pull", "honeypot", "bot-pump"];

// Verdict header band colour (S-121, S-132): the risk band colour for
// the 1px top border and the headline caret, passed as --verdict-band
// so the stylesheet owns the edge. Same riskBand source as RiskBadge,
// so caret, border and badge can never disagree.
export function verdictBandColor(score: number): string {
  const word = riskBand(score).word;
  return word === "Low" ? "var(--low)" : word === "Elevated" ? "var(--elevated)" : "var(--high)";
}

// Deepening polls (design review P0-6): 1.5 s cadence, capped at 10.
const DEEPEN_POLL_MS = 1500;
const DEEPEN_POLL_MAX = 10;

type Tab = "overview" | "assessment" | "investigate";

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
  const [investigation, setInvestigation] = useState<InvestigationState>({ status: "idle" });
  const [provider, setProvider] = useState<ProviderInfo>({ status: "loading" });
  const [plugins, setPlugins] = useState<readonly PluginListEntry[] | null>(null);
  const [mode, setMode] = useState<UiMode>(() => readStoredMode());
  const [priorities, setPriorities] = useState<string>(() => readStoredPriorities());
  const [standardOrder, setStandardOrder] = useState(false);
  const [aiOn, setAiOn] = useState<boolean>(() => readStoredAiPersonalize());
  const [aiSpec, setAiSpec] = useState<AiPersonalizeSpec | null>(null);
  const [aiNotice, setAiNotice] = useState<string | null>(null);
  const [aiPending, setAiPending] = useState(false);
  const [aiProvider, setAiProvider] = useState<{ provider: string; modelId: string } | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  // Field picker (S-100, K-023): picked overview sections render, cleared
  // ones hide; the score stays pinned and is never pickable.
  const [visibleSections, setVisibleSections] = useState<ReadonlySet<string>>(
    () => new Set(["score", ...PICKABLE_SECTIONS.map((section) => section.id)]),
  );
  const [attempt, setAttempt] = useState(0);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [openSignals, setOpenSignals] = useState<ReadonlySet<string>>(new Set());
  // Live-list entry for the heading fallback (symbol/name, DEX and age):
  // matched by token address, null when the feed is off or silent.
  const [liveEntry, setLiveEntry] = useState<LiveTokenEntry | null>(null);
  // AI feature availability decided up front from /health (S-123). The
  // default keeps the previous explicit-request behaviour until the
  // capabilities arrive; unknown fields stay available for older servers.
  const [availability, setAvailability] = useState<AiFeatureAvailability>({
    investigation: "available",
    explain: "available",
    onchain: "available",
  });
  const healthPersonalize = useRef(false);
  const deepeningPolls = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setLoadError(null);
    setElapsed(null);
    setAssessment({ status: "idle" });
    setInvestigation({ status: "idle" });
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
          setOpenSignals(
            new Set(sortByImpact(value.signals).slice(0, 1).map((signal, index) => signalKey(signal, index))),
          );
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
    fetchLiveTokens(apiKey.length === 0 ? null : apiKey).then(
      (snapshot) => {
        if (cancelled) {
          return;
        }
        const match = snapshot.items.find(
          (item) => item.tokenAddress.toLowerCase() === address.toLowerCase(),
        );
        setLiveEntry(match ?? null);
      },
      () => {
        if (!cancelled) {
          setLiveEntry(null);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [address, apiKey]);

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
        setAvailability(toAiAvailability(health));
        if (health.personalize !== undefined) {
          healthPersonalize.current = true;
          setAiProvider(
            "disabled" in health.personalize
              ? null
              : { provider: health.personalize.provider, modelId: health.personalize.modelId },
          );
        }
      },
      () => {
        if (!cancelled) {
          setProvider({ status: "disabled" });
          setAvailability({ investigation: "unavailable", explain: "unavailable", onchain: "unavailable" });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const key = apiKey.length === 0 ? null : apiKey;
    fetchPlugins(key).then((entries) => {
      if (!cancelled) {
        setPlugins(entries);
      }
    });
    // Older servers report no personalize capability in /health; the
    // dedicated status endpoint stays the fallback there.
    fetchPersonalizeStatus(key).then((status) => {
      if (!cancelled && !healthPersonalize.current) {
        setAiProvider(status);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [apiKey]);

  const toggleAi = (next: boolean): void => {
    setAiOn(next);
    writeStoredAiPersonalize(next);
    setAiNotice(null);
    if (!next) {
      setAiSpec(null);
    }
  };

  const applyAiOrder = (): void => {
    if (aiPending || !aiOn || priorities.trim().length === 0) {
      return;
    }
    setAiPending(true);
    const key = apiKey.length === 0 ? null : apiKey;
    requestPersonalizeMapping(key, address.trim(), priorities.trim()).then((body) => {
      setAiPending(false);
      const pluginIds = (plugins ?? []).map((plugin) => plugin.id);
      const assessedSignals = result?.kind === "assessed" ? result.signals : [];
      const context: PersonalizeContext = {
        sectionIds: ["summary", "score", "signals", "plugin-findings", "evidence", "cant-tell", "expert-detail"],
        pluginIds,
        flooredSectionIds: [...requiredFlooredSections(assessedSignals)],
      };
      const spec = parsePersonalizeEnvelope(body, context);
      if (spec === null) {
        setAiSpec(null);
        setAiNotice("AI layout unavailable — showing deterministic order.");
      } else {
        setAiSpec(spec);
        setAiNotice("AI order applied. Scores, evidence and text are unchanged.");
      }
    });
  };

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

  const runInvestigation = useCallback(() => {
    setInvestigation({ status: "loading", steps: [] });
    const key = apiKey.length === 0 ? null : apiKey;
    const onStep = (step: InvestigationStep): void => {
      setInvestigation((previous) => {
        if (previous.status !== "loading") {
          return previous;
        }
        return { status: "loading", steps: [...previous.steps, step] };
      });
    };
    requestInvestigation(address, key, onStep).then(
      ({ state }) => setInvestigation(state),
      (reason: unknown) => {
        setInvestigation({
          status: "failed",
          message: reason instanceof Error ? reason.message : "Investigation failed.",
          steps: [],
        });
      },
    );
  }, [address, apiKey]);

  const toggleSignal = useCallback((key: string) => {
    setOpenSignals((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  // Field picker (S-100, K-023): picked sections render, cleared ones
  // hide; the score section is never offered so it always stays.
  const toggleSection = useCallback((sectionId: string) => {
    setVisibleSections((previous) => {
      const next = new Set(previous);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  }, []);

  const onTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const order: Tab[] = ["overview", "assessment", "investigate"];
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
      {result !== null && result.kind === "assessed" ? null : (
        <p role="status" className="muted numeric" style={{ margin: "0 0 12px" }}>
          {result === null && loadError === null
            ? "Analyzing bytecode…"
            : loadError !== null
              ? "Analysis failed."
              : `Analysis complete${elapsed === null ? "" : ` in ${elapsed.toFixed(1)} s`}.`}
        </p>
      )}
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
      {result === null && loadError === null ? <LoadingNotice /> : null}
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
          plugins={plugins}
          mode={mode}
          onModeChange={(next) => {
            setMode(next);
            writeStoredMode(next);
          }}
          aiSpec={aiOn ? aiSpec : null}
          aiOn={aiOn}
          onToggleAi={toggleAi}
          aiProvider={aiProvider}
          aiPending={aiPending}
          onApplyAiOrder={applyAiOrder}
          aiNotice={aiNotice}
          priorities={priorities}
          onPrioritiesChange={(text) => {
            setPriorities(text);
            writeStoredPriorities(text);
            setStandardOrder(false);
          }}
          onPrioritiesClear={() => {
            clearStoredPriorities();
            setPriorities("");
          }}
          standardOrder={standardOrder}
          onShowStandardOrder={() => setStandardOrder(true)}
          availability={availability}
          tab={tab}
          onTab={setTab}
          onTabKeyDown={onTabKeyDown}
          assessment={assessment}
          provider={provider}
          onRequestAssessment={requestAssessment}
          investigation={investigation}
          onRunInvestigation={runInvestigation}
          openSignals={openSignals}
          onToggleSignal={toggleSignal}
          address={address}
          liveEntry={liveEntry}
          apiKey={apiKey}
          visibleSections={visibleSections}
          onToggleSection={toggleSection}
        />
      ) : null}
    </div>
  );
}

function AssessedView({
  result,
  elapsed,
  plugins,
  mode,
  onModeChange,
  aiSpec,
  aiOn,
  onToggleAi,
  aiProvider,
  aiPending,
  onApplyAiOrder,
  aiNotice,
  priorities,
  onPrioritiesChange,
  onPrioritiesClear,
  standardOrder,
  onShowStandardOrder,
  availability,
  tab,
  onTab,
  onTabKeyDown,
  assessment,
  provider,
  onRequestAssessment,
  investigation,
  onRunInvestigation,
  openSignals,
  onToggleSignal,
  address,
  liveEntry,
  apiKey,
  visibleSections,
  onToggleSection,
}: {
  readonly result: Extract<AnalyzeResult, { kind: "assessed" }>;
  readonly elapsed: number | null;
  readonly plugins: readonly PluginListEntry[] | null;
  readonly mode: UiMode;
  readonly onModeChange: (mode: UiMode) => void;
  readonly aiSpec: AiPersonalizeSpec | null;
  readonly aiOn: boolean;
  readonly onToggleAi: (next: boolean) => void;
  readonly aiProvider: { provider: string; modelId: string } | null;
  readonly aiPending: boolean;
  readonly onApplyAiOrder: () => void;
  readonly aiNotice: string | null;
  readonly priorities: string;
  readonly onPrioritiesChange: (text: string) => void;
  readonly onPrioritiesClear: () => void;
  readonly standardOrder: boolean;
  readonly onShowStandardOrder: () => void;
  readonly availability: AiFeatureAvailability;
  readonly tab: Tab;
  readonly onTab: (tab: Tab) => void;
  readonly onTabKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly assessment: AssessmentState;
  readonly provider: ProviderInfo;
  readonly onRequestAssessment: () => void;
  readonly investigation: InvestigationState;
  readonly onRunInvestigation: () => void;
  readonly openSignals: ReadonlySet<string>;
  readonly onToggleSignal: (key: string) => void;
  readonly address: string;
  readonly liveEntry: LiveTokenEntry | null;
  readonly apiKey: string;
  readonly visibleSections: ReadonlySet<string>;
  readonly onToggleSection: (sectionId: string) => void;
}): JSX.Element {
  const sorted = sortByImpact(result.signals);
  // Template lines pair with signals by position and risk (S-116), never
  // by signal id, so duplicate ids cannot misattribute evidence.
  const templateLines = assignTemplateLines(sorted, result.explanation.claims);
  const templateLine = (index: number): string | undefined => templateLines[index];
  // Signal links from claims and investigation evidence arrive as stable
  // position-derived keys, so the scroll target uses the same unique key
  // as the article DOM id. Focus follows the scroll so keyboard users land
  // on the linked signal (S-125).
  const jumpToSignal = useCallback(
    (key: string) => {
      onTab("overview");
      if (!openSignals.has(key)) {
        onToggleSignal(key);
      }
      // The overview panel remounts on the tab switch, so the article may
      // not exist yet: retry until it commits, then scroll and focus it.
      // getElementById takes the literal id: no CSS escaping (an escaped
      // leading digit would never match).
      let attempts = 0;
      const reveal = (): void => {
        const target = document.getElementById(`signal-${key}`);
        if (target === null && attempts < 10) {
          attempts += 1;
          window.setTimeout(reveal, 50);
          return;
        }
        target?.scrollIntoView({ block: "start" });
        const control = target?.querySelector(":scope > button");
        if (control instanceof HTMLElement) {
          control.focus();
        }
      };
      window.setTimeout(reveal, 0);
    },
    [onTab, onToggleSignal, openSignals],
  );
  // Summary strip visibility: always on the assessment tab (no ring there);
  // on Overview only once the combined score ring has scrolled out of view.
  // Unmounted when hidden so it takes no layout space and cannot overlap
  // the ring or gauge cards. The tab key re-subscribes when tab switches
  // remount the Overview panel.
  const ringRef = useRef<HTMLElement | null>(null);
  const ringGone = useRingOutOfView(ringRef, tab);
  const stripVisible = tab === "assessment" || tab === "investigate" || ringGone;
  return (
    <div>
      <section
        className="card verdict"
        aria-label="Combined score"
        ref={ringRef}
        style={{ marginBottom: 20, "--verdict-band": verdictBandColor(result.score) } as CSSProperties}
      >
        <TokenHeader
          address={result.target}
          identity={resolveTokenIdentity(result, liveEntry)}
          liveEntry={liveEntry}
        />
        <p className="quiet numeric" style={{ margin: "0 0 16px" }}>
          Analysis complete{elapsed === null ? "" : ` in ${elapsed.toFixed(1)} s`} · Block {result.block} · model{" "}
          {result.modelVersion}
        </p>
        <div className="score-ring-wrap">
          <div style={{ flex: "1 1 240px" }}>
            <p className="risk-meaning" style={{ margin: "0 0 8px" }}>
              <span className="headline-marker" aria-hidden="true">
                &gt;{" "}
              </span>
              <span>{meaningSentence(result)}</span> <Explain explainKey="score:combined" label="Combined score" />
            </p>
            <p className="muted" style={{ margin: "0 0 8px" }}>
              {combinedScoreLine(result.score, result.probabilities)}
            </p>
            <p className="quiet numeric" style={{ margin: 0 }}>
              {result.score} {riskWord(result.score)} ·{" "}
              {RISKS.map((risk) => `${RISK_SHORT[risk]} ${Math.round(result.probabilities[risk] * 100)}%`).join(" · ")}
            </p>
            {mode === "expert" ? (
              <p className="quiet" style={{ margin: "4px 0 0" }}>
                Calibration report: see the model card. The v1 REST response carries no calibration numbers, so none
                are shown here.
              </p>
            ) : null}
          </div>
          <ScoreRing score={result.score} />
        </div>
        {result.deepening === "pending" ? (
          <p className="quiet" style={{ margin: "16px 0 0" }}>
            Deepening pending: decompiled snippets stream in here when ready. Score and probabilities stand meanwhile.
          </p>
        ) : null}
      </section>
      {stripVisible ? (
        <div className="compact-strip" aria-label="Result summary" data-testid="result-summary">
          <span className="numeric">
            <strong>{result.score}</strong> {riskWord(result.score)}
          </span>
          <Explain explainKey="score:strip" label="Result summary" />
          <span className="numeric compact-strip-probs">
            {RISKS.map((risk) => `${RISK_SHORT[risk]} ${Math.round(result.probabilities[risk] * 100)}%`).join(" · ")}
          </span>
          <span className="mono numeric compact-strip-hash" title={result.codeHash}>
            {truncateHash(result.codeHash)}
          </span>
        </div>
      ) : null}
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
        <button
          type="button"
          role="tab"
          id="tab-investigate"
          aria-controls="panel-investigate"
          aria-selected={tab === "investigate"}
          tabIndex={tab === "investigate" ? 0 : -1}
          className="tab"
          onClick={() => onTab("investigate")}
        >
          Investigate
        </button>
      </div>
      <CustomizeView
        mode={mode}
        onModeChange={onModeChange}
        aiOn={aiOn}
        onToggleAi={onToggleAi}
        aiProvider={aiProvider}
        aiPending={aiPending}
        onApplyAiOrder={onApplyAiOrder}
        aiNotice={aiNotice}
        visibleSections={visibleSections}
        onToggleSection={onToggleSection}
        priorities={priorities}
        onPrioritiesChange={onPrioritiesChange}
        onPrioritiesClear={onPrioritiesClear}
      />
      <div role="tabpanel" id="panel-overview" aria-labelledby="tab-overview" hidden={tab !== "overview"}>
        {tab === "overview" ? (
          <>
            <OverviewSections
              result={result}
              plugins={plugins}
              mode={mode}
              aiSpec={aiSpec}
              priorities={priorities}
              standardOrder={standardOrder}
              onShowStandardOrder={onShowStandardOrder}
              sorted={sorted}
              templateLine={templateLine}
              openSignals={openSignals}
              onToggleSignal={onToggleSignal}
              onSignalLink={jumpToSignal}
              visibleSections={visibleSections}
              liveEntry={liveEntry}
            />
            {mode === "expert" ? <StreamView address={address} apiKey={apiKey} /> : null}
            <ExplainPanel address={address} apiKey={apiKey} availability={availability.explain} />
            <OnchainPanel address={address} apiKey={apiKey} availability={availability.onchain} />
          </>
        ) : null}
      </div>
      <div role="tabpanel" id="panel-assessment" aria-labelledby="tab-assessment" hidden={tab !== "assessment"}>
        {tab === "assessment" ? (
          <AssessmentPanel state={assessment} score={result.score} provider={provider} onRequest={onRequestAssessment} />
        ) : null}
      </div>
      <div role="tabpanel" id="panel-investigate" aria-labelledby="tab-investigate" hidden={tab !== "investigate"}>
        {tab === "investigate" ? (
          <InvestigationPanel
            state={investigation}
            score={result.score}
            availability={availability.investigation}
            signals={sorted}
            onSignalLink={jumpToSignal}
            onRequest={onRunInvestigation}
          />
        ) : null}
      </div>
    </div>
  );
}

// Overview sections in deterministic risk-adaptive order (S-060, K-034,
// P-19): the plan comes from the frozen analysis only, DOM order equals
// visual order, and every section stays present in every band. Only order
// changes; scores, evidence and finding text never move.
// Collapsed "Customize view" disclosure (S-118): Detail radios, AI
// personalize, the section picker and the priorities field live here,
// after the tabs. Collapsed by default; the open state is remembered for
// the session only. Scores, evidence and finding text never move.
function CustomizeView({
  mode,
  onModeChange,
  aiOn,
  onToggleAi,
  aiProvider,
  aiPending,
  onApplyAiOrder,
  aiNotice,
  visibleSections,
  onToggleSection,
  priorities,
  onPrioritiesChange,
  onPrioritiesClear,
}: {
  readonly mode: UiMode;
  readonly onModeChange: (mode: UiMode) => void;
  readonly aiOn: boolean;
  readonly onToggleAi: (next: boolean) => void;
  readonly aiProvider: { provider: string; modelId: string } | null;
  readonly aiPending: boolean;
  readonly onApplyAiOrder: () => void;
  readonly aiNotice: string | null;
  readonly visibleSections: ReadonlySet<string>;
  readonly onToggleSection: (sectionId: string) => void;
  readonly priorities: string;
  readonly onPrioritiesChange: (text: string) => void;
  readonly onPrioritiesClear: () => void;
}): JSX.Element {
  // Disclosure with remembered state, synced from the element: `open`
  // renders the remembered session state, and every native toggle — mouse
  // click, keyboard Enter/Space, find-in-page, programmatic — flips the
  // `open` attribute. The old summary onClick + preventDefault suppressed
  // the native toggle entirely, so `toggle` never fired (the reported
  // "onToggle not firing") and every non-click toggle desynced React
  // state; there is no `defaultOpen` for details in React (the prop
  // renders inert), so the element itself is the sync source. Persisting
  // only in `onToggle` is racy: the event is queued as a later task after
  // `.open` already flipped, so a reload committed in between (flaky
  // details-toggle e2e at the post-reload assertion) drops the write
  // while the test already observed open=true. The observer below fires
  // at the microtask checkpoint of the flipping task, so React state and
  // session storage are synced before any reload navigation can start.
  // `onToggle` stays as the redundant sync for the same state.
  const [open, setOpen] = useState<boolean>(() => readStoredCustomize());
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    const element = detailsRef.current;
    if (element === null) {
      return;
    }
    const sync = (): void => {
      const next = element.open;
      setOpen(next);
      writeStoredCustomize(next);
    };
    const observer = new MutationObserver(sync);
    observer.observe(element, { attributes: true, attributeFilter: ["open"] });
    return () => observer.disconnect();
  }, []);
  const remember = (event: SyntheticEvent<HTMLDetailsElement>): void => {
    const next = event.currentTarget.open;
    setOpen(next);
    writeStoredCustomize(next);
  };
  return (
    <details ref={detailsRef} className="customize" open={open ? true : undefined} onToggle={remember}>
      <summary>Customize view</summary>
      <div role="radiogroup" aria-label="Detail depth" style={{ margin: "16px 0" }}>
        <span className="quiet" style={{ marginRight: 12, fontSize: 14 }}>
          Detail:
        </span>
        <label style={{ marginRight: 12, fontSize: 14 }}>
          <input type="radio" name="ui-mode" value="simple" checked={mode === "simple"} onChange={() => onModeChange("simple")} />{" "}
          Simple
        </label>
        <label style={{ fontSize: 14 }}>
          <input type="radio" name="ui-mode" value="expert" checked={mode === "expert"} onChange={() => onModeChange("expert")} />{" "}
          Expert
        </label>
      </div>
      <section aria-label="AI personalize" style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 14, fontWeight: 600 }}>
          <input
            type="checkbox"
            data-testid="ai-personalize-toggle"
            checked={aiOn}
            disabled={aiProvider === null}
            aria-describedby="ai-personalize-status"
            onChange={(event) => onToggleAi(event.target.checked)}
          />{" "}
          AI personalize (experimental)
        </label>
        <p
          id="ai-personalize-status"
          className="quiet"
          data-testid="ai-personalize-label"
          style={{ margin: "4px 0", fontSize: 13 }}
        >
          {aiProvider === null
            ? "Mapping provider not configured on this server."
            : `Maps with ${aiProvider.provider} · ${aiProvider.modelId}.`}
        </p>
        {aiOn ? (
          <div>
            <p className="quiet" data-testid="ai-personalize-preface" style={{ margin: "4px 0", fontSize: 13 }}>
              Sends your priorities text and plugin references to{" "}
              {aiProvider === null ? "the mapping provider" : `${aiProvider.provider} · ${aiProvider.modelId}`} for
              this one mapping call. Nothing else is sent.
            </p>
            <button
              type="button"
              data-testid="ai-personalize-apply"
              disabled={aiPending || priorities.trim().length === 0}
              onClick={onApplyAiOrder}
            >
              {aiPending ? "Mapping…" : "Apply AI order"}
            </button>
          </div>
        ) : null}
        {aiNotice === null ? null : (
          <p className="quiet" data-testid="ai-personalize-result" style={{ margin: "4px 0 0", fontSize: 13 }}>
            {aiNotice}
          </p>
        )}
      </section>
      <FieldPicker visible={visibleSections} onToggle={onToggleSection} />
      <PrioritiesField value={priorities} onChange={onPrioritiesChange} onClear={onPrioritiesClear} />
    </details>
  );
}

function OverviewSections({
  result,
  plugins,
  mode,
  aiSpec,
  priorities,
  standardOrder,
  onShowStandardOrder,
  sorted,
  templateLine,
  openSignals,
  onToggleSignal,
  onSignalLink,
  visibleSections,
  liveEntry,
}: {
  readonly result: Extract<AnalyzeResult, { kind: "assessed" }>;
  readonly plugins: readonly PluginListEntry[] | null;
  readonly mode: UiMode;
  readonly priorities: string;
  readonly standardOrder: boolean;
  readonly onShowStandardOrder: () => void;
  readonly aiSpec: AiPersonalizeSpec | null;
  readonly sorted: Extract<AnalyzeResult, { kind: "assessed" }>["signals"];
  readonly templateLine: (index: number) => string | undefined;
  readonly openSignals: ReadonlySet<string>;
  readonly onToggleSignal: (key: string) => void;
  readonly onSignalLink: (key: string) => void;
  readonly visibleSections: ReadonlySet<string>;
  readonly liveEntry: LiveTokenEntry | null;
}): JSX.Element {
  const jumpToSignal = onSignalLink;
  const pluginViews = result.pluginResults === undefined ? [] : toPluginResultViews(result.pluginResults);
  const plan = planLayout({
    score: result.score,
    signalCount: result.signals.length,
    severeSignalCount: result.signals.filter((signal) => signal.severity === "high").length,
    pluginFindingCount: pluginViews.reduce((total, view) => total + view.findings.length, 0),
    cantTellCount: result.cantTell.length,
  });
  // Deterministic priority baseline (S-067, K-035, P-25): frozen priorities
  // plus validated frontmatter give the plugin order with matched tags.
  // Zero network calls; the text never leaves the device here.
  const frontmatterViews = (plugins ?? [])
    .filter(
      (plugin): plugin is typeof plugin & { frontmatter: NonNullable<typeof plugin.frontmatter> } =>
        plugin.frontmatter !== undefined &&
        (plugin.frontmatter.severity.max === "low" ||
          plugin.frontmatter.severity.max === "medium" ||
          plugin.frontmatter.severity.max === "high"),
    )
    .map((plugin) => ({
      id: plugin.id,
      tags: plugin.frontmatter.tags,
      severityMax: plugin.frontmatter.severity.max as "low" | "medium" | "high",
    }));
  const match = matchPriorities(priorities, frontmatterViews);
  const aiActive = aiSpec !== null;
  // Experimental AI order (S-070, K-519, P-28): the validated spec wins
  // over the deterministic match; any invalid or missing spec already
  // fell back to null, so the baseline stands unchanged.
  const sectionOrder = aiActive
    ? applyAiSectionOrder(plan, aiSpec, requiredFlooredSections(result.signals))
    : plan;
  // Field picker (S-100, K-023): picked sections render in plan order.
  // Only pickable sections are ever hidden; the pinned score and any
  // non-pickable id (AI layouts may order extra ids) always pass through.
  const pickableIds = new Set(PICKABLE_SECTIONS.map((section) => section.id));
  const shownSections = sectionOrder.filter(
    (sectionId) => !pickableIds.has(sectionId) || visibleSections.has(sectionId),
  );
  const emphasisOf = new Map((aiSpec?.placements ?? []).map((placement) => [placement.sectionId, placement.emphasis]));
  const collapsed = new Set(
    (aiSpec?.placements ?? []).filter((placement) => placement.collapsed).map((placement) => placement.sectionId),
  );
  const [aiExpanded, setAiExpanded] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setAiExpanded(new Set());
  }, [aiSpec]);
  const pluginOrder = aiActive ? aiSpec.pluginRanking : match.orderedIds;
  const activeMatchedTags = aiActive ? new Map<string, readonly string[]>() : match.matchedTags;
  const personalized = aiActive || (!standardOrder && match.orderedIds.length > 0);
  const blocks: Record<string, JSX.Element> = {
    // The score ring and headline now live in the verdict header above the
    // tabs (S-118); the pinned "score" section keeps the risk gauges under
    // their own h2 so the heading outline never skips (h1 → h2 → h3).
    score: (
      <section className="card" aria-label="Risk breakdown" style={{ marginBottom: 20 }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 20 }}>Risk breakdown</h2>
        <div className="gauges">
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
      </section>
    ),
    explanation: (
      <ExplanationList
        claims={result.explanation.claims}
        signals={sorted}
        templateVersion={result.explanation.templateVersion}
        expert={mode === "expert"}
        onSignalLink={jumpToSignal}
      />
    ),
    signals: (
      <section className="card" aria-label="Signals" style={{ marginBottom: 20 }}>
        <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>
          <span>Signals</span> <Explain explainKey="evidence:selector" label="Signals" />
        </h2>
        <p className="quiet numeric" style={{ margin: "0 0 8px" }}>
          {result.signals.length} found · sorted by impact on the score
        </p>
        <SignalList
          signals={sorted}
          target={result.target}
          codeHash={result.codeHash}
          deepening={result.deepening}
          expert={mode === "expert"}
          open={openSignals}
          onToggle={onToggleSignal}
          templateLine={templateLine}
        />
      </section>
    ),
    "plugin-findings": (
      <section className="card" aria-label="Plugins section" style={{ marginBottom: 20 }}>
        <PluginsPanel
          plugins={plugins}
          results={pluginViews}
          order={pluginOrder}
          matchedTags={activeMatchedTags}
          personalized={personalized}
          onShowStandardOrder={onShowStandardOrder}
        />
      </section>
    ),
    "cant-tell": <CantTellPanel entries={result.cantTell} />,
  };
  return (
    <div>
      <div className="token-grid">
        <div>
          {shownSections.map((sectionId, sectionIndex) => {
            const collapsedByAi = collapsed.has(sectionId) && !aiExpanded.has(sectionId);
            if (collapsedByAi) {
              return (
                <div key={sectionId} data-section={sectionId} data-collapsed="true">
                  <button
                    type="button"
                    className="button-ghost"
                    data-testid={`ai-expand-${sectionId}`}
                    onClick={() => setAiExpanded(new Set([...aiExpanded, sectionId]))}
                  >
                    Show {sectionId}
                  </button>
                </div>
              );
            }
            return (
              <div
                key={sectionId}
                data-section={sectionId}
                data-emphasis={emphasisOf.get(sectionId) ?? "normal"}
                className="fade-sec"
                style={{ "--sec-i": sectionIndex + 1 } as CSSProperties}
              >
                {emphasisOf.get(sectionId) === "high" ? (
                  <p className="quiet" data-testid={`ai-emphasis-${sectionId}`} style={{ fontSize: 13 }}>
                    Highlighted for you.
                  </p>
                ) : null}
                {blocks[sectionId]}
              </div>
            );
          })}
          {mode === "expert" ? <ExpertDetail result={result} /> : null}
        </div>
        <Sidebar result={result} expert={mode === "expert"} liveEntry={liveEntry} />
      </div>
    </div>
  );
}

function LoadingNotice(): JSX.Element {
  return (
    <div className="card" role="status" style={{ marginBottom: 20 }}>
      <p className="muted" style={{ margin: 0 }}>
        Analyzing… the deterministic result appears here when ready.
      </p>
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
        detail: "The request was rejected (401): check the API key and try again.",
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
        detail: `Server error (${reason.status}): please retry in a bit.`,
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
      symbol: value.tokenSymbol ?? null,
      name: value.tokenName ?? null,
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

// One true sentence under the ring (S-117): the band word always comes
// from the score, never from a probability. The clause comes from the
// strongest fired signal for the top-probability risk; with no signal for
// that risk the sentence says so instead of asserting an unproven claim.
export function meaningSentence(result: Extract<AnalyzeResult, { kind: "assessed" }>): string {
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
  const word = riskWord(result.score);
  const label = riskLabel(topRiskValue);
  const strongest = strongestSignal(result.signals, topRiskValue);
  const clause = strongest === undefined ? `no specific ${topRiskValue} pattern found` : plainReason(strongest);
  return `${word} risk (${percent}% ${topRiskValue}): ${label} — ${clause}`;
}
