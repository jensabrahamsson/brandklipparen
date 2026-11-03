// Plugin board (UI v2 §1.3 level 1, §5.1): the overview grid of one
// tile per first-party detector. Groups, sort and summary follow the
// spec; third-party ids keep rendering in the PluginsPanel fallback.
// Motion is power-on, lamp ignite, count-up and hover glow only
// (M-1, M-2, M-3, M-9); static under prefers-reduced-motion.
import { Fragment, useState, type JSX } from "react";
import { Pictogram } from "../Pictogram.tsx";
import { useMediaQuery } from "../../lib/useMediaQuery.ts";
import { PluginTile } from "./PluginTile.tsx";
import type { TileSeverity } from "./PluginTile.tsx";
import {
  OWNER_POWER_SLUGS,
  TOOL_SLUGS,
  copyForPluginId,
  slugForPluginId,
} from "../../lib/pluginCopy.ts";
import type { PluginCopyEntry } from "../../lib/pluginCopy.ts";
import type { PluginListEntry, PluginResultView } from "../PluginsPanel.tsx";
import { pluginState } from "../../lib/pluginState.ts";
import type { CantTellContext, PluginState } from "../../lib/pluginState.ts";
import { powerStatusFor } from "../../lib/floorPowers.ts";
import type { FloorContext, PowerStatus } from "../../lib/floorPowers.ts";
import { useCountUp } from "../../lib/motion.ts";

export type BoardTile = {
  readonly pluginId: string;
  readonly slug: string;
  readonly copy: PluginCopyEntry;
  readonly state: PluginState;
  // SCORE-6: the single power status for this tile (found, floor,
  // extended, renounced, cant-tell, not-found). Every summary — hero
  // chips, grid tiles, detail view — renders from it, so they agree.
  // Kept for older callers that still read the two-bit mark.
  readonly floorMark?: "floor" | "renounced" | null;
  // Always set by buildBoardModel; absent on hand-built fixtures, which
  // fall back to the selector without floor context.
  readonly powerStatus?: PowerStatus | undefined;
  readonly severity: TileSeverity;
  readonly payloads: readonly unknown[];
  readonly evidenceCount: number;
  readonly orderIndex: number;
};

const STATE_RANK: Record<PluginState, number> = Object.freeze({
  "found-scored": 0,
  // Tools that ran sort first in their group, like findings do.
  ran: 0,
  extended: 1,
  "cant-tell": 2,
  error: 3,
  "not-run": 4,
  "not-found": 5,
});

const SEVERITY_RANK: Record<TileSeverity, number> = Object.freeze({ high: 0, medium: 1, low: 2 });

function severityOf(entry: PluginListEntry | undefined): TileSeverity {
  const max = entry?.frontmatter?.severity.max;
  return max === "high" || max === "medium" || max === "low" ? max : "medium";
}

function resultFor(results: readonly PluginResultView[], pluginId: string): PluginResultView | undefined {
  return results.find((result) => result.pluginId === pluginId);
}

function cantTellContext(results: readonly PluginResultView[]): CantTellContext {
  const hard = resultFor(results, "dev.brandklipparen.hard-to-analyze");
  const hardToAnalyzeFired = hard !== undefined && hard.findings.length > 0;
  // A transfer row counts as partly read only for `unexpected-control-flow`
  // (R3 D-8): `no-plain-return` only means the body returns nothing, so a
  // routine USDT transfer never turns the board can't tell on its own.
  const decompiler = resultFor(results, "dev.brandklipparen.decompiler");
  const partialTransfer = (decompiler?.findings ?? []).some((finding) => {
    const payload = finding.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return false;
    }
    const record = payload as Record<string, unknown>;
    const selector =
      typeof record["selector"] === "string"
        ? record["selector"]
        : typeof finding.id === "string"
          ? finding.id.split(":").pop()
          : undefined;
    const isTransfer = selector === "0xa9059cbb" || selector === "0x23b872dd";
    return isTransfer && record["cause"] === "unexpected-control-flow";
  });
  return { hardToAnalyzeFired, partialTransfer };
}

function compareTiles(left: BoardTile, right: BoardTile): number {
  const leftFound = left.state === "found-scored";
  const rightFound = right.state === "found-scored";
  if (leftFound && rightFound && SEVERITY_RANK[left.severity] !== SEVERITY_RANK[right.severity]) {
    return SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
  }
  if (STATE_RANK[left.state] !== STATE_RANK[right.state]) {
    return STATE_RANK[left.state] - STATE_RANK[right.state];
  }
  return left.orderIndex - right.orderIndex;
}

export type BoardModel = {
  readonly ownerTiles: readonly BoardTile[];
  readonly toolTiles: readonly BoardTile[];
  readonly allTiles: readonly BoardTile[];
  readonly bySlug: ReadonlyMap<string, BoardTile>;
};

export function buildBoardModel(
  plugins: readonly PluginListEntry[] | null,
  results: readonly PluginResultView[],
  floorContext?: FloorContext,
): BoardModel {
  const entries = plugins ?? [];
  const context = cantTellContext(results);
  const tiles: BoardTile[] = [];
  for (const entry of entries) {
    const copy = copyForPluginId(entry.id);
    if (copy === null) {
      continue;
    }
    const result = resultFor(results, entry.id);
    const payloads = (result?.findings ?? []).map((finding) => finding.payload);
    const evidenceCount = (result?.findings ?? []).reduce(
      (total, finding) => total + finding.evidence.length,
      0,
    );
    const canonical = [...OWNER_POWER_SLUGS, ...TOOL_SLUGS].indexOf(copy.slug);
    const state = pluginState(result, context, copy.group);
    // SCORE-6: one selector for the status; the two-bit mark stays
    // derived from it so older readers cannot disagree with the tile.
    const powerStatus = powerStatusFor(copy.slug, state, floorContext, payloads);
    tiles.push({
      pluginId: entry.id,
      slug: slugForPluginId(entry.id, entries.map((candidate) => candidate.id)),
      copy,
      state,
      floorMark: powerStatus === "floor" ? "floor" : powerStatus === "renounced" ? "renounced" : null,
      powerStatus,
      severity: severityOf(entry),
      payloads,
      evidenceCount,
      orderIndex: canonical === -1 ? entries.indexOf(entry) + 100 : canonical,
    });
  }
  const ownerTiles = tiles
    .filter((tile) => tile.copy.group === "owner")
    .sort(compareTiles);
  const toolTiles = tiles
    .filter((tile) => tile.copy.group === "tools")
    .sort(compareTiles);
  const allTiles = [...ownerTiles, ...toolTiles];
  return {
    ownerTiles,
    toolTiles,
    allTiles,
    bySlug: new Map(allTiles.map((tile) => [tile.slug, tile] as const)),
  };
}

function summaryLamp(state: PluginState): "found" | "extended" | "canttell" | "error" | "notrun" | "notfound" {
  switch (state) {
    case "found-scored":
      return "found";
    case "extended":
      return "extended";
    case "cant-tell":
      return "canttell";
    case "error":
      return "error";
    case "not-run":
      return "notrun";
    default:
      return "notfound";
  }
}

function SummaryLine({ tiles }: { readonly tiles: readonly BoardTile[] }): JSX.Element | null {
  // SCORE-6: every count reads the single power status, never the raw
  // tile state, so the summary agrees with the hero chips.
  const found = tiles.filter((tile) => tile.powerStatus === "found" || tile.powerStatus === "floor").length;
  const floor = tiles.filter((tile) => tile.powerStatus === "floor").length;
  const renounced = tiles.filter((tile) => tile.powerStatus === "renounced").length;
  const extended = tiles.filter((tile) => tile.powerStatus === "extended").length;
  const notFound = tiles.filter((tile) => tile.powerStatus === "not-found").length;
  const cantTell = tiles.filter((tile) => tile.powerStatus === "cant-tell").length;
  const countedFound = useCountUp(found, 600);
  const countedExtended = useCountUp(extended, 600);
  const countedNotFound = useCountUp(notFound, 600);
  if (tiles.length === 0) {
    return null;
  }
  // R2-10: zero counts read as noise ("0 not found" wrapping to an
  // orphan line), so only nonzero states are named. R3 D-10: the summary
  // reads as a lamp legend, one lamp plus word per state, so it shares
  // the board's visual language instead of repeating "extended analysis".
  const parts: { readonly state: PluginState; readonly text: string }[] = [];
  if (found > 0) {
    parts.push({ state: "found-scored", text: `${countedFound} found` });
  }
  if (floor > 0) {
    parts.push({ state: "found-scored", text: `${floor} sets score floor` });
  }
  if (extended > 0) {
    parts.push({ state: "extended", text: `${countedExtended} not yet scored` });
  }
  if (renounced > 0) {
    parts.push({ state: "extended", text: `${renounced} owner renounced` });
  }
  if (cantTell > 0) {
    parts.push({ state: "cant-tell", text: `${cantTell} can't tell` });
  }
  if (notFound > 0) {
    parts.push({ state: "not-found", text: `${countedNotFound} not found` });
  }
  return (
    <p className="board-summary numeric" data-testid="plugin-board-summary">
      {tiles.length} owner powers checked:{" "}
      {parts.map((part, index) => (
        <Fragment key={`${part.state}-${part.text}`}>
          {index > 0 ? (
            <span className="board-sep" aria-hidden="true">
              {" "}
              ·{" "}
            </span>
          ) : null}
          <span className="board-legend-part">
            <span className="lamp lamp-legend" aria-hidden="true">
              <Pictogram name={summaryLamp(part.state)} size={16} />
            </span>{" "}
            {part.text}
          </span>
        </Fragment>
      ))}
    </p>
  );
}

// Phone compaction (R2-10): below 480 px every tile without a finding
// renders as a one-line 48 px row. Found, extended and error tiles keep
// the full card so no finding and no failure message loses its sentence.
// Ran tools read compact because, post D-8, they are neutral rows with
// one-line bodies; the detail view still holds their full copy.
export function shouldCompactTile(state: PluginState): boolean {
  return state === "cant-tell" || state === "not-found" || state === "not-run" || state === "ran";
}

// The can't-tell wall (R3 D-9): with 3 or more can't-tell owner tiles
// they collapse behind one disclosure row, "Can't tell (7)". It opens
// with the approved X-1 180 ms grid-template-rows expand and rests on
// the same lamp language as the tiles. Fewer than 3 render inline.
const CANT_TELL_GROUP_AT = 3;

function CantTellGroup({
  address,
  allIds,
  tiles,
  offset,
  matchedTags,
  narrow,
}: {
  readonly address: string;
  readonly allIds: readonly string[];
  readonly tiles: readonly BoardTile[];
  readonly offset: number;
  readonly matchedTags?: ReadonlyMap<string, readonly string[]> | undefined;
  readonly narrow: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="canttell-group">
      <button
        type="button"
        className="canttell-toggle"
        aria-expanded={open}
        aria-controls="cant-tell-tiles"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="lamp" aria-hidden="true">
          <Pictogram name="canttell" size={20} />
        </span>
        <span className="canttell-label">Can&apos;t tell ({tiles.length})</span>
        <span className="canttell-chev" aria-hidden="true">
          <Pictogram name={open ? "chevron-down" : "chevron-right"} size={20} />
        </span>
      </button>
      <div id="cant-tell-tiles" className={open ? "canttell-expand is-open" : "canttell-expand"}>
        <div className="canttell-expand-clip">
          <div className="plugin-grid">
            {tiles.map((tile, index) => (
              <PluginTile
                key={tile.pluginId}
                address={address}
                pluginId={tile.pluginId}
                allIds={allIds}
                copy={tile.copy}
                state={tile.state}
                severity={tile.severity}
                payloads={tile.payloads}
                evidenceCount={tile.evidenceCount}
                matched={(matchedTags?.get(tile.pluginId) ?? []).length > 0}
                index={offset + index}
                compact={narrow && shouldCompactTile(tile.state)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function PluginBoard({
  address,
  plugins,
  results,
  matchedTags,
  scoreFloor,
  ownerState,
}: {
  readonly address: string;
  readonly plugins: readonly PluginListEntry[] | null;
  readonly results: readonly PluginResultView[];
  readonly matchedTags?: ReadonlyMap<string, readonly string[]> | undefined;
  readonly scoreFloor?: FloorContext["scoreFloor"];
  readonly ownerState?: FloorContext["ownerState"];
}): JSX.Element | null {
  const model = buildBoardModel(plugins, results, { scoreFloor, ownerState });
  if (model.allTiles.length === 0) {
    return null;
  }
  const allIds = (plugins ?? []).map((entry) => entry.id);
  // R2-10 compaction follows the viewport, not the board container, so
  // it stays in step with every other <480 rule on the page.
  const narrow = useMediaQuery("(max-width: 479px)");
  // SCORE-6: proven powers (found, floor, extended, renounced) always
  // keep the full card, even on phones; only quiet tiles compact.
  const renderTiles = (tiles: readonly BoardTile[], offset: number): JSX.Element[] =>
    tiles.map((tile, index) => (
      <PluginTile
        key={tile.pluginId}
        address={address}
        pluginId={tile.pluginId}
        allIds={allIds}
        copy={tile.copy}
        state={tile.state}
        floorMark={tile.floorMark ?? null}
        powerStatus={tile.powerStatus}
        severity={tile.severity}
        payloads={tile.payloads}
        evidenceCount={tile.evidenceCount}
        matched={(matchedTags?.get(tile.pluginId) ?? []).length > 0}
        index={offset + index}
        compact={narrow && tile.powerStatus !== "found" && tile.powerStatus !== "floor" && shouldCompactTile(tile.state)}
      />
    ));
  const cantTellOwner = model.ownerTiles.filter((tile) => tile.powerStatus === "cant-tell");
  const openOwner = model.ownerTiles.filter((tile) => tile.powerStatus !== "cant-tell");
  const grouped = cantTellOwner.length >= CANT_TELL_GROUP_AT;
  return (
    <section aria-label="Checks" data-testid="plugin-board" className="plugin-board card">
      <h2 id="plugin-board" tabIndex={-1}>
        Checks
      </h2>
      <SummaryLine tiles={model.ownerTiles} />
      <h3 className="board-group">Owner powers</h3>
      <div className="plugin-grid">{renderTiles(grouped ? openOwner : model.ownerTiles, 0)}</div>
      {grouped ? (
        <CantTellGroup
          address={address}
          allIds={allIds}
          tiles={cantTellOwner}
          offset={openOwner.length}
          matchedTags={matchedTags}
          narrow={narrow}
        />
      ) : null}
      {model.toolTiles.length === 0 ? null : (
        <details className="board-tools">
          <summary>Tools</summary>
          <div className="plugin-grid">{renderTiles(model.toolTiles, model.ownerTiles.length)}</div>
        </details>
      )}
    </section>
  );
}
