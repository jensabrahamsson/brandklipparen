// Experimental AI layout toggle state and spec application (S-070,
// K-519, P-27, P-28). The toggle is off by default and persisted under
// one versioned key; the visitor's priorities may leave the device only
// through one explicit per-request POST carrying priorities plus quoted
// plugin references, and any invalid or missing model output falls back
// to the deterministic baseline with scores, evidence and text unchanged.
// The client re-validates every model response with plain checks before
// applying it: whitelisted sections only, no collapse of the floored
// sections, ranking names only offered plugin ids.

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Client-side plain-check parse (P-28): mirrors the server contract over
// the offered context. Any failure means the deterministic baseline
// stands; no partial spec is ever applied.
export function parseAiPersonalizeSpec(value: unknown, context: PersonalizeContext): AiPersonalizeSpec | null {
  if (!isRecord(value) || value["specVersion"] !== 1) {
    return null;
  }
  const allowed = new Set(["specVersion", "pluginRanking", "placements"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return null;
    }
  }
  const ranking = value["pluginRanking"];
  if (!Array.isArray(ranking) || ranking.length > 16) {
    return null;
  }
  const presentPlugins = new Set(context.pluginIds);
  const seenPlugins = new Set<string>();
  for (const entry of ranking) {
    if (typeof entry !== "string" || entry.length === 0 || !presentPlugins.has(entry) || seenPlugins.has(entry)) {
      return null;
    }
    seenPlugins.add(entry);
  }
  const placements = value["placements"];
  if (!Array.isArray(placements) || placements.length > 16) {
    return null;
  }
  const presentSections = new Set(context.sectionIds);
  const floored = new Set(context.flooredSectionIds);
  const seenSections = new Set<string>();
  const parsed: PersonalizePlacement[] = [];
  for (const placement of placements) {
    if (!isRecord(placement)) {
      return null;
    }
    const keys = Object.keys(placement);
    if (keys.length > 3 || !keys.every((key) => key === "sectionId" || key === "emphasis" || key === "collapsed")) {
      return null;
    }
    const sectionId = placement["sectionId"];
    const emphasis = placement["emphasis"];
    if (typeof sectionId !== "string" || !presentSections.has(sectionId) || seenSections.has(sectionId)) {
      return null;
    }
    seenSections.add(sectionId);
    if (emphasis !== "normal" && emphasis !== "high" && emphasis !== "low") {
      return null;
    }
    const collapsed = placement["collapsed"] ?? false;
    if (typeof collapsed !== "boolean") {
      return null;
    }
    if (collapsed && floored.has(sectionId)) {
      return null;
    }
    parsed.push({ sectionId, emphasis, collapsed });
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
// standard relative order. Floored sections clamp ahead (P-26).
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
  return Object.freeze([...flooredBlock, ...openBlock]);
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
