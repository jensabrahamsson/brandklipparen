// Owner-powers strip (UI v2 §1.1, W-9): lamp chips per found or
// extended owner-control detector, plus one "+N can't tell ›" link
// when can't-tell detectors exist alongside them. Each chip is a 44 px
// link to the plugin detail view; chips wrap at mobile. Quiet
// detectors (not found, not run, error) get no chip. The summary count
// renders only while the chips and link do not already carry every
// count. The summary never uses a "·" row, so the meta-separator scan
// keeps owning middots.
import type { JSX } from "react";
import { CopyButton } from "./CopyButton.tsx";
import { toChecksumAddress } from "../lib/checksumAddress.ts";
import type { AnalyzeSuccess } from "../types.ts";
import { Explain } from "./Explain.tsx";
import { Pictogram } from "./Pictogram.tsx";
import { pluginHref } from "../lib/pluginCopy.ts";
import { powersSummaryCopy } from "../lib/signals.ts";
import { floorMarkFor } from "../lib/floorPowers.ts";
import type { FloorMark } from "../lib/floorPowers.ts";
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

function chipStatus(state: string, severity: TileSeverity, mark: FloorMark): string {
  if (state === "renounced" || mark === "renounced") {
    return "owner renounced";
  }
  if (mark === "floor") {
    const level = severity === "high" ? "high" : severity === "medium" ? "medium" : "low";
    return `found, ${level}, sets the minimum score`;
  }
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
          <p className="powers-loading">Owner powers are loading…</p>
        </div>
      );
    }
    return null;
  }
  // SCORE-4: a floor fact promotes its chip to a found power; a
  // renounced-lifted fact stays visible but muted, never as found.
  const marked = tiles.map((tile) => {
    const mark: FloorMark =
      tile.floorMark !== undefined && tile.floorMark !== null
        ? tile.floorMark
        : floorMarkFor(tile.copy.slug, tile.state, { scoreFloor, ownerState });
    const chipState: ChipState | BoardTile["state"] =
      mark === "renounced" ? "renounced" : mark === "floor" ? "found-scored" : tile.state;
    return { tile, mark, chipState };
  });
  const found = marked.filter((entry) => entry.chipState === "found-scored").length;
  const floor = marked.filter((entry) => entry.mark === "floor" && entry.tile.state === "extended").length;
  const renounced = marked.filter((entry) => entry.mark === "renounced").length;
  const extended = marked.filter((entry) => entry.chipState === "extended").length;
  const cantTell = tiles.filter((tile) => tile.state === "cant-tell").length;
  // D-4 (hero diet): once a found or extended chip exists, every
  // can't-tell chip collapses into the one "+N can't tell ›" link at
  // every width, so the strip never towers 3 rows on desktop. With no
  // found or extended finding the can't-tell chips stay visible, since
  // otherwise the strip would be a bare link.
  const collapseCantTell = found + extended + renounced > 0 && cantTell > 0;
  const shown = marked.filter(
    (entry) =>
      entry.chipState === "found-scored" ||
      entry.chipState === "extended" ||
      entry.chipState === "renounced" ||
      (entry.chipState === "cant-tell" && !collapseCantTell),
  );
  const boardHref = `#/token/${encodeURIComponent(address)}/plugins`;
  const cantTellLabel = `+${cantTell} can't tell ›`;
  // D-4: the summary goes away exactly when the chips plus the link
  // already carry every count. The counts stay in the chips'
  // accessible names.
  const summary = collapseCantTell ? null : powersSummaryCopy({ found, extended, cantTell, floor, renounced });
  return (
    <div className="powers" data-testid="powers-strip">
      <p className="powers-kicker">
        <span>Owner powers</span> <Explain explainKey="powers:extended" label="Extended analysis" />
      </p>
      {ownerState?.status === "renounced" && ownerState.address !== null && ownerState.getter !== null ? (
        <p className="powers-renounced">
          Owner renounced — {ownerState.getter} returns {toChecksumAddress(ownerState.address)} at block{" "}
          {ownerState.block}, so these setters can no longer be called.{" "}
          <CopyButton
            value={toChecksumAddress(ownerState.address)}
            label="Copy owner address"
            testId="copy-renounced-owner-address"
          />
        </p>
      ) : ownerState?.status === "unknown" && ownerState.reason.includes("could not be read") ? (
        <p className="powers-renounced">
          Owner could not be read at block {ownerState.block}, so the score floor still applies.
        </p>
      ) : null}
      {shown.length === 0 && !collapseCantTell ? null : (
        <ul className="powers-chips">
          {shown.map(({ tile, mark, chipState }) => (
            <li key={tile.pluginId}>
              <a
                className={`power-chip state-${chipState} sev-${tile.severity}`}
                href={pluginHref(address, tile.pluginId, allIds)}
                aria-label={`${tile.copy.title}: ${chipStatus(chipState, tile.severity, mark)}. ${tile.copy.question} Open details.`}
                data-testid={`power-chip-${tile.copy.slug}`}
              >
                <span className="power-lamp" aria-hidden="true">
                  <Pictogram
                    name={chipState === "renounced" ? "extended" : CHIP_LAMP[chipState as "found-scored" | "extended" | "cant-tell"]}
                    size={20}
                  />
                </span>
                <span className="power-name">{tile.copy.title}</span>
                {mark === "renounced" ? <span className="power-tag">Owner renounced</span> : null}
                {mark === "floor" && tile.state === "extended" ? (
                  <span className="power-tag">Sets minimum score</span>
                ) : null}
                {chipState === "extended" && mark !== "renounced" ? (
                  <span className="power-tag">Not in score</span>
                ) : null}
                {chipState === "cant-tell" ? <span className="power-tag">Can&apos;t tell</span> : null}
                {chipState === "found-scored" && mark !== "floor" ? (
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
