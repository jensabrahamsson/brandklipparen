// Owner-powers strip (UI v2 §1.1, W-9): lamp chips per owner-control
// detector in a found, extended or can't-tell state, plus a summary
// count. Each chip is a 44 px link to the plugin detail view; chips
// wrap at mobile. Quiet detectors (not found, not run, error) get no
// chip, only the summary count. The summary never uses a "·" row, so
// the meta-separator scan keeps owning middots.
import type { JSX } from "react";
import { Pictogram } from "./Pictogram.tsx";
import { pluginHref } from "../lib/pluginCopy.ts";
import { powersSummaryCopy } from "../lib/signals.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import type { BoardTile } from "./plugins/PluginBoard.tsx";
import type { TileSeverity } from "./plugins/PluginTile.tsx";

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
}: {
  readonly address: string;
  readonly allIds: readonly string[];
  readonly tiles: readonly BoardTile[];
}): JSX.Element | null {
  if (tiles.length === 0) {
    return null;
  }
  // R2-2 (D-2): on phones the strip would tower 7-9 rows and push the
  // dial below the fold. Render only found and extended chips there and
  // collapse every can't-tell chip into one quiet link to the board.
  const compact = useMediaQuery("(max-width: 639px)");
  const shown = tiles.filter(
    (tile): tile is BoardTile & { readonly state: "found-scored" | "extended" | "cant-tell" } =>
      tile.state === "found-scored" ||
      tile.state === "extended" ||
      (tile.state === "cant-tell" && !compact),
  );
  const found = tiles.filter((tile) => tile.state === "found-scored").length;
  const extended = tiles.filter((tile) => tile.state === "extended").length;
  const cantTell = tiles.filter((tile) => tile.state === "cant-tell").length;
  const summary = powersSummaryCopy({ found, extended, cantTell });
  const boardHref = `#/token/${encodeURIComponent(address)}/plugins`;
  const cantTellLabel = cantTell === 1 ? "1 more can't tell ›" : `${cantTell} more can't tell ›`;
  return (
    <div className="powers" data-testid="powers-strip">
      <p className="powers-kicker">Owner powers</p>
      {shown.length === 0 && !(compact && cantTell > 0) ? null : (
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
          {compact && cantTell > 0 ? (
            <li key="__cant-tell-more" className="powers-more-item">
              <a className="powers-more" href={boardHref}>
                {cantTellLabel}
              </a>
            </li>
          ) : null}
        </ul>
      )}
      <p className="powers-summary">{summary}</p>
    </div>
  );
}
