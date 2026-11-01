// Owner-powers strip (UI v2 §1.1, W-9): lamp chips per found or
// extended owner-control detector, plus one "+N can't tell ›" link
// when can't-tell detectors exist alongside them. Each chip is a 44 px
// link to the plugin detail view; chips wrap at mobile. Quiet
// detectors (not found, not run, error) get no chip. The summary count
// renders only while the chips and link do not already carry every
// count. The summary never uses a "·" row, so the meta-separator scan
// keeps owning middots.
import type { JSX } from "react";
import { Pictogram } from "./Pictogram.tsx";
import { pluginHref } from "../lib/pluginCopy.ts";
import { powersSummaryCopy } from "../lib/signals.ts";
import type { BoardTile } from "./plugins/PluginBoard.tsx";
import type { TileSeverity } from "./plugins/PluginTile.tsx";
import type { PluginListEntry } from "./PluginsPanel.tsx";

const CHIP_LAMP: Record<"found-scored" | "extended" | "cant-tell", "found" | "extended" | "canttell"> =
  Object.freeze({
    "found-scored": "found",
    extended: "extended",
    "cant-tell": "canttell",
  });

function chipStatus(state: "found-scored" | "extended" | "cant-tell", severity: TileSeverity): string {
  if (state === "found-scored") {
    const level = severity === "high" ? "high" : severity === "medium" ? "medium" : "low";
    return `found, ${level}`;
  }
  if (state === "extended") {
    return "found, not in score";
  }
  return "can't tell";
}

function chipSeverityWord(severity: TileSeverity): string {
  return severity === "high" ? "High" : severity === "medium" ? "Medium" : "Low";
}

export function PowersStrip({
  address,
  allIds,
  tiles,
  plugins = [],
}: {
  readonly address: string;
  readonly allIds: readonly string[];
  readonly tiles: readonly BoardTile[];
  // Null while `/v1/plugins` is still pending; the board model then
  // yields no tiles, which is a loading state, not an empty result.
  readonly plugins?: readonly PluginListEntry[] | null;
}): JSX.Element | null {
  if (tiles.length === 0) {
    if (plugins === null) {
      return (
        <div className="powers" data-testid="powers-strip">
          <p className="powers-kicker">Owner powers</p>
          <p className="powers-loading">Owner powers are loading…</p>
        </div>
      );
    }
    return null;
  }
  const found = tiles.filter((tile) => tile.state === "found-scored").length;
  const extended = tiles.filter((tile) => tile.state === "extended").length;
  const cantTell = tiles.filter((tile) => tile.state === "cant-tell").length;
  // D-4 (hero diet): once a found or extended chip exists, every
  // can't-tell chip collapses into the one "+N can't tell ›" link at
  // every width, so the strip never towers 3 rows on desktop. With no
  // found or extended finding the can't-tell chips stay visible, since
  // otherwise the strip would be a bare link.
  const collapseCantTell = found + extended > 0 && cantTell > 0;
  const shown = tiles.filter(
    (tile): tile is BoardTile & { readonly state: "found-scored" | "extended" | "cant-tell" } =>
      tile.state === "found-scored" ||
      tile.state === "extended" ||
      (tile.state === "cant-tell" && !collapseCantTell),
  );
  const boardHref = `#/token/${encodeURIComponent(address)}/plugins`;
  const cantTellLabel = `+${cantTell} can't tell ›`;
  // D-4: the summary goes away exactly when the chips plus the link
  // already carry every count. The counts stay in the chips'
  // accessible names.
  const summary = collapseCantTell ? null : powersSummaryCopy({ found, extended, cantTell });
  return (
    <div className="powers" data-testid="powers-strip">
      <p className="powers-kicker">Owner powers</p>
      {shown.length === 0 && !collapseCantTell ? null : (
        <ul className="powers-chips">
          {shown.map((tile) => (
            <li key={tile.pluginId}>
              <a
                className={`power-chip state-${tile.state}`}
                href={pluginHref(address, tile.pluginId, allIds)}
                aria-label={`${tile.copy.title}: ${chipStatus(tile.state, tile.severity)}. ${tile.copy.question} Open details.`}
                data-testid={`power-chip-${tile.copy.slug}`}
              >
                <span className="power-lamp" aria-hidden="true">
                  <Pictogram name={CHIP_LAMP[tile.state]} size={20} />
                </span>
                <span className="power-name">{tile.copy.title}</span>
                {tile.state === "extended" ? <span className="power-tag">Not in score</span> : null}
                {tile.state === "found-scored" ? (
                  <span className="sr-only">{chipSeverityWord(tile.severity)}</span>
                ) : null}
              </a>
            </li>
          ))}
          {collapseCantTell ? (
            <li key="__cant-tell-more" className="powers-more-item">
              <a className="powers-more" href={boardHref}>
                {cantTellLabel}
              </a>
            </li>
          ) : null}
        </ul>
      )}
      {summary === null ? null : <p className="powers-summary">{summary}</p>}
    </div>
  );
}
