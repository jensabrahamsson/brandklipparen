// Plugin detail view, level 2 (UI v2 §1.3). A route, not a modal: browser
// back works, the back link is a real link so cold deep links work, and
// entering focuses the h1. W-4 renders the header, status, provenance and
// prev/next; evidence, proof trace and Expert raw land in W-5/W-6.
import { useEffect, useRef, type JSX } from "react";
import { Pictogram } from "../Pictogram.tsx";
import type { BoardTile } from "./PluginBoard.tsx";
import { severityWord } from "./PluginTile.tsx";
import type { PluginListEntry } from "../PluginsPanel.tsx";
import { PLUGIN_STATE_WORD } from "../../lib/pluginState.ts";

function pluginsHref(address: string): string {
  return `#/token/${encodeURIComponent(address)}/plugins`;
}

function tileHref(address: string, tile: BoardTile): string {
  return `#/token/${encodeURIComponent(address)}/plugins/${encodeURIComponent(tile.slug)}`;
}

export function PluginDetailView({
  address,
  symbol,
  slug,
  tile,
  entry,
  modelVersion,
  prev,
  next,
}: {
  readonly address: string;
  readonly symbol: string;
  readonly slug: string;
  readonly tile: BoardTile | null;
  readonly entry: PluginListEntry | undefined;
  readonly modelVersion: string;
  readonly prev: BoardTile | null;
  readonly next: BoardTile | null;
}): JSX.Element {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const title = tile?.copy.title ?? entry?.displayName ?? "Unknown check";
  useEffect(() => {
    window.scrollTo(0, 0);
    headingRef.current?.focus();
    document.title = `${title} · ${symbol} · Brandklipparen`;
  }, [title, symbol, slug, address]);
  return (
    <div>
      <a className="detail-back" href={pluginsHref(address)}>
        ← All plugins
      </a>
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
            <span className="status-word" data-nowrap={true}>
              {tile.state === "found-scored"
                ? `Found · ${severityWord(tile.severity)}`
                : PLUGIN_STATE_WORD[tile.state]}
            </span>{" "}
            <span className="dim">{tile.copy.question}</span>
          </p>
          <p className="detail-sentence">
            {tile.state === "found-scored" || tile.state === "extended"
              ? tile.copy.foundLine(tile.payloads)
              : tileQuietBody(tile.state)}
          </p>
          <p className="quiet numeric detail-provenance">
            {tile.pluginId} · v{entry?.version ?? "0.0.0"} ·{" "}
            {tile.state === "extended" ? "No: extended analysis" : `In score: yes (model ${modelVersion})`}
          </p>
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
