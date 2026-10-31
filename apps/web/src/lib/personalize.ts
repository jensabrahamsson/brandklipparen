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
import { SECTION_ORDER_STANDARD } from "./layout.ts";

export const AI_PERSONALIZE_KEY = "brandklipparen-ai-personalize:v1";

// Provider label for the experimental toggle (S-070, K-519): the UI names
// the configured provider and model id from the status/health response,
// never a hard-coded provider name. Null means the server left the
// feature unconfigured.
export function personalizeProviderName(
  provider: { readonly provider: string; readonly modelId: string } | null,
): string {
  if (provider === null) {
    return "the mapping provider";
  }
  return `${provider.provider} · ${provider.modelId}`;
}

export function personalizeProviderLabel(
  provider: { readonly provider: string; readonly modelId: string } | null,
): string {
  if (provider === null) {
    return "Mapping provider not configured on this server.";
  }
  return `Maps with ${personalizeProviderName(provider)}.`;
}

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

// Section ids offered to the mapping provider (P-22 family). The single
// shared source is SECTION_ORDER_STANDARD from layout.ts: every rendered
// overview section comes from that list. Legacy model ids stay accepted
// for backward compatibility and normalize to rendered ids in
// normalizeAiSectionId (`summary` reads as the pinned score card,
// `evidence` reads as the `explanation` card); `assessment` and
// `expert-detail` have no overview block and are dropped when applying.
export const PERSONALIZE_SECTIONS: readonly string[] = Object.freeze([
  ...SECTION_ORDER_STANDARD,
  "summary",
  "evidence",
  "assessment",
  "expert-detail",
]);

// Legacy model ids mapped to the rendered overview sections.
export const MODEL_TO_RENDERED_SECTION_ID: Readonly<Record<string, string>> = Object.freeze({
  summary: "score",
  evidence: "explanation",
});

// Map a model section id to the rendered overview id, or null when the id
// has no overview block (`assessment`, `expert-detail` and unknown ids).
export function normalizeAiSectionId(sectionId: string): string | null {
  const mapped = MODEL_TO_RENDERED_SECTION_ID[sectionId];
  if (mapped !== undefined) {
    return mapped;
  }
  if ((SECTION_ORDER_STANDARD as readonly string[]).includes(sectionId)) {
    return sectionId;
  }
  return null;
}

// Human labels for the AI order notice (P0-5): what the reader sees.
const AI_SECTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  score: "Score",
  explanation: "Why this score",
  signals: "Signals",
  "plugin-findings": "Plugins",
  "cant-tell": "Can't-tell",
});

function aiSectionLabel(sectionId: string): string {
  return AI_SECTION_LABELS[sectionId] ?? sectionId;
}

// Describe how the applied AI order differs from the deterministic plan.
// Compares rendered positions only, so legacy aliases never leak into the
// copy. Returns the moved-up and lowered labels in applied order.
export function describeAiOrderChange(
  planIds: readonly string[],
  appliedIds: readonly string[],
): { readonly movedUp: readonly string[]; readonly lowered: readonly string[] } {
  const planRank = new Map<string, number>();
  planIds.forEach((id, index) => {
    if (!planRank.has(id)) {
      planRank.set(id, index);
    }
  });
  const movedUp: string[] = [];
  const lowered: string[] = [];
  appliedIds.forEach((id, index) => {
    const before = planRank.get(id);
    if (before === undefined) {
      return;
    }
    if (index < before) {
      movedUp.push(aiSectionLabel(id));
    } else if (index > before) {
      lowered.push(aiSectionLabel(id));
    }
  });
  return { movedUp: Object.freeze(movedUp), lowered: Object.freeze(lowered) };
}

// One-line notice copy for an applied AI order, naming what moved.
export function aiOrderNotice(planIds: readonly string[], appliedIds: readonly string[]): string {
  const { movedUp, lowered } = describeAiOrderChange(planIds, appliedIds);
  const parts: string[] = [];
  if (movedUp.length > 0) {
    parts.push(`${movedUp.join(" and ")} moved up`);
  }
  if (lowered.length > 0) {
    parts.push(`${lowered.join(" and ")} lowered`);
  }
  const suffix = "Scores, evidence and text are unchanged.";
  if (parts.length === 0) {
    return `AI order applied. ${suffix}`;
  }
  return `AI order applied: ${parts.join("; ")}. ${suffix}`;
}

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
// the `score` card and the `explanation` card ("Why this score") are
// always floored, plus `signals` whenever a signal raises risk. Specs
// collapsing a floored section are rejected, so an AI layout can never
// bury the score, the explanation or a raised finding. Rendered ids
// only: the single shared source is SECTION_ORDER_STANDARD.
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
  const floored = ["score", "explanation"];
  if (raises || high) {
    floored.push("signals");
  }
  return Object.freeze(floored);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Client-side zod parse: the model JSON is validated against the closed
// component shape first (spec version, ranking and placement lists,
// whitelisted field names only), then against the offered context
// (whitelisted section and plugin ids, no raw duplicates, no collapse of a
// floored section after alias normalization, the rendered `score` always
// present). Any failure means the deterministic baseline stands; no partial
// spec is ever applied. The deterministic fallback is unchanged: null in,
// baseline out.
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
  const flooredRendered = new Set<string>();
  for (const flooredId of context.flooredSectionIds) {
    const normalizedFloored = normalizeAiSectionId(flooredId);
    if (normalizedFloored !== null) {
      flooredRendered.add(normalizedFloored);
    }
  }
  const seenSections = new Set<string>();
  const seenRendered = new Set<string>();
  const parsed: PersonalizePlacement[] = [];
  for (const placement of shaped.data.placements) {
    const sectionId = placement.sectionId;
    if (!presentSections.has(sectionId) || seenSections.has(sectionId)) {
      return null;
    }
    seenSections.add(sectionId);
    const rendered = normalizeAiSectionId(sectionId);
    if (rendered !== null) {
      seenRendered.add(rendered);
    }
    const collapsed = placement.collapsed ?? false;
    if (collapsed && rendered !== null && flooredRendered.has(rendered)) {
      return null;
    }
    parsed.push({ sectionId, emphasis: placement.emphasis, collapsed });
  }
  if (!seenRendered.has("score")) {
    return null;
  }
  return {
    pluginRanking: Object.freeze([...seenPlugins]),
    placements: Object.freeze(parsed),
  };
}

// Apply the validated spec to the section order: the `score` card first
// and the `explanation` card ("Why this score") second, always and in
// that order, whatever the model returns and whatever the signals are.
// Legacy aliases normalize to rendered ids, ids without an overview block
// drop, first occurrence wins. Every remaining section follows in AI
// order first, then standard relative order for unnamed sections; other
// floored sections (P-26 `signals` when risk is raised) clamp directly
// below the pinned pair. The result holds rendered ids only, so the page
// never renders a wrapper for an id without content.
const PINNED_FIRST: readonly string[] = Object.freeze(["score", "explanation"]);

export function applyAiSectionOrder(
  standardIds: readonly string[],
  spec: AiPersonalizeSpec,
  flooredIds: readonly string[],
): readonly string[] {
  const renderedStandard = standardIds
    .map((id) => normalizeAiSectionId(id))
    .filter((id): id is string => id !== null);
  const ordered: string[] = [];
  const listed = new Set<string>();
  for (const placement of spec.placements) {
    const rendered = normalizeAiSectionId(placement.sectionId);
    if (rendered === null || listed.has(rendered)) {
      continue;
    }
    listed.add(rendered);
    ordered.push(rendered);
  }
  const floored = new Set<string>();
  for (const flooredId of flooredIds) {
    const rendered = normalizeAiSectionId(flooredId);
    if (rendered !== null) {
      floored.add(rendered);
    }
  }
  const rest = renderedStandard.filter((id) => !listed.has(id));
  const combined = [...ordered, ...rest];
  const pinned = PINNED_FIRST.filter((id) => combined.includes(id));
  const withoutPinned = combined.filter((id) => !pinned.includes(id));
  const flooredRest = withoutPinned.filter((id) => floored.has(id));
  const openBlock = withoutPinned.filter((id) => !floored.has(id));
  return Object.freeze([...pinned, ...flooredRest, ...openBlock]);
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
