import { useCallback, useEffect, useRef, useState, type CSSProperties, type JSX } from "react";
import { ApiError, analyzeToken, fetchAssessment, fetchHealth, fetchPlugins, requestInvestigation } from "../lib/api.ts";
import { ExpertDetail } from "../components/ExpertDetail.tsx";
import { ExpertSwitch } from "../components/ExpertSwitch.tsx";
import { PluginsPanel } from "../components/PluginsPanel.tsx";
import type { PluginListEntry } from "../components/PluginsPanel.tsx";
import { toPluginResultViews } from "../lib/plugins.ts";
import { isValidAddress } from "../lib/validate.ts";
import type { TokenView } from "../lib/route.ts";
import { PluginBoard, buildBoardModel } from "../components/plugins/PluginBoard.tsx";
import type { BoardTile } from "../components/plugins/PluginBoard.tsx";
import { PluginDetailView } from "../components/plugins/PluginDetail.tsx";
import type { ExplainEvidenceEntry } from "../components/code/CodeView.tsx";
import { copyForPluginId, slugForPluginId } from "../lib/pluginCopy.ts";
import { buildSelectorNames } from "../lib/selectorNames.ts";
import { planLayout } from "../lib/layout.ts";
import { readStoredMode, writeStoredMode } from "../lib/uiMode.ts";
import type { UiMode } from "../lib/uiMode.ts";
import { fetchLiveTokens } from "../lib/liveTokens.ts";
import type { LiveTokenEntry } from "../lib/liveTokens.ts";
import { resolveTokenIdentity, textHasNonAscii, tokenDisplayText } from "../lib/tokenIdentity.ts";
import { TokenHeader } from "../components/TokenHeader.tsx";
import { clearStoredPriorities, readStoredPriorities, writeStoredPriorities } from "../lib/priorities.ts";
import { matchPriorities } from "../lib/matcher.ts";
import { riskBand, riskWord } from "../lib/risk.ts";
import { toAiAvailability, type AiFeatureAvailability, type Availability } from "../lib/capabilities.ts";
import { emptyGaugeReason, plainReason, signalTitle, sortByImpact, strongestSignal } from "../lib/signals.ts";
import { floorMarkFor } from "../lib/floorPowers.ts";
import { PowersStrip } from "../components/PowersStrip.tsx";
import { StreamView } from "../components/StreamView.tsx";
import { MuseConsole } from "../components/MuseConsole.tsx";
import { CantTellPanel } from "../components/CantTellPanel.tsx";
import { ExplanationList } from "../components/ExplanationList.tsx";
import { Gauge } from "../components/Gauge.tsx";
import { ScoreRing } from "../components/ScoreRing.tsx";
import { LoadingNotice, TokenErrorCard, type TokenLoadError } from "../components/LoadingState.tsx";
import { truncateHash, useRingOutOfView } from "../lib/summaryStrip.ts";
import { ContractFacts } from "../components/ContractFacts.tsx";
import { Explain } from "../components/Explain.tsx";
import type { AnalyzeResult, AssessmentState, HealthState, InvestigationState, InvestigationStep, ProviderInfo, RiskKind } from "../types.ts";
import { RISK_SHORT } from "../lib/risk.ts";

const RISKS: readonly RiskKind[] = ["rug-pull", "honeypot", "bot-pump"];

// Main-view document title (round-3 D-23): the symbol plus the score
// and band, so the judge's tab bar shows the result.
export function tokenPageTitle(symbol: string, score: number): string {
  return `${symbol} · ${score} ${riskWord(score)} · Brandklipparen`;
}

// Verdict header band colour (S-121, S-132): the risk band colour for
// the 1px top border and the headline caret, passed as --verdict-band
// so the stylesheet owns the edge. Same riskBand source as RiskBadge,
// so caret, border and badge can never disagree.
export function calibrationNote(modelVersion: string): string | null {
  return modelVersion === "1.0.1"
    ? "Model 1.0.1 calibration: scores cluster at 19\u201330, so Low is not a safety pass. Check the owner powers above."
    : null;
}

export function verdictBandColor(score: number): string {
  const word = riskBand(score).word;
  return word === "Low" ? "var(--low)" : word === "Elevated" ? "var(--elevated)" : "var(--high)";
}

// Token page: combined score ring with a meaning sentence, three gauges,
// full template explanation, expandable evidence, Can't-tell panel and
// sidebar. Each token view fetches /v1/analyze exactly once and renders
// the deterministic result as-is; there is no follow-up poll.
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
  const [loadError, setLoadError] = useState<TokenLoadError | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setLoadError(null);
    setElapsed(null);
    setAssessment({ status: "idle" });
    setInvestigation({ status: "idle" });
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
      document.title = tokenPageTitle(identity.symbol ?? "Token", result.score);
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
      document.title = tokenPageTitle(identity.symbol ?? "Token", result.score);
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

  // Stable retry for the error card countdown: a new identity every
  // render would restart the auto-retry timer before it ever fires.
  const retryAnalysis = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

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
        return fetchAssessment(address, key, result?.block).then(
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
  }, [address, apiKey, result]);

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
    requestInvestigation(address, key, onStep, result?.block).then(
      ({ state }) => setInvestigation(state),
      (reason: unknown) => {
        setInvestigation({
          status: "failed",
          message: reason instanceof Error ? reason.message : "Investigation failed.",
          steps: [],
        });
      },
    );
  }, [address, apiKey, result]);

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
      {result !== null && result.kind === "assessed" ? null : result === null && loadError === null ? (
        <LoadingNotice />
      ) : loadError !== null ? null : (
        <p className="muted numeric" style={{ margin: "0 0 12px" }}>
          {`Analysis complete${elapsed === null ? "" : ` in ${elapsed.toFixed(1)} s`}.`}
        </p>
      )}
      {loadError !== null ? (
        <TokenErrorCard key={attempt} error={loadError} onRetry={retryAnalysis} />
      ) : null}
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
          address={address}
          liveEntry={liveEntry}
          apiKey={apiKey}
        />
      ) : null}
      <footer className="page-foot">
        <span className="foot-trust">Deterministic score · Muse is advisory</span>
        <a className="foot-settings" href="#/settings">
          Use your own API key
        </a>
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
  readonly address: string;
  readonly liveEntry: LiveTokenEntry | null;
  readonly apiKey: string;
  readonly view: TokenView;
}): JSX.Element {
  const sorted = sortByImpact(result.signals);
  // Console and investigation links arrive as stable position-derived
  // keys, so the scroll target uses the same unique key as the article
  // DOM id. The native evidence disclosure opens, then focus follows the
  // scroll so keyboard users land on the linked signal (S-125).
  const jumpToSignal = useCallback((key: string) => {
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
      target?.querySelector("details")?.setAttribute("open", "");
      target?.scrollIntoView({ block: "start" });
      const control = target?.querySelector(":scope summary");
      if (control instanceof HTMLElement) {
        control.focus();
      }
    };
    window.setTimeout(reveal, 0);
  }, []);
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
  const heroBoard = buildBoardModel(plugins, heroPluginViews, {
    scoreFloor: result.scoreFloor,
    ownerState: result.ownerState,
  });
  const heroIds = (plugins ?? []).map((entry) => entry.id);
  const heroHasSignals = result.signals.length > 0;
  // R2-5 (D-17): glue the verdict "?" to the last headline word, so the
  // trigger never wraps onto its own line. The head keeps a normal
  // space so the line can still break before the final word.
  const verdictSentence = meaningSentence(result, heroBoard.ownerTiles);
  const verdictSplit = verdictSentence.lastIndexOf(" ");
  const verdictHead = verdictSplit < 0 ? "" : verdictSentence.slice(0, verdictSplit);
  const verdictTail = verdictSplit < 0 ? verdictSentence : verdictSentence.slice(verdictSplit + 1);
  // Plugin detail view (UI v2 §1.3 level 2): a route, not a modal. The
  // analysis above stays mounted on the same state; only the rendered
  // level changes, so entering never refetches.
  if (view.kind === "plugin") {
    const detailViews = result.pluginResults === undefined ? [] : toPluginResultViews(result.pluginResults);
    const board = buildBoardModel(plugins, detailViews, {
      scoreFloor: result.scoreFloor,
      ownerState: result.ownerState,
    });
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
    // Owner-only fallback (R3 D-8): the selectors the ownership proof
    // touches tag decompiler rows owner-only when the annotation is
    // absent. Display only.
    const ownerOnlySelectors = new Set<string>();
    for (const resultView of detailViews) {
      for (const finding of resultView.findings) {
        evidenceIndex.set(finding.id, {
          label: finding.title,
          targets: finding.evidence.map((entry) => ({ selector: entry.selector, offset: entry.offset })),
        });
        if (resultView.pluginId === "dev.brandklipparen.ownership") {
          for (const target of finding.evidence) {
            ownerOnlySelectors.add(target.selector.toLowerCase());
          }
        }
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
        ownerOnlySelectors={ownerOnlySelectors}
        block={result.block}
        codeHash={result.codeHash}
      />
    );
  }
  return (
    <div>
      <section
        className="card verdict"
        aria-label="Combined score"
        ref={ringRef}
        style={{ marginBottom: 12, "--verdict-band": verdictBandColor(result.score) } as CSSProperties}
      >
        <TokenHeader
          address={result.target}
          identity={resolveTokenIdentity(result, liveEntry)}
          liveEntry={liveEntry}
        />
        <div className="score-ring-wrap">
          <div className="hero-copy">
            <p className="risk-meaning" style={{ margin: "0 0 8px" }}>
              <span className="headline-marker" aria-hidden="true">
                &gt;{" "}
              </span>
              {verdictHead === "" ? null : <>{verdictHead} </>}
              <span className="verdict-glued">
                {verdictTail} <Explain explainKey="score:combined" label="Combined score" />
              </span>
            </p>
            <PowersStrip
              address={address}
              allIds={heroIds}
              tiles={heroBoard.ownerTiles}
              plugins={plugins}
              ownerState={result.ownerState}
              scoreFloor={result.scoreFloor}
            />
            {calibrationNote(result.modelVersion) !== null ? (
              <p className="quiet" style={{ margin: "4px 0 0" }}>
                {calibrationNote(result.modelVersion)}
              </p>
            ) : mode === "expert" ? (
              <p className="quiet" style={{ margin: "4px 0 0" }}>
                Calibration report: see the model card. The v1 REST response carries no calibration numbers, so none
                are shown here.
              </p>
            ) : null}
            <div className="hero-gauges">
              <h2 style={{ margin: "12px 0 10px", fontSize: 20 }}>
                <span>Risk breakdown</span> <Explain explainKey="score:gauges" label="Risk breakdown" />
              </h2>
              <div className="gauges gauges-hero">
                {RISKS.map((risk, riskIndex) => {
                  const top = strongestSignal(result.signals, risk);
                  const count = result.signals.filter((signal) => signal.risk === risk).length;
                  // A quiet analysis prints the usual-rate line on the
                  // first gauge only, never three times (R3 D-11).
                  const reason =
                    top === undefined
                      ? !heroHasSignals && riskIndex > 0
                        ? ""
                        : emptyGaugeReason(heroHasSignals)
                      : plainReason(top);
                  return (
                    <Gauge
                      key={risk}
                      kind={risk}
                      probability={result.probabilities[risk]}
                      signalCount={count}
                      reason={reason}
                      uncalibrated={risk === "bot-pump"}
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
        block={result.block}
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
        claims={result.explanation.claims}
        onSignalLink={jumpToSignal}
        allIds={heroIds}
        verdict={verdictSentence}
        checkCount={heroPluginViews.length}
        question={question}
        onQuestionChange={onQuestionChange}
        onQuestionClear={onQuestionClear}
        foundSlugs={heroBoard.ownerTiles
          .filter((tile) => tile.state === "found-scored" || tile.state === "extended")
          .map((tile) => tile.copy.slug)}
      />
      <div
        className="compact-strip"
        aria-label="Result summary"
        data-testid="result-summary"
        hidden={!stripVisible}
      >
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
      <OverviewSections
        result={result}
        plugins={plugins}
        address={address}
        mode={mode}
        question={question}
        apiKey={apiKey}
        onchainAvailability={availability.onchain}
        sorted={sorted}
        liveEntry={liveEntry}
      />
      {mode === "expert" ? <StreamView address={address} apiKey={apiKey} /> : null}
    </div>
  );
}

// R2-7 (D-8): each overview section maps onto its grid area. The DOM
// stays content-first (main, board, cant, facts): at desktop the facts
// card is a complementary aside placed top-right, and below 1100 px the
// visual order matches the DOM with the facts below the board.
const GRID_AREA_CLASS: Record<string, string> = {
  explanation: "token-main",
  "plugin-findings": "token-board",
  "cant-tell": "token-cant",
};

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
  readonly liveEntry: LiveTokenEntry | null;
}): JSX.Element {
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
  // R2-6 (D-5): the scored patterns merge into the single "Why this
  // score" card. The plan still emits both ids, so map the old signals
  // position onto the merged card and render it once at the earliest
  // spot: first for high risk, right after the hero otherwise.
  const decompilerFindings =
    pluginViews.find((view) => view.pluginId === "dev.brandklipparen.decompiler")?.findings ?? [];
  const selectorNames = buildSelectorNames(decompilerFindings);
  const shownSections = plan
    .filter((sectionId) => sectionId !== "score")
    .map((sectionId) => (sectionId === "signals" ? "explanation" : sectionId))
    .filter((sectionId, index, all) => all.indexOf(sectionId) === index);
  const personalized = !showStandard && match.orderedIds.length > 0;
  const blocks: Record<string, JSX.Element> = {
    explanation: (
      <ExplanationList
        claims={result.explanation.claims}
        signals={sorted}
        templateVersion={result.explanation.templateVersion}
        expert={mode === "expert"}
        scoreFloorLabel={result.scoreFloor?.label}
        bandHigh={riskBand(result.score).word === "High"}
        address={address}
        codeHash={result.codeHash}
        apiKey={apiKey}
        names={selectorNames}
        block={result.block}
      />
    ),
    "plugin-findings": (
      <div style={{ marginBottom: 20 }}>
        <PluginBoard
          address={address}
          plugins={plugins}
          results={pluginViews}
          matchedTags={match.matchedTags}
          scoreFloor={result.scoreFloor}
          ownerState={result.ownerState}
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
  // R3 D-13: the desktop grid follows the data. With no signals there is
  // no side column: the facts become a full-width two-column card after
  // the board. Otherwise the facts stay beside the main column as a
  // static aside, so no column sits empty beside tall content.
  const hasSignals = result.signals.length > 0;
  return (
    <div>
      <div className={`token-grid ${hasSignals ? "token-grid--side" : "token-grid--flat"}`}>
        {renderedSections.map((sectionId, sectionIndex) => (
          <div
            key={sectionId}
            data-section={sectionId}
            className={`fade-sec ${GRID_AREA_CLASS[sectionId] ?? ""}`}
            tabIndex={-1}
            style={{ "--sec-i": sectionIndex + 1 } as CSSProperties}
          >
            {blocks[sectionId]}
            {sectionId === "explanation" && mode === "expert" ? <ExpertDetail result={result} /> : null}
          </div>
        ))}
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

// Design review P1-14, R3 D-16: HTTP failures map to one plain sentence
// of cause with a retry path. Never a status code and never the raw
// message: the card shows copy only, and the detail stays generic.
export function errorCopy(reason: unknown): TokenLoadError {
  if (reason instanceof ApiError) {
    if (reason.status === 401) {
      return {
        title: "Analysis needs an API key.",
        detail: "Add the API key and try again.",
        retryable: false,
      };
    }
    if (reason.status === 429) {
      return {
        title: "Too many requests.",
        detail: "The service is busy. Retrying automatically.",
        retryable: true,
      };
    }
    if (reason.status >= 500) {
      return {
        title: "The analysis service is down.",
        detail: "Please wait a moment. Retrying automatically.",
        retryable: true,
      };
    }
    return {
      title: "Analysis failed.",
      detail: "Something went wrong. Retrying automatically.",
      retryable: true,
    };
  }
  return {
    title: "Analysis failed.",
    detail: "Something went wrong. Retrying automatically.",
    retryable: true,
  };
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
      symbol:
        value.tokenSymbol === undefined
          ? null
          : tokenDisplayText(value.tokenSymbol, value.tokenSymbolNonAscii === true || textHasNonAscii(value.tokenSymbol)),
      name:
        value.tokenName === undefined
          ? null
          : tokenDisplayText(value.tokenName, value.tokenNameNonAscii === true || textHasNonAscii(value.tokenName)),
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

// Verdict sentence (UI v2 §1.1, D-4): the band word always comes from
// the score, never from a probability or a signal title. The
// clause names owner powers from the board's owner tiles in board
// order, never a signal: found-scored powers first, then extended
// findings, then the honest nothing-found line. No percent anywhere;
// the gauges own percents.
export function meaningSentence(
  result: Extract<AnalyzeResult, { kind: "assessed" }>,
  ownerTiles: readonly BoardTile[] = [],
): string {
  const word = riskWord(result.score);
  // SCORE-4: floor facts are found powers; renounced-lifted facts are
  // neither found nor still-counted extended findings.
  const markOf = (tile: BoardTile): "floor" | "renounced" | null =>
    tile.floorMark !== undefined && tile.floorMark !== null
      ? tile.floorMark
      : floorMarkFor(tile.copy.slug, tile.state, { scoreFloor: result.scoreFloor, ownerState: result.ownerState });
  const found = ownerTiles.filter(
    (tile) => markOf(tile) !== "renounced" && (tile.state === "found-scored" || markOf(tile) === "floor"),
  );
  if (found.length > 0) {
    const named = found.filter((tile) => tile.copy.slug !== "ownership");
    const source = named.length > 0 ? named : found;
    const names = source.slice(0, 2).map((tile) => tile.copy.title.toLowerCase());
    const including = names.length === 2 ? `${names[0]} and ${names[1]}` : `${names[0]}`;
    const count = privilegedFunctionCount(found);
    if (count !== null) {
      const noun = count === 1 ? "function" : "functions";
      return `${word} risk. The owner controls ${count} ${noun}, including ${including}.`;
    }
    return `${word} risk. The owner controls ${including}.`;
  }
  const extended = ownerTiles.filter((tile) => tile.state === "extended" && markOf(tile) === null);
  if (extended.length > 0) {
    const names = extended.map((tile) => tile.copy.title.toLowerCase()).join(", ");
    const noun = extended.length === 1 ? "owner power" : "owner powers";
    return `${word} risk. Extended analysis found ${extended.length} ${noun} the score doesn't count yet: ${names}.`;
  }
  const renounced = ownerTiles.filter((tile) => markOf(tile) === "renounced");
  if (renounced.length > 0) {
    const names = renounced.map((tile) => tile.copy.title.toLowerCase()).join(", ");
    return `${word} risk. Owner renounced, so ${names} no longer applies.`;
  }
  return `${word} risk. No owner power found in the code we could read. That is not the same as safe.`;
}

// Privileged-function count for the found clause (UI v2 §1.1 example
// "controls 11 functions"): the ownership detector reports it as
// `privilegedFunctions` in a found payload. Unknown when no found
// payload carries a finite number.
function privilegedFunctionCount(tiles: readonly BoardTile[]): number | null {
  for (const tile of tiles) {
    for (const payload of tile.payloads) {
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        continue;
      }
      const value = (payload as Record<string, unknown>)["privilegedFunctions"];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return Math.trunc(value);
      }
    }
  }
  return null;
}
