// Plugin detail view, level 2 (UI v2 §1.3, §5.2, §5.3). A route, not a
// modal: browser back works, the back link is a real link so cold deep
// links work, and entering focuses the h1 and sets document.title.
// Header (typewriter status once, M-4), owner chip (proven / not
// identified), evidence rows (decompiler names, copy, lazy snippet
// expand), "can't tell you" limits, provenance from the /v1/plugins
// weight, prev/next and Expert raw. No HTML sink anywhere: every
// contract string renders as React text only.
import { useEffect, useRef, useState, type JSX } from "react";
import { ExpertSwitch } from "../ExpertSwitch.tsx";
import { Pictogram } from "../Pictogram.tsx";
import { SchemaValue } from "../SchemaValue.tsx";
import { DecompilerList } from "./DecompilerList.tsx";
import { EvidenceRow } from "./EvidenceRow.tsx";
import { ScanStatus } from "../ScanStatus.tsx";
import { OwnerChip, type ProvenOwner } from "./OwnerChip.tsx";
import { ProofTrace } from "./ProofTrace.tsx";
import { fetchOnchainFeatures, fetchProof, type OnchainFeaturesState, type ProofStep } from "../../lib/api.ts";
import type { BoardTile } from "./PluginBoard.tsx";
import { severityWord } from "./PluginTile.tsx";
import type { ExplainEvidenceEntry } from "../code/CodeView.tsx";
import type { AiFeatureAvailability, Availability } from "../../lib/capabilities.ts";
import type { PluginFindingView, PluginListEntry } from "../PluginsPanel.tsx";
import { PLUGIN_STATE_WORD } from "../../lib/pluginState.ts";
import { codeHref, type CodePaneView } from "../../lib/route.ts";
import { ranStatusWord, temporalityLine } from "../../lib/pluginCopy.ts";
import type { SelectorName } from "../../lib/selectorNames.ts";
import { selectorDisplayName, selectorShortName } from "../../lib/selectorNames.ts";
import { useTypewriter } from "../../lib/typewriter.ts";
import type { UiMode } from "../../lib/uiMode.ts";

function pluginsHref(address: string): string {
  return `#/token/${encodeURIComponent(address)}/plugins`;
}

function tileHref(address: string, tile: BoardTile): string {
  return `#/token/${encodeURIComponent(address)}/plugins/${encodeURIComponent(tile.slug)}`;
}

// Provenance (UI v2 §5.2): the /v1/plugins weight decides. Above 0 the
// check can enter the score; 0 (or an extended finding) never does.
// Without a weight (older servers) the tile state decides.
export function detailProvenance(
  state: BoardTile["state"],
  weight: number | undefined,
  modelVersion: string,
): string {
  // Analysis tools never move the score (R3 D-8); their provenance says
  // so plainly instead of borrowing the scored wording.
  if (state === "ran") {
    return "In score: no (analysis tool)";
  }
  if (state === "extended") {
    return "In score: no (extended analysis)";
  }
  if (weight !== undefined && weight <= 0) {
    return `In score: no (weight 0 in model ${modelVersion})`;
  }
  return `In score: yes (model ${modelVersion})`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// The on-chain owner feature has the same shape as the facts card reads
// (ContractFacts): an ok status plus the owner record. Anything else names
// no owner, so the row stays honest instead of inventing one.
function toProvenOwner(feature: unknown): ProvenOwner | null {
  const record = asRecord(feature);
  if (record === null || record["status"] !== "ok") {
    return null;
  }
  const owner = asRecord(record["owner"]);
  if (owner === null) {
    return null;
  }
  const kind = owner["kind"];
  const address = typeof owner["address"] === "string" ? owner["address"] : null;
  if (kind === "renounced") {
    return { address: null, kind: "renounced" };
  }
  if (kind === "safe") {
    return { address, kind: "safe-multisig" };
  }
  if (kind === "contract") {
    return { address, kind: "contract" };
  }
  if (address !== null) {
    return { address, kind: "single-key" };
  }
  return null;
}

function provenOwnerFromFeatures(features: unknown): ProvenOwner | null {
  const root = asRecord(features);
  const variants = root !== null && Array.isArray(root["variants"]) ? root["variants"] : null;
  const variant = variants === null ? null : asRecord(variants[0] ?? null);
  return variant === null ? null : toProvenOwner(variant["owner"]);
}

// Owner row for found and extended owner checks (UI v2 §5.2): analysis
// tools have no owner, so they render no row at all. Before the live read
// the row says the owner was not read yet; the button fetches the same
// on-chain features as the facts card and fills the owner chip, tagged
// "Live read · not in score" because the read never moves the score.
function DetailOwnerRow({
  address,
  apiKey,
  group,
  temporality,
  onchainAvailability,
}: {
  readonly address: string;
  readonly apiKey: string;
  readonly group: string;
  readonly temporality: string | null;
  readonly onchainAvailability: Availability;
}): JSX.Element | null {
  const [onchain, setOnchain] = useState<OnchainFeaturesState | null>(null);
  const [pending, setPending] = useState(false);
  if (group !== "owner") {
    return null;
  }
  async function onReadOwner(): Promise<void> {
    setPending(true);
    const next = await fetchOnchainFeatures(address, apiKey.length === 0 ? null : apiKey);
    setPending(false);
    setOnchain(next);
  }
  const owner = onchain !== null && onchain.status === "ready" ? provenOwnerFromFeatures(onchain.features) : null;
  // S-123: no enabled button may fire a request that answers
  // not-configured. While /health reports the on-chain read unavailable
  // the row names it with no button, so the dead 501 fetch (and its
  // browser-level console error) never happens.
  const notConfigured =
    onchain !== null ? onchain.status === "not-configured" : onchainAvailability === "unavailable";
  return (
    <>
      <p className="detail-owner">
        {owner === null ? (
          <>
            <span className="owner-control">Controlled by:</span> <span>not read yet</span>{" "}
            {notConfigured ? (
              <span className="quiet">On-chain reads are not configured on this server.</span>
            ) : (
              <>
                {onchain !== null ? (
                  <span className="quiet">The on-chain read did not name an owner. </span>
                ) : null}
                <button
                  type="button"
                  className="button-ghost detail-owner-btn"
                  onClick={() => void onReadOwner()}
                  disabled={pending}
                >
                  {pending ? "Loading…" : onchain === null ? "Read owner on-chain" : "Retry"}
                </button>
              </>
            )}
          </>
        ) : (
          <>
            <OwnerChip owner={owner} /> <span className="live-tag">Live read · not in score</span>
          </>
        )}
      </p>
      {temporality === null ? null : <p className="detail-temporality">{temporality}</p>}
    </>
  );
}

const EVIDENCE_LIMIT = 5;

// Slugs with an extended-proof report (UI v2 §5.5): only these five
// detectors walk the proof steps, so only their detail views fetch
// GET /v1/proof and render "How we checked".
const PROOF_SLUGS: ReadonlySet<string> = new Set([
  "pause",
  "blacklist",
  "transfer-fee",
  "transfer-limits",
  "mint",
]);

function ProofSection({
  address,
  apiKey,
  pluginId,
  slug,
  expert,
}: {
  readonly address: string;
  readonly apiKey: string;
  readonly pluginId: string;
  readonly slug: string;
  readonly expert: boolean;
}): JSX.Element | null {
  const [report, setReport] = useState<readonly ProofStep[] | null | undefined>(undefined);
  useEffect(() => {
    if (!PROOF_SLUGS.has(slug)) {
      return;
    }
    let cancelled = false;
    fetchProof(address, apiKey.length === 0 ? null : apiKey).then(
      (state) => {
        if (cancelled) {
          return;
        }
        if (state.status !== "ready") {
          setReport(null);
          return;
        }
        const match = state.proofs.find((entry) => entry.detector === pluginId);
        setReport(match === undefined ? null : match.steps);
      },
      () => {
        if (!cancelled) {
          setReport(null);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [address, apiKey, pluginId, slug]);
  if (!PROOF_SLUGS.has(slug)) {
    return null;
  }
  if (report === undefined) {
    return (
      <section className="card detail-proof" aria-label="How we checked">
        <h2>How we checked</h2>
        <ScanStatus text="Loading proof trace…" />
      </section>
    );
  }
  if (report === null || report.length === 0) {
    return null;
  }
  return <ProofTrace steps={report} expert={expert} />;
}

function EvidenceSection({
  address,
  apiKey,
  findings,
  names,
  expert,
}: {
  readonly address: string;
  readonly apiKey: string;
  readonly findings: readonly PluginFindingView[];
  readonly names: ReadonlyMap<string, SelectorName>;
  readonly expert: boolean;
}): JSX.Element | null {
  const [showAll, setShowAll] = useState(false);
  const rows = findings.flatMap((finding) =>
    finding.evidence.map((entry) => ({ finding, selector: entry.selector, offset: entry.offset })),
  );
  if (rows.length === 0) {
    return null;
  }
  const visible = showAll ? rows : rows.slice(0, EVIDENCE_LIMIT);
  return (
    <section className="card detail-evidence" aria-label="Where we saw it">
      <h2>Where we saw it</h2>
      <ol className="evidence-list">
        {visible.map((row, index) => {
          const display = selectorDisplayName(row.selector, names);
          const known = names.has(row.selector.toLowerCase());
          return (
            <EvidenceRow
              key={`${row.finding.id}:${row.selector}:${String(row.offset)}:${String(index)}`}
              address={address}
              apiKey={apiKey}
              selector={row.selector}
              offset={row.offset}
              displayName={display}
              shortName={selectorShortName(row.selector, names)}
              named={known}
              expert={expert}
              index={index}
              showInCodeHref={codeHref(address, row.selector, "decompiled", row.offset)}
            />
          );
        })}
      </ol>
      {rows.length > EVIDENCE_LIMIT && !showAll ? (
        <button type="button" className="button-ghost evidence-more" onClick={() => setShowAll(true)}>
          Show all {rows.length} places
        </button>
      ) : null}
    </section>
  );
}

export function PluginDetailView({
  address,
  apiKey,
  symbol,
  slug,
  tile,
  entry,
  findings,
  names,
  modelVersion,
  mode,
  onModeChange,
  prev,
  next,
  fn,
  codeView,
  codePc,
  availability,
  evidenceIndex,
  ownerOnlySelectors,
}: {
  readonly address: string;
  readonly apiKey: string;
  readonly symbol: string;
  readonly slug: string;
  readonly tile: BoardTile | null;
  readonly entry: PluginListEntry | undefined;
  readonly findings: readonly PluginFindingView[];
  readonly names: ReadonlyMap<string, SelectorName>;
  readonly modelVersion: string;
  readonly mode: UiMode;
  readonly onModeChange: (mode: UiMode) => void;
  readonly prev: BoardTile | null;
  readonly next: BoardTile | null;
  // Route `<selector>` (UI v2 §1.3): the decompiler row to auto-expand.
  readonly fn?: string | undefined;
  // Route view and pc (addendum §A1.1): the code view's initial pane and
  // the offset whose line to target.
  readonly codeView?: CodePaneView | undefined;
  readonly codePc?: number | undefined;
  // VS-2: AI availability (the code-explain button hides when the
  // feature is unavailable) and every finding of this analysis for
  // evidence chips. Both optional so older callers keep working.
  readonly availability?: AiFeatureAvailability | undefined;
  readonly evidenceIndex?: ReadonlyMap<string, ExplainEvidenceEntry> | undefined;
  // Owner-only fallback for the decompiler list (R3 D-8). Optional so
  // older callers keep working.
  readonly ownerOnlySelectors?: ReadonlySet<string> | undefined;
}): JSX.Element {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const title = tile?.copy.title ?? entry?.displayName ?? "Unknown check";
  const sentence =
    tile === null
      ? (entry?.description ?? "No description for this check.")
      : tile.state === "found-scored" || tile.state === "extended" || tile.state === "ran"
        ? tile.copy.foundLine(tile.payloads)
        : tileQuietBody(tile.copy, tile.state);
  const typed = useTypewriter(sentence);
  const expert = mode === "expert";
  // A deep-linked function row keeps focus: scrolling to top and
  // focusing the heading would pull the visitor away from the row the
  // route asked for. The document title still updates.
  const hasDeepLink = typeof fn === "string" && fn.length > 0;
  useEffect(() => {
    if (!hasDeepLink) {
      window.scrollTo(0, 0);
      headingRef.current?.focus();
    }
    document.title = `${title} · ${symbol} · Brandklipparen`;
  }, [title, symbol, slug, address, hasDeepLink]);
  return (
    <div>
      <div className="detail-toolbar">
        <a className="button-ghost detail-back" href={`#/token/${encodeURIComponent(address)}`}>
          ← Back to token
        </a>
        <ExpertSwitch mode={mode} onModeChange={onModeChange} testId="detail-expert-switch" />
      </div>
      <nav className="detail-crumb" aria-label="Breadcrumb">
        <a href={`#/token/${encodeURIComponent(address)}`}>{symbol}</a>
        <span aria-hidden="true"> › </span>
        <a href={pluginsHref(address)}>What we checked</a>
        <span aria-hidden="true"> › </span>
        <span aria-current="page">{title}</span>
      </nav>
      <p role="status" className="sr-only">
        {title} details
      </p>
      {tile === null ? (
        <section className="card detail-head" aria-label="Check details">
          <h1 tabIndex={-1} ref={headingRef}>
            {title}
          </h1>
          <p className="muted">
            {entry === undefined
              ? "No check with this name ran on this token."
              : (entry.description ?? "No description for this check.")}
          </p>
        </section>
      ) : (
        <section
          className={`card detail-head${tile.state === "found-scored" && tile.severity === "high" ? " is-found-high" : ""}`}
          aria-label="Check details"
        >
          <span className="detail-pict" aria-hidden="true">
            <Pictogram name={tile.copy.pictogram} size={32} />
          </span>
          <h1 tabIndex={-1} ref={headingRef}>
            {tile.copy.title}
          </h1>
          <p className="detail-question">{tile.copy.question}</p>
          <p className="detail-status">
            <span className="lamp" aria-hidden="true">
              <Pictogram name={tile.state === "ran" ? tile.copy.pictogram : tile.state === "found-scored" ? "found" : tile.state === "extended" ? "extended" : tile.state === "error" ? "error" : tile.state === "not-run" ? "notrun" : tile.state === "cant-tell" ? "canttell" : "notfound"} size={20} />
            </span>{" "}
            <span className="status-word" data-nowrap={true}>
              {tile.state === "found-scored"
                ? `Found · ${severityWord(tile.severity)}`
                : tile.state === "ran"
                  ? ranStatusWord(tile.copy, tile.payloads.length)
                  : PLUGIN_STATE_WORD[tile.state]}
            </span>
            {tile.state === "extended" ? (
              <>
                {" "}
                <span className="extended-chip" data-testid="detail-not-in-score" data-nowrap={true}>
                  Not in score
                </span>
              </>
            ) : null}
          </p>
          <p className="detail-sentence">
            <span aria-hidden="true">
              {typed.shown}
              {typed.done ? null : <b className="cursor" aria-hidden="true" />}
            </span>
            <span className="sr-only">{sentence}</span>
          </p>
          {tile.state === "found-scored" || tile.state === "extended" ? (
            <DetailOwnerRow
              address={address}
              apiKey={apiKey}
              group={tile.copy.group}
              temporality={temporalityLine(tile.payloads)}
              onchainAvailability={availability?.onchain ?? "available"}
            />
          ) : null}
          <p className="quiet numeric detail-provenance">
            {expert ? (
              <>
                <span className="detail-plugin-id">{tile.pluginId}</span>
                {` · v${entry?.version ?? "0.0.0"} · `}
              </>
            ) : null}
            {detailProvenance(tile.state, entry?.weight, modelVersion)}
            {expert ? null : ` · Check v${entry?.version ?? "0.0.0"}`}
          </p>
        </section>
      )}
      {tile === null ? null : (
        <div className={slug === "decompiler" ? "detail-cols detail-cols--code" : "detail-cols"}>
          <div className="detail-main">
            <div className="detail-stack">
              {slug === "decompiler" ? (
                <DecompilerList
                  address={address}
                  apiKey={apiKey}
                  findings={findings}
                  expert={expert}
                  initialSelector={fn}
                  initialView={codeView}
                  initialPc={codePc}
                  explainAvailable={(availability?.explainCode ?? "available") === "available"}
                  evidenceIndex={evidenceIndex}
                  ownerOnlySelectors={ownerOnlySelectors}
                />
              ) : (
                <EvidenceSection address={address} apiKey={apiKey} findings={findings} names={names} expert={expert} />
              )}
              <ProofSection
                address={address}
                apiKey={apiKey}
                pluginId={tile.pluginId}
                slug={slug}
                expert={expert}
              />
              <section className="card detail-limits" aria-label="What this check can't tell you">
                <h2>What this check can&apos;t tell you</h2>
                <p className="detail-limits-text">{tile.copy.limits}</p>
              </section>
              {!expert ? null : (
                <section className="card detail-raw" aria-label="Expert raw" data-testid="detail-expert-raw">
                  <h2>Expert raw</h2>
                  {findings.length === 0 ? (
                    <p className="muted">No findings: no payload to show.</p>
                  ) : (
                    findings.map((finding) => (
                      <article key={finding.id} className="detail-raw-finding">
                        <h3 className="mono">{finding.id}</h3>
                        <p>{finding.title}</p>
                        {finding.payload === undefined ? null : (
                          <SchemaValue value={finding.payload} schema={entry?.outputSchema} />
                        )}
                      </article>
                    ))
                  )}
                </section>
              )}
            </div>
          </div>
          <aside className="detail-aside" aria-label="About this check">
            <section className="card detail-about">
              <h2>About this check</h2>
              <p className="quiet numeric detail-about-version">
                Check v{entry?.version ?? "0.0.0"} · Model {modelVersion}
              </p>
            </section>
            {prev === null && next === null ? null : (
              <nav className="detail-prevnext detail-prevnext--aside" aria-label="More checks">
                {prev === null ? (
                  <span />
                ) : (
                  <a className="button-ghost" href={tileHref(address, prev)}>
                    ← {prev.copy.title}
                  </a>
                )}
                {next === null ? (
                  <span />
                ) : (
                  <a className="button-ghost" href={tileHref(address, next)}>
                    {next.copy.title} →
                  </a>
                )}
              </nav>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function tileQuietBody(copy: BoardTile["copy"], state: BoardTile["state"]): string {
  if (state === "error") {
    return "This check could not finish. Other results are not affected.";
  }
  if (state === "not-run") {
    return "Needs a tool this server does not have.";
  }
  if (state === "cant-tell") {
    return copy.cantTellLine;
  }
  return "Not found in the code we could read.";
}
