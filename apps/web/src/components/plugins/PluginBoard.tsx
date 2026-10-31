// Plugin board (UI v2 §1.3 level 1, §5.1): the overview grid of one
// tile per first-party detector. Groups, sort and summary follow the
// spec; third-party ids keep rendering in the PluginsPanel fallback.
// Motion is power-on, lamp ignite, count-up and hover glow only
// (M-1, M-2, M-3, M-9); static under prefers-reduced-motion.
import type { JSX } from "react";
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
import { useCountUp } from "../../lib/motion.ts";

export type BoardTile = {
  readonly pluginId: string;
  readonly slug: string;
  readonly copy: PluginCopyEntry;
  readonly state: PluginState;
  readonly severity: TileSeverity;
  readonly payloads: readonly unknown[];
  readonly evidenceCount: number;
  readonly orderIndex: number;
};

const STATE_RANK: Record<PluginState, number> = Object.freeze({
  "found-scored": 0,
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
    return isTransfer && record["cause"] !== null && record["cause"] !== undefined;
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
    tiles.push({
      pluginId: entry.id,
      slug: slugForPluginId(entry.id, entries.map((candidate) => candidate.id)),
      copy,
      state: pluginState(result, context),
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

function SummaryLine({ tiles }: { readonly tiles: readonly BoardTile[] }): JSX.Element | null {
  const found = tiles.filter((tile) => tile.state === "found-scored").length;
  const extended = tiles.filter((tile) => tile.state === "extended").length;
  const notFound = tiles.filter((tile) => tile.state === "not-found").length;
  const cantTell = tiles.filter((tile) => tile.state === "cant-tell").length;
  const errors = tiles.filter((tile) => tile.state === "error").length;
  const notRun = tiles.filter((tile) => tile.state === "not-run").length;
  const countedFound = useCountUp(found, 600);
  const countedExtended = useCountUp(extended, 600);
  const countedNotFound = useCountUp(notFound, 600);
  if (tiles.length === 0) {
    return null;
  }
  const parts = [`${countedFound} found`];
  if (extended > 0) {
    parts.push(`${countedExtended} found by extended analysis (not in score)`);
  }
  if (cantTell > 0) {
    parts.push(`${cantTell} can't tell`);
  }
  if (errors > 0) {
    parts.push(`${errors} errors`);
  }
  if (notRun > 0) {
    parts.push(`${notRun} not run`);
  }
  parts.push(`${countedNotFound} not found`);
  return (
    <p className="board-summary numeric" data-testid="plugin-board-summary">
      {tiles.length} owner powers checked: {parts.join(" · ")}
    </p>
  );
}

export function PluginBoard({
  address,
  plugins,
  results,
  matchedTags,
}: {
  readonly address: string;
  readonly plugins: readonly PluginListEntry[] | null;
  readonly results: readonly PluginResultView[];
  readonly matchedTags?: ReadonlyMap<string, readonly string[]> | undefined;
}): JSX.Element | null {
  const model = buildBoardModel(plugins, results);
  if (model.allTiles.length === 0) {
    return null;
  }
  const allIds = (plugins ?? []).map((entry) => entry.id);
  const renderTiles = (tiles: readonly BoardTile[], offset: number): JSX.Element[] =>
    tiles.map((tile, index) => (
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
      />
    ));
  return (
    <section aria-label="What we checked" data-testid="plugin-board">
      <h2 id="plugin-board" tabIndex={-1}>
        What we checked
      </h2>
      <SummaryLine tiles={model.ownerTiles} />
      <h3 className="board-group">Owner powers</h3>
      <div className="plugin-grid">{renderTiles(model.ownerTiles, 0)}</div>
      {model.toolTiles.length === 0 ? null : (
        <>
          <h3 className="board-group">Analysis tools</h3>
          <div className="plugin-grid">{renderTiles(model.toolTiles, model.ownerTiles.length)}</div>
        </>
      )}
    </section>
  );
}
