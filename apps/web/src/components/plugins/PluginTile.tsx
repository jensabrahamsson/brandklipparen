// One plugin tile (UI v2 §5.1): the whole tile is a single link to the
// plugin detail view. Status is always a word plus a lamp glyph, never
// colour alone. Motion is power-on, lamp ignite and hover glow only
// (M-1, M-2, M-9); static under prefers-reduced-motion.
import type { CSSProperties, JSX } from "react";
import { Pictogram } from "../Pictogram.tsx";
import { useCountUp } from "../../lib/motion.ts";
import type { PluginCopyEntry } from "../../lib/pluginCopy.ts";
import { pluginHref, ranStatusWord } from "../../lib/pluginCopy.ts";
import type { PluginState } from "../../lib/pluginState.ts";
import { PLUGIN_STATE_WORD } from "../../lib/pluginState.ts";
import type { PowerStatus } from "../../lib/floorPowers.ts";

export type TileSeverity = "low" | "medium" | "high";

const LAMP_GLYPH: Record<
  Exclude<PluginState, "ran">,
  "found" | "extended" | "canttell" | "error" | "notrun" | "notfound"
> = Object.freeze({
  error: "error",
  "not-run": "notrun",
  "found-scored": "found",
  extended: "extended",
  "cant-tell": "canttell",
  "not-found": "notfound",
});

// SCORE-6: the accessible status reads the single power status, so
// the tile agrees with the hero chip for the same power. Quiet, error
// and not-run states keep their own words.
function statusPhrase(
  status: PowerStatus,
  state: PluginState,
  severity: TileSeverity,
  copy: PluginCopyEntry,
  payloads: readonly unknown[],
): string {
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
  if (status === "cant-tell") {
    return "can't tell";
  }
  return checkStatusWord(copy, state, payloads).toLowerCase();
}

// Owner-tile status before SCORE-6 callers pass powerStatus: the same
// mapping the board selector produces without floor or owner context.
function legacyOwnerStatus(state: PluginState, floorMark: "floor" | "renounced" | null): PowerStatus {
  if (floorMark === "floor") {
    return "floor";
  }
  if (floorMark === "renounced") {
    return "renounced";
  }
  switch (state) {
    case "found-scored":
      return "found";
    case "extended":
      return "extended";
    case "cant-tell":
      return "cant-tell";
    default:
      return "not-found";
  }
}

export function PluginTile({
  address,
  pluginId,
  allIds,
  copy,
  state,
  floorMark = null,
  powerStatus,
  severity,
  payloads,
  evidenceCount,
  matched,
  index,
  compact = false,
}: {
  readonly address: string;
  readonly pluginId: string;
  readonly allIds: readonly string[];
  readonly copy: PluginCopyEntry;
  readonly state: PluginState;
  readonly floorMark?: "floor" | "renounced" | null;
  // SCORE-6: the single power status for owner tiles; tools ignore it
  // and keep their neutral ran rendering. Absent means derive from the
  // tile state alone.
  readonly powerStatus?: PowerStatus | undefined;
  readonly severity: TileSeverity;
  readonly payloads: readonly unknown[];
  readonly evidenceCount: number;
  readonly matched: boolean;
  readonly index: number;
  // R2-10 phone compaction: quiet and neutral tiles collapse to one
  // 48 px row below 480 px. Found, extended and error tiles always keep
  // the full card so no finding loses its sentence.
  readonly compact?: boolean;
}): JSX.Element {
  // SCORE-6: owner tiles render from the single power status (the board
  // always passes it); tools keep their state rendering. A floor or
  // live-proven ownership tile counts as found even when the raw state
  // reads quiet, so the grid agrees with the hero chips.
  const isOwner = copy.group === "owner";
  const isRanTool = !isOwner && state === "ran";
  const status: PowerStatus = isOwner
    ? (powerStatus ?? legacyOwnerStatus(state, floorMark))
    : state === "found-scored"
      ? "found"
      : state === "extended"
        ? "extended"
        : state === "cant-tell"
          ? "cant-tell"
          : "not-found";
  const found = status === "found" || status === "floor" || status === "extended" || isRanTool;
  const counted = useCountUp(evidenceCount, 600);
  // A quiet tile drops its body when the status word already says it.
  const body: string | null = status === "renounced"
    ? `${copy.title} no longer counts.`
    : found ? copy.foundLine(payloads) : tileQuietBody(copy, state);
  const displayState: PluginState = isRanTool
    ? "ran"
    : status === "floor" || status === "found"
      ? "found-scored"
      : status === "renounced" || status === "extended"
        ? "extended"
        : state;
  const statusWord = isRanTool
    ? checkStatusWord(copy, state, payloads)
    : status === "renounced"
      ? "Owner renounced"
      : status === "floor"
        ? "Found · Sets floor"
        : status === "found"
          ? `Found · ${severityWord(severity)}`
          : status === "extended"
            ? "Found · Not yet scored"
            : status === "cant-tell" && isOwner
              ? "Can't tell"
            : checkStatusWord(copy, state, payloads);
  const lampGlyph =
    state === "ran" ? copy.pictogram : LAMP_GLYPH[displayState as Exclude<PluginState, "ran">];
  const lampClass =
    displayState === "found-scored"
      ? "lamp is-found"
      : displayState === "extended"
        ? "lamp is-extended"
        : state === "ran"
          ? "lamp is-ran"
          : "lamp";
  if (compact) {
    return (
      <a
        className={`tile is-compact state-${displayState} sev-${severity}`}
        href={pluginHref(address, pluginId, allIds)}
        aria-label={`${copy.title}: ${statusPhrase(status, state, severity, copy, payloads)}. ${copy.question} Open details.`}
        data-testid={`plugin-tile-${copy.slug}`}
        data-tile-slug={copy.slug}
        style={{ "--i": Math.min(index, 12) } as CSSProperties}
      >
        <span className={lampClass} aria-hidden="true">
          <Pictogram name={lampGlyph} size={20} />
        </span>
        <span className="tile-compact-label">
          {copy.title} · {statusWord}
        </span>
        {matched ? (
          <span className="tile-match" data-testid={`matched-${pluginId}`}>
            Matches question
          </span>
        ) : null}
        <span className="tile-chev" aria-hidden="true">
          <Pictogram name="chevron-right" size={20} />
        </span>
      </a>
    );
  }
  return (
    <a
      className={`tile state-${displayState} sev-${severity}`}
      href={pluginHref(address, pluginId, allIds)}
      aria-label={`${copy.title}: ${statusPhrase(status, state, severity, copy, payloads)}. ${copy.question} Open details.`}
      data-testid={`plugin-tile-${copy.slug}`}
      data-tile-slug={copy.slug}
      style={{ "--i": Math.min(index, 12) } as CSSProperties}
    >
      {copy.group === "tools" ? null : <span className="tile-rail" aria-hidden="true" />}
      <span className="tile-top">
        <Pictogram name={copy.pictogram} size={24} />
        <span className="tile-title">{copy.title}</span>
        {matched ? (
          <span className="tile-match" data-testid={`matched-${pluginId}`}>
            Matches question
          </span>
        ) : null}
        <span className="tile-chev" aria-hidden="true">
          <Pictogram name="chevron-right" size={20} />
        </span>
      </span>
      <span className="tile-status">
        <span className={lampClass} aria-hidden="true">
          <Pictogram name={lampGlyph} size={20} />
        </span>
        <span className="status-word" data-nowrap={true}>
          {statusWord}
        </span>
      </span>
      <span className="tile-question">{copy.question}</span>
      {body === null ? null : <span className="tile-body">{body}</span>}
      {copy.slug === "decompiler" || evidenceCount === 0 ? null : (
        <span className="tile-count numeric">
          {counted} {counted === 1 ? "place" : "places"} in code
        </span>
      )}
    </a>
  );
}

export function severityWord(severity: TileSeverity): string {
  return severity === "high" ? "High" : severity === "medium" ? "Medium" : "Low";
}

// Per-check status words (owner-facing): each check reads its own words
// instead of a generic "Not found". Obfuscation reads Obfuscated, Read
// incomplete or Readable; clone match reads Match found or No match; the
// decompiler reads No functions when it finds none; other analysis tools
// that ran read "Ran". Detail and tile share this helper.
export function checkStatusWord(copy: PluginCopyEntry, state: PluginState, payloads: readonly unknown[]): string {
  if (copy.slug === "hard-to-analyze") {
    if (state === "ran") {
      const obfuscated = payloads.some((payload) => {
        const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null;
        return record?.["cause"] === "obfuscated-structure";
      });
      return obfuscated ? "Obfuscated" : "Read incomplete";
    }
    if (state === "not-found") {
      return "Readable";
    }
  }
  if (copy.slug === "clone-match") {
    if (state === "ran") {
      return "Match found";
    }
    if (state === "not-found") {
      return "No match";
    }
  }
  if (copy.slug === "decompiler" && state === "not-found") {
    return "No functions";
  }
  if (state === "ran") {
    return ranStatusWord(copy, payloads.length);
  }
  return PLUGIN_STATE_WORD[state];
}

// Quiet body for a check with no finding. Not found returns null: the
// status word already says it, so the tile carries no extra line.
function tileQuietBody(copy: PluginCopyEntry, state: PluginState): string | null {
  if (state === "error") {
    return "Could not finish.";
  }
  if (state === "not-run") {
    return "Tool missing on server.";
  }
  if (state === "cant-tell") {
    return copy.cantTellLine;
  }
  return null;
}
