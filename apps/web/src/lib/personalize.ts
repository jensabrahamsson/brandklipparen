// Experimental AI layout toggle state and spec application (S-070,
// K-519, P-27, P-28). The toggle is off by default and persisted under
// one versioned key; the visitor's priorities may leave the device only
// through one explicit per-request POST carrying priorities plus quoted
// plugin references, and any invalid or missing model output falls back
// to the deterministic baseline with scores, evidence and text unchanged.
// The client re-validates every model response with zod before applying
// it: the closed component shape first, then whitelisted sections only,
// no collapse of the floored sections, ranking names only offered plugin
// ids.
import { z } from "zod";

export const AI_PERSONALIZE_KEY = "brandklipparen-ai-personalize:v1";

// Closed read: exactly `on` opts in; everything else stays off.
export function parseStoredAiPersonalize(raw: string | null | undefined): boolean {
  return raw === "on";
}

function storageOf(): Storage | null {
  try {
    if (typeof localStorage === "undefined") {
      return null;
    }
    return localStorage;
  } catch {
    return null;
  }
}

export function readStoredAiPersonalize(storage: Storage | null = storageOf()): boolean {
  if (storage === null) {
    return false;
  }
  try {
    return parseStoredAiPersonalize(storage.getItem(AI_PERSONALIZE_KEY));
  } catch {
    return false;
  }
}

export function writeStoredAiPersonalize(on: boolean, storage: Storage | null = storageOf()): void {
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(AI_PERSONALIZE_KEY, on ? "on" : "off");
  } catch {
    // Local-only preference: the app works without persistence.
  }
}

// Section ids the deterministic plan emits (P-22 family): the only ids a
// model placement may name.
export const PERSONALIZE_SECTIONS: readonly string[] = Object.freeze([
  "summary",
  "score",
  "signals",
  "plugin-findings",
  "evidence",
  "cant-tell",
  "assessment",
  "expert-detail",
]);

export type PersonalizePlacement = {
  readonly sectionId: string;
  readonly emphasis: "normal" | "high" | "low";
  readonly collapsed: boolean;
};

export type AiPersonalizeSpec = {
  readonly pluginRanking: readonly string[];
  readonly placements: readonly PersonalizePlacement[];
};

export type PersonalizeContext = {
  readonly sectionIds: readonly string[];
  readonly pluginIds: readonly string[];
  readonly flooredSectionIds: readonly string[];
};

// Floored sections derived from the envelope (P-26), mirroring the server:
// `summary` and `score` always, plus `signals` whenever a signal raises
// risk and `signals` beside `evidence` whenever a high-severity signal is
// present. Specs collapsing a floored section are rejected, so an AI
// layout can never bury a high finding.
export function requiredFlooredSections(
  signals: readonly { readonly severity?: string; readonly direction?: string }[],
): readonly string[] {
  let raises = false;
  let high = false;
  for (const signal of signals) {
    if (signal.direction === "raises" || signal.direction === undefined) {
      raises = true;
    }
    if (signal.severity === "high") {
      high = true;
    }
  }
  const floored = ["summary", "score"];
  if (raises || high) {
    floored.push("signals");
  }
  if (high) {
    floored.push("evidence");
  }
  return Object.freeze(floored);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Client-side zod parse: the model JSON is validated against the closed
// component shape first (spec version, ranking and placement lists,
// whitelisted field names only), then against the offered context
// (whitelisted section and plugin ids, no duplicates, no collapse of the
// floored sections, `summary` and `score` always present). Any failure
// means the deterministic baseline stands; no partial spec is ever
// applied. The deterministic fallback is unchanged: null in, baseline out.
const emphasisSchema = z.enum(["normal", "high", "low"]);

const placementSchema = z
  .object({
    sectionId: z.string(),
    emphasis: emphasisSchema,
    collapsed: z.boolean().optional(),
  })
  .strict();

const aiSpecSchema = z
  .object({
    specVersion: z.literal(1),
    pluginRanking: z.array(z.string().min(1)).max(16),
    placements: z.array(placementSchema).max(16),
  })
  .strict();

export function parseAiPersonalizeSpec(value: unknown, context: PersonalizeContext): AiPersonalizeSpec | null {
  const shaped = aiSpecSchema.safeParse(value);
  if (!shaped.success) {
    return null;
  }
  const ranking = shaped.data.pluginRanking;
  const presentPlugins = new Set(context.pluginIds);
  const seenPlugins = new Set<string>();
  for (const entry of ranking) {
    if (!presentPlugins.has(entry) || seenPlugins.has(entry)) {
      return null;
    }
    seenPlugins.add(entry);
  }
  const presentSections = new Set(context.sectionIds);
  const floored = new Set(context.flooredSectionIds);
  const seenSections = new Set<string>();
  const parsed: PersonalizePlacement[] = [];
  for (const placement of shaped.data.placements) {
    const sectionId = placement.sectionId;
    if (!presentSections.has(sectionId) || seenSections.has(sectionId)) {
      return null;
    }
    seenSections.add(sectionId);
    const collapsed = placement.collapsed ?? false;
    if (collapsed && floored.has(sectionId)) {
      return null;
    }
    parsed.push({ sectionId, emphasis: placement.emphasis, collapsed });
  }
  if (!seenSections.has("summary") || !seenSections.has("score")) {
    return null;
  }
  return {
    pluginRanking: Object.freeze([...seenPlugins]),
    placements: Object.freeze(parsed),
  };
}

// Apply the validated spec to the section order: placements first in
// their order, then every standard section the spec never names, in
// standard relative order. Floored sections clamp ahead (P-26), with
// `summary` and `score` pinned first: extending the floor with `signals`
// or `evidence` must never push a finding section above the pinned cards.
const PINNED_FIRST: readonly string[] = Object.freeze(["summary", "score"]);

export function applyAiSectionOrder(
  standardIds: readonly string[],
  spec: AiPersonalizeSpec,
  flooredIds: readonly string[],
): readonly string[] {
  const listed = new Set(spec.placements.map((placement) => placement.sectionId));
  const floored = new Set(flooredIds);
  const ordered = spec.placements.map((placement) => placement.sectionId);
  const rest = standardIds.filter((id) => !listed.has(id));
  const combined = [...ordered, ...rest];
  const flooredBlock = combined.filter((id) => floored.has(id));
  const openBlock = combined.filter((id) => !floored.has(id));
  const pinned = PINNED_FIRST.filter((id) => flooredBlock.includes(id));
  const restFloored = flooredBlock.filter((id) => !PINNED_FIRST.includes(id as string));
  return Object.freeze([...pinned, ...restFloored, ...openBlock]);
}

// Parse the mapping route envelope: `{ personalize: { kind: "ok", spec } }`
// or the error envelope (any error kind means the baseline stands).
export function parsePersonalizeEnvelope(body: unknown, context: PersonalizeContext): AiPersonalizeSpec | null {
  if (!isRecord(body)) {
    return null;
  }
  const outcome = body["personalize"];
  if (!isRecord(outcome) || outcome["kind"] !== "ok") {
    return null;
  }
  return parseAiPersonalizeSpec(outcome["spec"], context);
}
