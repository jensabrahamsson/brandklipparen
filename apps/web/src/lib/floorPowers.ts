// Score-floor agreement for owner powers (SCORE-4): a proven fact that
// the score floor already counted must never read "Not in score" in the
// hero, board or detail. Pure display classification only: it reads the
// envelope's scoreFloor facts and owner state, never scoring itself.
import type { PluginState } from "./pluginState.ts";
import type { AnalyzeSuccess } from "../types.ts";

// Floor fact names double as plugin slugs for every floored detector.
export const FLOOR_FACT_SLUGS: readonly string[] = Object.freeze([
  "blacklist",
  "pause",
  "sell-block",
  "mint",
  "transfer-fee",
  "transfer-limits",
  "proxy-upgrade",
]);

export type FloorMark = "floor" | "renounced" | null;

export type FloorContext = {
  readonly scoreFloor?: AnalyzeSuccess["scoreFloor"];
  readonly ownerState?: AnalyzeSuccess["ownerState"];
};

// "floor": the fact sets the minimum score, so it renders as a found
// power. "renounced": the owner is renounced and the fact is absent from
// the floor, so it was lifted and renders muted, never as found. A fact
// still listed in the floor wins over renounced (a non-owner gate keeps
// its floor even when the Ownable owner is gone).
export function floorMarkFor(
  slug: string,
  state: PluginState,
  context: FloorContext | undefined,
): FloorMark {
  if (state !== "extended" && state !== "found-scored") {
    return null;
  }
  if (!FLOOR_FACT_SLUGS.includes(slug)) {
    return null;
  }
  if (context?.scoreFloor?.facts.includes(slug) === true) {
    return "floor";
  }
  if (context?.ownerState?.status === "renounced") {
    return "renounced";
  }
  return null;
}

export function isFloorFactSlug(slug: string): boolean {
  return FLOOR_FACT_SLUGS.includes(slug);
}
