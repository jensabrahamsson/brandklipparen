// Owner-powers strip (UI v2 §1.1, W-9): lamp chips per found or
// extended owner-control detector, plus one "+N can't tell ›" link
// when can't-tell detectors exist alongside them. Each chip is a 44 px
// link to the plugin detail view; chips wrap at mobile. Quiet
// detectors (not found, not run, error) get no chip. The summary count
// renders only while the chips and link do not already carry every
// count. The summary never uses a "·" row, so the meta-separator scan
// keeps owning middots.
import type { JSX } from "react";
import type { AnalyzeSuccess } from "../types.ts";
import { Explain } from "./Explain.tsx";
import { Pictogram } from "./Pictogram.tsx";
import { pluginHref } from "../lib/pluginCopy.ts";
import { powersSummaryCopy } from "../lib/signals.ts";
import { powerStatusFor } from "../lib/floorPowers.ts";
import type { PowerStatus } from "../lib/floorPowers.ts";
import type { BoardTile } from "./plugins/PluginBoard.tsx";
import type { TileSeverity } from "./plugins/PluginTile.tsx";
import type { PluginListEntry } from "./PluginsPanel.tsx";

const CHIP_LAMP: Record<"found-scored" | "extended" | "cant-tell", "found" | "extended" | "canttell"> =
  Object.freeze({
    "found-scored": "found",
    extended: "extended",
    "cant-tell": "canttell",
  });

type ChipState = "found-scored" | "extended" | "cant-tell" | "renounced";

// SCORE-6: the chip status reads the single power status, so the hero
// agrees with the grid tile for the same power.
function chipStatus(status: PowerStatus, severity: TileSeverity): string {
  if (status === "renounced") {
    return "owner renounced";
  }
  if (status === "floor") {
    const level = severity === "high" ? "high" : severity === "medium" ? "medium" : "low";
    return `found, ${level}, sets score floor`;
  }
  if (status === "found") {
    const level = severity === "high" ? "high" : severity === "medium" ? "medium" : "low";
    return `found, ${level}`;
  }
  if (status === "extended") {
    return "found, not yet scored";
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
  ownerState,
  scoreFloor,
}: {
  readonly address: string;
  readonly allIds: readonly string[];
  readonly tiles: readonly BoardTile[];
  // Null while `/v1/plugins` is still pending; the board model then
  // yields no tiles, which is a loading state, not an empty result.
  readonly plugins?: readonly PluginListEntry[] | null;
  readonly ownerState?: AnalyzeSuccess["ownerState"];
  readonly scoreFloor?: AnalyzeSuccess["scoreFloor"];
}): JSX.Element | null {
  if (tiles.length === 0) {
    if (plugins === null) {
      return (
        <div className="powers" data-testid="powers-strip">
          <p className="powers-kicker">Owner powers</p>
          <p className="powers-loading">Loading…</p>
        </div>
      );
    }
    return null;
  }
  // SCORE-6: every chip reads the single power status, so the hero
  // agrees with the grid tile for the same power. A floor fact promotes
  // its chip to a found power; a renounced-lifted fact stays visible but
  // muted, never as found. The strip recomputes from its own floor
  // context (the same result the grid was built with), so chips and
  // tiles cannot disagree.
  const marked = tiles.map((tile) => {
    const status: PowerStatus = powerStatusFor(tile.copy.slug, tile.state, { scoreFloor, ownerState }, tile.payloads);
    const chipState: ChipState | BoardTile["state"] =
      status === "renounced"
        ? "renounced"
        : status === "floor" || status === "found"
          ? "found-scored"
          : status === "extended"
            ? "extended"
            : status === "cant-tell"
              ? "cant-tell"
              : tile.state;
    return { tile, status, chipState };
  });
  const found = marked.filter(
    (entry) => entry.status === "found" || entry.status === "floor",
  ).length;
  const floor = marked.filter((entry) => entry.status === "floor").length;
  const renounced = marked.filter((entry) => entry.status === "renounced").length;
  const extended = marked.filter((entry) => entry.status === "extended").length;
  const cantTell = marked.filter((entry) => entry.status === "cant-tell").length;
  // D-4 (hero diet): once a found or extended chip exists, every
  // can't-tell chip collapses into the one "+N can't tell ›" link at
  // every width, so the strip never towers 3 rows on desktop. With no
  // found or extended finding the can't-tell chips stay visible, since
  // otherwise the strip would be a bare link.
  const collapseCantTell = found + extended + renounced > 0 && cantTell > 0;
  const shown = marked.filter(
    (entry) =>
      entry.status === "found" ||
      entry.status === "floor" ||
      entry.status === "extended" ||
      entry.status === "renounced" ||
      (entry.status === "cant-tell" && !collapseCantTell),
  );
  const boardHref = `#/token/${encodeURIComponent(address)}/plugins`;
  const cantTellLabel = `+${cantTell} can't tell ›`;
  // D-4: the summary goes away exactly when the chips plus the link
  // already carry every count. The counts stay in the chips'
  // accessible names.
  const summary = collapseCantTell || renounced > 0 ? null : powersSummaryCopy({ found, extended, cantTell, floor, renounced });
  return (
    <div className="powers" data-testid="powers-strip">
      <p className="powers-kicker">
        <span>Owner powers</span> <Explain explainKey="powers:extended" label="Owner powers" />
      </p>
      {ownerState?.status === "unknown" && ownerState.reason.includes("could not be read") ? (
        <p className="powers-renounced">
          Owner could not be read at block {ownerState.block}, so the score floor still applies.
        </p>
      ) : null}
      {shown.length === 0 && !collapseCantTell ? null : (
        <ul className="powers-chips">
          {shown.map(({ tile, status, chipState }) => (
            <li key={tile.pluginId}>
              <a
                className={`power-chip state-${chipState} sev-${tile.severity}`}
                href={pluginHref(address, tile.pluginId, allIds)}
                aria-label={`${tile.copy.title}: ${chipStatus(status, tile.severity)}. ${tile.copy.question} Open details.`}
                data-testid={`power-chip-${tile.copy.slug}`}
              >
                <span className="power-lamp" aria-hidden="true">
                  <Pictogram
                    name={chipState === "renounced" ? "extended" : CHIP_LAMP[chipState as "found-scored" | "extended" | "cant-tell"]}
                    size={20}
                  />
                </span>
                <span className="power-name">{tile.copy.title}</span>
                {status === "floor" ? (
                  <span className="power-tag">Sets score floor</span>
                ) : null}
                {status === "extended" ? (
                  <span className="power-tag">Not yet scored</span>
                ) : null}
                {status === "cant-tell" ? <span className="power-tag">Can&apos;t tell</span> : null}
                {status === "found" ? (
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
