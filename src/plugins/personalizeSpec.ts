// Unified personalize spec contract (S-068, K-519, P-28). One
// declarative ranking-plus-layout spec over the whitelisted section and
// plugin-card ids from the deterministic plan: an ordered plugin ranking
// plus section placements with closed emphasis. The spec carries no free
// text, no HTML, no code, no URLs, no styles and no score or severity
// value; `score` and `explanation` are always present and never collapsible,
// and no placement may collapse a P-26 floored section. TypeScript types
// are normative with a JSON Schema descriptor beside them (draft-07
// subset, `additionalProperties: false`); the plain-check smart
// constructor `parsePersonalizeSpec` validates every model response
// before the UI applies it. Any failure gives typed `invalid-output`
// and the whole spec is discarded: no partial spec is ever applied.
// No schema library is added (P-28, same rationale as P-14/P-22).
import { err, ok } from "../domain/result.ts";
import type { Result } from "../domain/result.ts";
import type { JsonSchema } from "./api.ts";

export const PERSONALIZE_SPEC_VERSION = 1;

export const PERSONALIZE_MAX_RANKING = 16;
export const PERSONALIZE_MAX_PLACEMENTS = 16;

// Closed section whitelist (P-22 family, section 0.2): the rendered
// overview ids the route offers (`score`, `explanation`, `signals`,
// `plugin-findings`, `cant-tell`) plus legacy model ids kept for
// backward compatibility (`summary` reads as `score`, `evidence` reads
// as `explanation`, `assessment` and `expert-detail` have no overview
// block). Ranking and placements operate at two levels that cannot
// conflict: cards inside one section (pluginRanking), sections on the
// page (placements).
export const PERSONALIZE_SECTION_IDS: readonly string[] = Object.freeze([
  "score",
  "explanation",
  "signals",
  "plugin-findings",
  "cant-tell",
  "summary",
  "evidence",
  "assessment",
  "expert-detail",
]);

export type PersonalizeEmphasis = "normal" | "high" | "low";

export type PersonalizePlacement = {
  readonly sectionId: string;
  readonly emphasis: PersonalizeEmphasis;
  readonly collapsed: boolean;
};

export type PersonalizeSpec = {
  readonly specVersion: number;
  readonly pluginRanking: readonly string[];
  readonly placements: readonly PersonalizePlacement[];
};

// Request context the validation needs (P-28, section 0.2): the present
// section ids, the present plugin ids and the floored sets. "Ranking
// names an absent plugin" is checkable only against the ids the request
// offered, so the context travels with the parse.
export type PersonalizeSpecContext = {
  readonly sectionIds: readonly string[];
  readonly pluginIds: readonly string[];
  readonly flooredSectionIds: readonly string[];
  readonly maxPlacements: number;
  readonly maxRanking: number;
};

export type PersonalizeSpecError = {
  readonly kind: "invalid-output";
  readonly message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// JSON Schema descriptor beside the types (P-28): the draft-07 subset the
// registry documents. Published with the REST schema; the contract test
// checks types and descriptor against each other on frozen examples.
export function personalizeSpecJsonSchema(): JsonSchema {
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["specVersion", "pluginRanking", "placements"]),
    properties: Object.freeze({
      specVersion: Object.freeze({ const: PERSONALIZE_SPEC_VERSION }),
      pluginRanking: Object.freeze({
        type: "array",
        maxItems: PERSONALIZE_MAX_RANKING,
        items: Object.freeze({ type: "string", minLength: 1 }),
      }),
      placements: Object.freeze({
        type: "array",
        maxItems: PERSONALIZE_MAX_PLACEMENTS,
        items: Object.freeze({
          type: "object",
          additionalProperties: false,
          required: Object.freeze(["sectionId", "emphasis"]),
          properties: Object.freeze({
            sectionId: Object.freeze({ enum: Object.freeze([...PERSONALIZE_SECTION_IDS]) }),
            emphasis: Object.freeze({ enum: Object.freeze(["normal", "high", "low"]) }),
            collapsed: Object.freeze({ type: "boolean" }),
          }),
        }),
      }),
    }),
  });
}

// Plain-check smart constructor: every model response passes here before
// the UI applies it. Unknown or duplicate plugin ids, rankings naming
// absent plugins, unknown or duplicate section ids, missing `score` or
// `explanation` (legacy `summary` satisfies `score`, legacy `evidence`
// satisfies `explanation`), oversize specs, extra fields, and any collapse
// of a floored section give `invalid-output` with no partial spec applied.
export function parsePersonalizeSpec(
  value: unknown,
  context: PersonalizeSpecContext,
): Result<PersonalizeSpec, PersonalizeSpecError> {
  const invalid = (message: string): Result<PersonalizeSpec, PersonalizeSpecError> =>
    err({ kind: "invalid-output", message });
  if (!isRecord(value)) {
    return invalid("personalize spec must be an object");
  }
  const allowedKeys = new Set(["specVersion", "pluginRanking", "placements"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      return invalid(`personalize spec forbids the field ${key}`);
    }
  }
  if (value["specVersion"] !== PERSONALIZE_SPEC_VERSION) {
    return invalid("personalize spec carries an unsupported spec version");
  }
  const ranking = value["pluginRanking"];
  if (!Array.isArray(ranking)) {
    return invalid("personalize spec ranking must be a list");
  }
  if (ranking.length > Math.min(context.maxRanking, PERSONALIZE_MAX_RANKING)) {
    return invalid("personalize spec ranking exceeds the size bound");
  }
  const presentPlugins = new Set(context.pluginIds);
  const seenPlugins = new Set<string>();
  for (const entry of ranking) {
    if (typeof entry !== "string" || entry.length === 0) {
      return invalid("personalize spec ranking holds plugin ids only");
    }
    if (!presentPlugins.has(entry)) {
      return invalid(`personalize spec ranking names a plugin absent from the request: ${entry}`);
    }
    if (seenPlugins.has(entry)) {
      return invalid(`personalize spec ranking repeats a plugin id: ${entry}`);
    }
    seenPlugins.add(entry);
  }
  const placements = value["placements"];
  if (!Array.isArray(placements)) {
    return invalid("personalize spec placements must be a list");
  }
  if (placements.length > Math.min(context.maxPlacements, PERSONALIZE_MAX_PLACEMENTS)) {
    return invalid("personalize spec placements exceed the size bound");
  }
  const presentSections = new Set(context.sectionIds);
  const floored = new Set(context.flooredSectionIds);
  const seenSections = new Set<string>();
  const parsed: PersonalizePlacement[] = [];
  for (const placement of placements) {
    if (!isRecord(placement)) {
      return invalid("personalize spec placements hold placement objects only");
    }
    for (const key of Object.keys(placement)) {
      if (key !== "sectionId" && key !== "emphasis" && key !== "collapsed") {
        return invalid(`personalize spec placement forbids the field ${key}`);
      }
    }
    const sectionId = placement["sectionId"];
    const emphasis = placement["emphasis"];
    if (typeof sectionId !== "string" || !presentSections.has(sectionId)) {
      return invalid("personalize spec placement names an unknown section id");
    }
    if (seenSections.has(sectionId)) {
      return invalid(`personalize spec placement repeats a section id: ${sectionId}`);
    }
    seenSections.add(sectionId);
    if (emphasis !== "normal" && emphasis !== "high" && emphasis !== "low") {
      return invalid("personalize spec emphasis stays on normal, high, low");
    }
    const collapsed = placement["collapsed"] ?? false;
    if (typeof collapsed !== "boolean") {
      return invalid("personalize spec collapsed flag holds a boolean only");
    }
    if (collapsed && floored.has(sectionId)) {
      return invalid(`personalize spec must not collapse a floored section: ${sectionId}`);
    }
    parsed.push(Object.freeze({ sectionId, emphasis, collapsed }));
  }
  const hasScore = seenSections.has("score") || seenSections.has("summary");
  const hasExplanation = seenSections.has("explanation") || seenSections.has("evidence");
  if (!hasScore || !hasExplanation) {
    return invalid("personalize spec placements always include score and explanation");
  }
  return ok(
    Object.freeze({
      specVersion: PERSONALIZE_SPEC_VERSION,
      pluginRanking: Object.freeze([...seenPlugins]),
      placements: Object.freeze(parsed),
    }),
  );
}
