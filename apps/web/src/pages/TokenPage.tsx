import { useCallback, useEffect, useRef, useState, type CSSProperties, type JSX } from "react";
import { ApiError, analyzeToken, fetchAssessment, fetchHealth, fetchPlugins, requestInvestigation } from "../lib/api.ts";
import { ExpertDetail } from "../components/ExpertDetail.tsx";
import { ExpertSwitch } from "../components/ExpertSwitch.tsx";
import { MotionSwitch } from "../components/MotionSwitch.tsx";
import { PluginsPanel } from "../components/PluginsPanel.tsx";
import type { PluginListEntry } from "../components/PluginsPanel.tsx";
import { toPluginResultViews } from "../lib/plugins.ts";
import { isValidAddress } from "../lib/validate.ts";
import type { TokenView } from "../lib/route.ts";
import { PluginBoard, buildBoardModel } from "../components/plugins/PluginBoard.tsx";
import { PluginDetailView } from "../components/plugins/PluginDetail.tsx";
import type { ExplainEvidenceEntry } from "../components/code/CodeView.tsx";
import { copyForPluginId, slugForPluginId } from "../lib/pluginCopy.ts";
import { buildSelectorNames } from "../lib/selectorNames.ts";
import { planLayout } from "../lib/layout.ts";
import { readStoredMode, writeStoredMode } from "../lib/uiMode.ts";
import type { UiMode } from "../lib/uiMode.ts";
import { fetchLiveTokens } from "../lib/liveTokens.ts";
import type { LiveTokenEntry } from "../lib/liveTokens.ts";
import { resolveTokenIdentity } from "../lib/tokenIdentity.ts";
import { TokenHeader } from "../components/TokenHeader.tsx";
import { clearStoredPriorities, readStoredPriorities, writeStoredPriorities } from "../lib/priorities.ts";
import { matchPriorities } from "../lib/matcher.ts";
import { riskBand, riskWord } from "../lib/risk.ts";
import { toAiAvailability, type AiFeatureAvailability, type Availability } from "../lib/capabilities.ts";
import { assignTemplateLines } from "../lib/claims.ts";
import {
  emptyGaugeReason,
  plainReason,
  signalKey,
  signalTitle,
  sortByImpact,
  strongestSignal,
} from "../lib/signals.ts";
import { PowersStrip } from "../components/PowersStrip.tsx";
import { StreamView } from "../components/StreamView.tsx";
import { MuseConsole } from "../components/MuseConsole.tsx";
import { CantTellPanel } from "../components/CantTellPanel.tsx";
import { ExplanationList } from "../components/ExplanationList.tsx";
import { Gauge } from "../components/Gauge.tsx";
import { ScoreRing } from "../components/ScoreRing.tsx";
import { truncateHash, useRingOutOfView } from "../lib/summaryStrip.ts";
import { ContractFacts } from "../components/ContractFacts.tsx";
import { SignalList } from "../components/SignalList.tsx";
import { Explain } from "../components/Explain.tsx";
import type { AnalyzeResult, AssessmentState, HealthState, InvestigationState, InvestigationStep, ProviderInfo, RiskKind } from "../types.ts";
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

// Token page: combined score ring with a meaning sentence, three gauges,
// full template explanation, expandable evidence, Can't-tell panel and
// sidebar. The fast path renders first; while x-deepening-status is
// pending the page re-reads /v1/analyze on a capped poll and merges
// snippets only: score and probabilities are asserted unchanged and the
// deterministic result object is otherwise kept intact. When the poll cap
// exhausts, the streaming promise hides instead of leaving a lying line.
const LAST_TILE_KEY = "brandklipparen-last-plugin-tile";

export function TokenPage({
  address,
  view = { kind: "main" },
  apiKey,
  onHome,
}: {
  readonly address: string;
  readonly view?: TokenView | undefined;
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
  // The Ask field doubles as the priorities text (UI v2 §1.4, K-035): one
  // versioned `localStorage` key, read once at start-up, written on edit,
  // removed on clear. Typing only re-runs the local tile match.
  const [question, setQuestion] = useState<string>(() => readStoredPriorities());
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
    chat: "available",
    rug: "available",
    explainCode: "available",
    onchain: "available",
  });
  // Raw /health for the console's Explain fallback chain (UI v2 §1.2):
  // the first configured source among explain, rug and assessment wins.
  const [health, setHealth] = useState<HealthState | null>(null);
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
      (response) => {
        if (cancelled) {
          return;
        }
        setHealth(response);
        if ("disabled" in response.assessment) {
          setProvider({ status: "disabled" });
        } else {
          setProvider({
            status: "ready",
            provider: response.assessment.provider,
            modelId: response.assessment.modelId,
          });
        }
        setAvailability(toAiAvailability(response));
      },
      () => {
        if (!cancelled) {
          setHealth(null);
          setProvider({ status: "disabled" });
          setAvailability({
            investigation: "unavailable",
            explain: "unavailable",
            chat: "unavailable",
            rug: "unavailable",
            explainCode: "unavailable",
            onchain: "unavailable",
          });
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
    return () => {
      cancelled = true;
    };
  }, [apiKey]);

  // Plugin sub-level navigation (UI v2 §1.3): the analysis fetch stays
  // keyed on `address` only, so moving between views never refetches.
  // Entering the board scrolls to it and focuses its heading; returning
  // from a detail restores focus to the tile that was opened. Detail
  // entry (scroll, focus, title) lives in PluginDetailView itself.
  const previousViewKind = useRef(view.kind);
  useEffect(() => {
    const previous = previousViewKind.current;
    previousViewKind.current = view.kind;
    if (view.kind === "plugins" && result?.kind === "assessed") {
      const identity = resolveTokenIdentity(result, liveEntry);
      document.title = `${identity.symbol ?? "Token"} · Brandklipparen`;
      if (previous !== "plugins") {
        window.setTimeout(() => {
          const heading = document.getElementById("plugin-board");
          heading?.scrollIntoView({ block: "start" });
          heading?.focus({ preventScroll: true });
        }, 0);
      }
      return;
    }
    if (view.kind === "main" && result?.kind === "assessed") {
      const identity = resolveTokenIdentity(result, liveEntry);
      document.title = `${identity.symbol ?? "Token"} · Brandklipparen`;
    }
    if (view.kind !== "plugin" && previous === "plugin") {
      let slug: string | null = null;
      try {
        slug = sessionStorage.getItem(LAST_TILE_KEY);
      } catch {
        slug = null;
      }
      if (slug !== null && slug !== "") {
        window.setTimeout(() => {
          const tile = document.querySelector(
            `[data-tile-slug="${CSS.escape(slug as string)}"]`,
          ) as HTMLElement | null;
          tile?.scrollIntoView({ block: "center" });
          tile?.focus({ preventScroll: true });
        }, 0);
      }
    }
  }, [view, result, liveEntry]);

  // Remember the opened tile for focus restore (refined on detail entry).
  useEffect(() => {
    if (view.kind === "plugin") {
      try {
        sessionStorage.setItem(LAST_TILE_KEY, view.slug);
      } catch {
        // Session storage is a convenience only; the app works without it.
      }
    }
  }, [view]);

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

  const detailActive = result !== null && result.kind === "assessed" && view.kind === "plugin";
  const setStoredMode = (next: UiMode): void => {
    setMode(next);
    writeStoredMode(next);
  };
  return (
    <div className="page">
      {detailActive ? null : (
        <div className="detail-toolbar" style={{ marginBottom: 8 }}>
          <button type="button" className="button-ghost" onClick={onHome}>
            ← Search
          </button>
          <ExpertSwitch mode={mode} onModeChange={setStoredMode} />
        </div>
      )}
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
          plugins={plugins}
          view={view}
          mode={mode}
          onModeChange={(next) => {
            setMode(next);
            writeStoredMode(next);
          }}
          question={question}
          onQuestionChange={(text) => {
            setQuestion(text);
            writeStoredPriorities(text);
          }}
          onQuestionClear={() => {
            clearStoredPriorities();
            setQuestion("");
          }}
          availability={availability}
          health={health}
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
        />
      ) : null}
      <footer className="page-foot">
        <MotionSwitch />
        {result !== null && result.kind === "assessed" ? (
          <span className="foot-model">Model {result.modelVersion}</span>
        ) : null}
      </footer>
    </div>
  );
}

function AssessedView({
  result,
  plugins,
  view,
  mode,
  onModeChange,
  question,
  onQuestionChange,
  onQuestionClear,
  availability,
  health,
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
}: {
  readonly result: Extract<AnalyzeResult, { kind: "assessed" }>;
  readonly plugins: readonly PluginListEntry[] | null;
  readonly mode: UiMode;
  readonly onModeChange: (mode: UiMode) => void;
  readonly question: string;
  readonly onQuestionChange: (text: string) => void;
  readonly onQuestionClear: () => void;
  readonly availability: AiFeatureAvailability;
  readonly health: HealthState | null;
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
  readonly view: TokenView;
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
      if (!openSignals.has(key)) {
        onToggleSignal(key);
      }
      // The signal article may not exist yet on the first console click,
      // so retry until it commits, then scroll and focus it.
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
    [onToggleSignal, openSignals],
  );
  // Summary strip visibility (UI v2 §1): with the tabs gone the strip no
  // longer depends on any tab. It stays unmounted while the combined
  // score ring is in view and pins to the viewport top once the ring has
  // scrolled out, so it never covers the ring or the gauge cards.
  const ringRef = useRef<HTMLElement | null>(null);
  const stripVisible = useRingOutOfView(ringRef);
  // R-5: the full string rides along as the accessible title, so sighted
  // readers on <= 480 px (where the row truncates with ellipsis) still get
  // every value on hover or long-press, matching the code-hash span below.
  const stripProbs = RISKS.map(
    (risk) => `${RISK_SHORT[risk]} ${Math.round(result.probabilities[risk] * 100)}%`,
  ).join(" · ");
  // R2-2 (D-6): the verdict hero owns the risk breakdown at every width.
  // The gauges always render inside the hero, so the DOM order stays
  // hero → gauges → Muse console and no separate overview score card
  // can appear after the console on narrow screens.
  // Owner-powers strip (UI v2 §1.1, W-9): the same board model as the
  // plugin board below, so the hero chips and the tiles never disagree.
  const heroPluginViews = result.pluginResults === undefined ? [] : toPluginResultViews(result.pluginResults);
  const heroBoard = buildBoardModel(plugins, heroPluginViews);
  const heroIds = (plugins ?? []).map((entry) => entry.id);
  const heroHasSignals = result.signals.length > 0;
  // Plugin detail view (UI v2 §1.3 level 2): a route, not a modal. The
  // analysis above stays mounted on the same state; only the rendered
  // level changes, so entering never refetches.
  if (view.kind === "plugin") {
    const detailViews = result.pluginResults === undefined ? [] : toPluginResultViews(result.pluginResults);
    const board = buildBoardModel(plugins, detailViews);
    const tile = board.bySlug.get(view.slug) ?? null;
    const allIds = (plugins ?? []).map((entry) => entry.id);
    const entry = plugins?.find((candidate) => slugForPluginId(candidate.id, allIds) === view.slug);
    const position = board.allTiles.findIndex((candidate) => candidate.slug === view.slug);
    const identity = resolveTokenIdentity(result, liveEntry);
    const detailResult = tile === null ? undefined : detailViews.find((view) => view.pluginId === tile.pluginId);
    const decompilerFindings =
      detailViews.find((view) => view.pluginId === "dev.brandklipparen.decompiler")?.findings ?? [];
    const names = buildSelectorNames(decompilerFindings);
    // VS-2 evidence chips: every plugin finding of this analysis, id to
    // label plus the code locations that prove it.
    const evidenceIndex = new Map<string, ExplainEvidenceEntry>();
    for (const resultView of detailViews) {
      for (const finding of resultView.findings) {
        evidenceIndex.set(finding.id, {
          label: finding.title,
          targets: finding.evidence.map((entry) => ({ selector: entry.selector, offset: entry.offset })),
        });
      }
    }
    return (
      <PluginDetailView
        address={address}
        apiKey={apiKey}
        symbol={identity.symbol ?? "Token"}
        slug={view.slug}
        tile={tile}
        entry={entry}
        findings={detailResult?.findings ?? []}
        names={names}
        modelVersion={result.modelVersion}
        mode={mode}
        onModeChange={onModeChange}
        prev={position > 0 ? (board.allTiles[position - 1] ?? null) : null}
        next={position >= 0 ? (board.allTiles[position + 1] ?? null) : null}
        fn={view.fn}
        codeView={view.view}
        codePc={view.pc}
        availability={availability}
        evidenceIndex={evidenceIndex}
      />
    );
  }
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
        <div className="score-ring-wrap">
          <div className="hero-copy" style={{ flex: "1 1 240px" }}>
            <p className="risk-meaning" style={{ margin: "0 0 8px" }}>
              <span className="headline-marker" aria-hidden="true">
                &gt;{" "}
              </span>
              <span>{meaningSentence(result)}</span> <Explain explainKey="score:combined" label="Combined score" />
            </p>
            <PowersStrip address={address} allIds={heroIds} tiles={heroBoard.ownerTiles} />
            {mode === "expert" ? (
              <p className="quiet" style={{ margin: "4px 0 0" }}>
                Calibration report: see the model card. The v1 REST response carries no calibration numbers, so none
                are shown here.
              </p>
            ) : null}
            <div className="hero-gauges">
              <h2 style={{ margin: "12px 0 10px", fontSize: 20 }}>Risk breakdown</h2>
              <div className="gauges gauges-hero">
                {RISKS.map((risk) => {
                  const top = strongestSignal(result.signals, risk);
                  const count = result.signals.filter((signal) => signal.risk === risk).length;
                  return (
                    <Gauge
                      key={risk}
                      kind={risk}
                      probability={result.probabilities[risk]}
                      signalCount={count}
                      reason={top === undefined ? emptyGaugeReason(heroHasSignals) : plainReason(top)}
                    />
                  );
                })}
              </div>
            </div>
          </div>
          <ScoreRing score={result.score} />
        </div>
      </section>
      <MuseConsole
        address={address}
        apiKey={apiKey}
        health={health}
        availability={availability}
        score={result.score}
        assessment={assessment}
        provider={provider}
        onRequestAssessment={onRequestAssessment}
        investigation={investigation}
        onRunInvestigation={onRunInvestigation}
        signals={sorted}
        onSignalLink={jumpToSignal}
        question={question}
        onQuestionChange={onQuestionChange}
        onQuestionClear={onQuestionClear}
      />
      {stripVisible ? (
        <div className="compact-strip" aria-label="Result summary" data-testid="result-summary">
          <span className="numeric">
            <strong>{result.score}</strong> {riskWord(result.score)}
          </span>
          <Explain explainKey="score:strip" label="Result summary" />
          <span className="numeric compact-strip-probs" title={stripProbs}>
            {stripProbs}
          </span>
          <span className="mono numeric compact-strip-hash" title={result.codeHash}>
            {truncateHash(result.codeHash)}
          </span>
        </div>
      ) : null}
      <OverviewSections
        result={result}
        plugins={plugins}
        address={address}
        mode={mode}
        question={question}
        apiKey={apiKey}
        onchainAvailability={availability.onchain}
        sorted={sorted}
        templateLine={templateLine}
        openSignals={openSignals}
        onToggleSignal={onToggleSignal}
        onSignalLink={jumpToSignal}
        liveEntry={liveEntry}
      />
      {mode === "expert" ? <StreamView address={address} apiKey={apiKey} /> : null}
    </div>
  );
}

// Overview sections in deterministic risk-adaptive order (S-060, K-034,
// P-19, W-8): the plan comes from the frozen analysis only, DOM order
// equals visual order, and every section always renders. The Ask field
// text only highlights matching plugin tiles through the local matcher
// (K-035, zero network); plugin order stays deterministic. Scores,
// evidence and finding text never move.
export function OverviewSections({
  result,
  plugins,
  address,
  mode,
  apiKey,
  onchainAvailability,
  question,
  sorted,
  templateLine,
  openSignals,
  onToggleSignal,
  onSignalLink,
  liveEntry,
}: {
  readonly result: Extract<AnalyzeResult, { kind: "assessed" }>;
  readonly plugins: readonly PluginListEntry[] | null;
  readonly address: string;
  readonly mode: UiMode;
  readonly apiKey: string;
  readonly onchainAvailability: Availability;
  readonly question: string;
  readonly sorted: Extract<AnalyzeResult, { kind: "assessed" }>["signals"];
  readonly templateLine: (index: number) => string | undefined;
  readonly openSignals: ReadonlySet<string>;
  readonly onToggleSignal: (key: string) => void;
  readonly onSignalLink: (key: string) => void;
  readonly liveEntry: LiveTokenEntry | null;
}): JSX.Element {
  const jumpToSignal = onSignalLink;
  // The deterministic "Show standard order" choice (K-035): the third-party
  // fallback orders matched cards first through the local match; the
  // visitor can always go back to the untouched registry order. Typing a
  // new question restarts from the matched order.
  const [showStandard, setShowStandard] = useState(false);
  useEffect(() => {
    setShowStandard(false);
  }, [question]);
  const pluginViews = result.pluginResults === undefined ? [] : toPluginResultViews(result.pluginResults);
  // Third-party ids (no board copy entry) keep rendering in the generic
  // PluginsPanel fallback; first-party detectors render as board tiles.
  const thirdPartyPlugins =
    plugins === null ? null : plugins.filter((plugin) => copyForPluginId(plugin.id) === null);
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
  const match = matchPriorities(question, frontmatterViews);
  // R2-2 (D-6): the hero always owns the gauges, so the overview never
  // renders a separate score section. The local match only highlights
  // tiles and orders the third-party fallback; it never reorders the
  // overview.
  const shownSections = plan.filter((sectionId) => sectionId !== "score");
  const personalized = !showStandard && match.orderedIds.length > 0;
  const blocks: Record<string, JSX.Element> = {
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
      <div style={{ marginBottom: 20 }}>
        <PluginBoard
          address={address}
          plugins={plugins}
          results={pluginViews}
          matchedTags={match.matchedTags}
        />
        {thirdPartyPlugins === null || thirdPartyPlugins.length === 0 ? null : (
          <section className="card" aria-label="Plugins section" style={{ marginTop: 20 }}>
            <PluginsPanel
              plugins={thirdPartyPlugins}
              results={pluginViews}
              order={[...match.orderedIds]}
              matchedTags={match.matchedTags}
              personalized={personalized}
              source="deterministic"
              onShowStandardOrder={() => setShowStandard(true)}
            />
          </section>
        )}
      </div>
    ),
    "cant-tell": <CantTellPanel entries={result.cantTell} />,
  };
  // Rendered ids only: drop any section without an overview block.
  const renderedSections = shownSections.filter((sectionId) => blocks[sectionId] !== undefined);
  return (
    <div>
      <div className="token-grid">
        <div>
          {renderedSections.map((sectionId, sectionIndex) => (
            <div
              key={sectionId}
              data-section={sectionId}
              className="fade-sec"
              tabIndex={-1}
              style={{ "--sec-i": sectionIndex + 1 } as CSSProperties}
            >
              {blocks[sectionId]}
            </div>
          ))}
          {mode === "expert" ? <ExpertDetail result={result} /> : null}
        </div>
        <ContractFacts
          result={result}
          expert={mode === "expert"}
          liveEntry={liveEntry}
          address={address}
          apiKey={apiKey}
          availability={onchainAvailability}
        />
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
      <div aria-hidden="true">
        <span className="skel" />
        <span className="skel" />
        <span className="skel" />
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

// Verdict sentence (UI v2 §1.1, W-9): the band word always comes from
// the score, never from a probability. The clause is the strongest
// fired signal in plain words, with no percent and no repeated risk
// name. With no signal at all the sentence says what was checked
// instead of asserting an unproven claim.
export function meaningSentence(result: Extract<AnalyzeResult, { kind: "assessed" }>): string {
  const word = riskWord(result.score);
  const [top] = sortByImpact(result.signals);
  if (top === undefined) {
    return `${word} risk. No owner power found in the code we could read. That is not the same as safe.`;
  }
  const clause = withFullStop(stripSeverityWord(plainReason(top)));
  return `${word} risk. ${clause}`;
}

// Pattern-titled findings carry their severity in parens ("Honeypot
// pattern (high)"): the verdict band already names the band, so the
// clause drops it instead of stuttering.
function stripSeverityWord(clause: string): string {
  return clause.replace(/\s*\((low|medium|high)\)\s*\.?$/i, "");
}

function withFullStop(clause: string): string {
  const trimmed = clause.trim();
  return trimmed.endsWith(".") ? trimmed : `${trimmed}.`;
}
