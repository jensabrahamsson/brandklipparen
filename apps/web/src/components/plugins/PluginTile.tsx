// One plugin tile (UI v2 §5.1): the whole tile is a single link to the
// plugin detail view. Status is always a word plus a lamp glyph, never
// colour alone. Motion is power-on, lamp ignite and hover glow only
// (M-1, M-2, M-9); static under prefers-reduced-motion.
import type { CSSProperties, JSX } from "react";
import { Pictogram } from "../Pictogram.tsx";
import { useCountUp } from "../../lib/motion.ts";
import type { PluginCopyEntry } from "../../lib/pluginCopy.ts";
import { pluginHref } from "../../lib/pluginCopy.ts";
import type { PluginState } from "../../lib/pluginState.ts";
import { PLUGIN_STATE_WORD } from "../../lib/pluginState.ts";

export type TileSeverity = "low" | "medium" | "high";

const LAMP_GLYPH: Record<PluginState, "found" | "extended" | "canttell" | "error" | "notrun" | "notfound"> =
  Object.freeze({
    error: "error",
    "not-run": "notrun",
    "found-scored": "found",
    extended: "extended",
    "cant-tell": "canttell",
    "not-found": "notfound",
  });

function statusPhrase(state: PluginState, severity: TileSeverity): string {
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
  severity,
  payloads,
  evidenceCount,
  matched,
  index,
}: {
  readonly address: string;
  readonly pluginId: string;
  readonly allIds: readonly string[];
  readonly copy: PluginCopyEntry;
  readonly state: PluginState;
  readonly severity: TileSeverity;
  readonly payloads: readonly unknown[];
  readonly evidenceCount: number;
  readonly matched: boolean;
  readonly index: number;
}): JSX.Element {
  const found = state === "found-scored" || state === "extended";
  const counted = useCountUp(evidenceCount, 600);
  const body = found ? copy.foundLine(payloads) : tileQuietBody(state);
  const statusWord = state === "found-scored" ? `Found · ${severityWord(severity)}` : PLUGIN_STATE_WORD[state];
  const lampClass =
    state === "found-scored" ? "lamp is-found" : state === "extended" ? "lamp is-extended" : "lamp";
  return (
    <a
      className={`tile state-${state} sev-${severity}`}
      href={pluginHref(address, pluginId, allIds)}
      aria-label={`${copy.title}: ${statusPhrase(state, severity)}. ${copy.question} Open details.`}
      data-testid={`plugin-tile-${copy.slug}`}
      data-tile-slug={copy.slug}
      style={{ "--i": Math.min(index, 12) } as CSSProperties}
    >
      <span className="tile-rail" aria-hidden="true" />
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
          <Pictogram name={LAMP_GLYPH[state]} size={20} />
        </span>
        <span className="status-word" data-nowrap={true}>
          {statusWord}
        </span>
      </span>
      <span className="tile-question">{copy.question}</span>
      <span className="tile-body">{body}</span>
      {state === "extended" ? (
        <span className="tile-extended-tag">Extended analysis</span>
      ) : null}
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

function tileQuietBody(state: PluginState): string {
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
