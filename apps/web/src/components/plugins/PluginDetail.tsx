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
import { OwnerChip } from "./OwnerChip.tsx";
import { ProofTrace } from "./ProofTrace.tsx";
import { fetchProof, type ProofStep } from "../../lib/api.ts";
import type { BoardTile } from "./PluginBoard.tsx";
import { severityWord } from "./PluginTile.tsx";
import type { ExplainEvidenceEntry } from "../code/CodeView.tsx";
import type { AiFeatureAvailability } from "../../lib/capabilities.ts";
import type { PluginFindingView, PluginListEntry } from "../PluginsPanel.tsx";
import { PLUGIN_STATE_WORD } from "../../lib/pluginState.ts";
import { codeHref, type CodePaneView } from "../../lib/route.ts";
import { temporalityLine } from "../../lib/pluginCopy.ts";
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
  if (state === "extended") {
    return "No: extended analysis";
  }
  if (weight !== undefined && weight <= 0) {
    return "No: extended analysis";
  }
  return `In score: yes (model ${modelVersion})`;
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
        <p role="status" className="proof-loading">
          Loading proof trace…
        </p>
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
}): JSX.Element {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const title = tile?.copy.title ?? entry?.displayName ?? "Unknown check";
  const sentence =
    tile === null
      ? (entry?.description ?? "No description for this check.")
      : tile.state === "found-scored" || tile.state === "extended"
        ? tile.copy.foundLine(tile.payloads)
        : tileQuietBody(tile.state);
  const typed = useTypewriter(sentence);
  const expert = mode === "expert";
  useEffect(() => {
    window.scrollTo(0, 0);
    headingRef.current?.focus();
    document.title = `${title} · ${symbol} · Brandklipparen`;
  }, [title, symbol, slug, address]);
  return (
    <div>
      <div className="detail-toolbar">
        <a className="detail-back" href={pluginsHref(address)}>
          ← All plugins
        </a>
        <ExpertSwitch mode={mode} onModeChange={onModeChange} testId="detail-expert-switch" />
      </div>
      <p className="detail-crumb">
        {symbol} › What we checked › {title}
      </p>
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
        <section className="card detail-head" aria-label="Check details">
          <span className="detail-pict" aria-hidden="true">
            <Pictogram name={tile.copy.pictogram} size={32} />
          </span>
          <h1 tabIndex={-1} ref={headingRef}>
            {tile.copy.title}
          </h1>
          <p className="detail-status">
            <span className="lamp" aria-hidden="true">
              <Pictogram name={tile.state === "found-scored" ? "found" : tile.state === "extended" ? "extended" : tile.state === "error" ? "error" : tile.state === "not-run" ? "notrun" : tile.state === "cant-tell" ? "canttell" : "notfound"} size={20} />
            </span>{" "}
            <span className="status-word" data-nowrap={true}>
              {tile.state === "found-scored"
                ? `Found · ${severityWord(tile.severity)}`
                : PLUGIN_STATE_WORD[tile.state]}
            </span>{" "}
            {tile.state === "extended" ? (
              <span className="extended-chip" data-testid="detail-not-in-score" data-nowrap={true}>
                Not in score
              </span>
            ) : null}{" "}
            <span className="dim">{tile.copy.question}</span>
          </p>
          <p className="detail-sentence">
            <span aria-hidden="true">
              {typed.shown}
              {typed.done ? null : <b className="cursor" aria-hidden="true" />}
            </span>
            <span className="sr-only">{sentence}</span>
          </p>
          {tile.state === "found-scored" || tile.state === "extended" ? (
            <p className="detail-owner">
              <OwnerChip owner={null} />
              <span className="detail-temporality"> · {temporalityLine(tile.payloads)}</span>
            </p>
          ) : null}
          <p className="quiet numeric detail-provenance">
            {tile.pluginId} · v{entry?.version ?? "0.0.0"} · {detailProvenance(tile.state, entry?.weight, modelVersion)}
          </p>
        </section>
      )}
      {tile === null ? null : slug === "decompiler" ? (
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
        />
      ) : (
        <EvidenceSection address={address} apiKey={apiKey} findings={findings} names={names} expert={expert} />
      )}
      {tile === null ? null : (
        <ProofSection
          address={address}
          apiKey={apiKey}
          pluginId={tile.pluginId}
          slug={slug}
          expert={expert}
        />
      )}
      {tile === null ? null : (
        <section className="card detail-limits" aria-label="What this check can't tell you">
          <h2>What this check can&apos;t tell you</h2>
          <p className="detail-limits-text">{tile.copy.limits}</p>
        </section>
      )}
      {tile === null || !expert ? null : (
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
      {prev === null && next === null ? null : (
        <nav className="detail-prevnext" aria-label="More checks">
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
    </div>
  );
}

function tileQuietBody(state: BoardTile["state"]): string {
  if (state === "error") {
    return "This check could not finish. Other results are not affected.";
  }
  if (state === "not-run") {
    return "Needs a tool this server does not have.";
  }
  if (state === "cant-tell") {
    return "The code that matters here could not be fully read.";
  }
  return "Not found in the code we could read.";
}
