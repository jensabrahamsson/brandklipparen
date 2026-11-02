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

// One status per owner power (SCORE-6): every power summary — hero
// chips and the 9-card grid — derives from this selector.
// "found": scored finding, or ownership proven live. "floor": extended
// proof that sets the minimum score. "extended": found by extended
// analysis, not in the score. "renounced": proven but lifted because
// the owner is renounced. "cant-tell" / "not-found": quiet states.
export type PowerStatus = "found" | "floor" | "extended" | "renounced" | "cant-tell" | "not-found";

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
  const status = powerStatusFor(slug, state, context);
  if (status === "floor") {
    return "floor";
  }
  if (status === "renounced") {
    return "renounced";
  }
  return null;
}

// Whether the ownership payloads prove a stored owner: an owner-slot
// feature finding. A privileged-function count alone does not identify
// an owner slot or prove that the functions have a current owner.
function ownershipProvenByPayloads(payloads: readonly unknown[] | undefined): boolean {
  if (payloads === undefined) {
    return false;
  }
  for (const payload of payloads) {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      continue;
    }
    const record = payload as Record<string, unknown>;
    if (record["feature"] === "owner-slot") {
      return true;
    }
  }
  return false;
}

// SCORE-6: the single power-status selector. A floor fact is Found
// (extended proof, sets the minimum score) whatever the tile state
// reads — the floor itself is the proof, so a quiet tile never prints
// "Not found" for it. Ownership reads Found when the live owner read
// is active or an owner slot is proven in the payloads. Proven facts
// absent from the floor read Owner renounced once renounced is proven.
// Everything else follows the tile state.
export function powerStatusFor(
  slug: string,
  state: PluginState,
  context: FloorContext | undefined,
  payloads?: readonly unknown[] | undefined,
): PowerStatus {
  if (isFloorFactSlug(slug) && context?.scoreFloor?.facts.includes(slug) === true) {
    return state === "found-scored" ? "found" : "floor";
  }
  if (slug === "ownership" && context?.ownerState?.status === "renounced") {
    return "renounced";
  }
  if (
    slug === "ownership" &&
    (context?.ownerState?.status === "active" || ownershipProvenByPayloads(payloads))
  ) {
    return "found";
  }
  if ((state === "extended" || state === "found-scored") && context?.ownerState?.status === "renounced") {
    return "renounced";
  }
  switch (state) {
    case "found-scored":
      return "found";
    case "extended":
      return "extended";
    case "cant-tell":
    case "error":
    case "not-run":
      return "cant-tell";
    default:
      return "not-found";
  }
}

export function isFloorFactSlug(slug: string): boolean {
  return FLOOR_FACT_SLUGS.includes(slug);
}
