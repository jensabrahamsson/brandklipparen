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

function statusPhrase(
  state: PluginState,
  severity: TileSeverity,
  floorMark?: "floor" | "renounced" | null,
): string {
  if (floorMark === "renounced") {
    return "owner renounced";
  }
  if (floorMark === "floor") {
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
  return PLUGIN_STATE_WORD[state].toLowerCase();
}

export function PluginTile({
  address,
  pluginId,
  allIds,
  copy,
  state,
  floorMark = null,
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
  const found = state === "found-scored" || state === "extended" || state === "ran";
  const counted = useCountUp(evidenceCount, 600);
  const body = found ? copy.foundLine(payloads) : tileQuietBody(copy, state);
  // SCORE-4: a floor fact reads as a found power that sets the minimum
  // score; a renounced-lifted fact reads muted as owner renounced.
  const displayState: PluginState =
    floorMark === "floor" ? "found-scored" : floorMark === "renounced" ? "extended" : state;
  const statusWord =
    floorMark === "renounced"
      ? "Owner renounced"
      : floorMark === "floor"
        ? "Found · Sets minimum score"
        : state === "found-scored"
          ? `Found · ${severityWord(severity)}`
          : state === "extended"
            ? "Found · Not in score"
            : state === "ran"
              ? ranStatusWord(copy, payloads.length)
              : PLUGIN_STATE_WORD[state];
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
        aria-label={`${copy.title}: ${statusPhrase(state, severity, floorMark)}. ${copy.question} Open details.`}
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
            Matches your question
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
      aria-label={`${copy.title}: ${statusPhrase(state, severity, floorMark)}. ${copy.question} Open details.`}
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
            Matches your question
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
      <span className="tile-body">{body}</span>
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

function tileQuietBody(copy: PluginCopyEntry, state: PluginState): string {
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
