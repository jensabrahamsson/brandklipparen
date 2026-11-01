// Rug narrative service (S-097, K-302, K-305, K-309, K-502, K-513).
// Opt-in, advisory and display-only: a null port (the default) builds the
// disabled service, so every resolve answers `not-configured` with zero
// provider calls and the deterministic explanation stands. Model output is
// validated whole (sentence count, text length, citation count and string
// shapes); any malformed sentence discards the whole overlay as
// `invalid-output`. Surviving sentences pass the citation check: a
// sentence stays only when it carries at least one citation and every
// citation names a collected evidence id. Each dropped sentence counts
// into `droppedClaims`; an empty survivor list yields an empty narrative,
// never a repaired substitute. Scores, evidence and finding text are
// untouched: this service reads the frozen envelope and returns a separate
// overlay.
import type { RugInput, RugModelOutcome, RugModelPort, RugSentence } from "../ports/rugModel.ts";
import { withCitationMarkers } from "./citationMarkers.ts";
import type { OverlayBudget } from "./overlayBudget.ts";


export const MAX_RUG_SENTENCES = 8;
export const MAX_RUG_SENTENCE_CHARS = 1000;
export const MAX_RUG_CITATIONS_PER_SENTENCE = 8;
// Versioned identifier of the rug prompt and evidence format. The overlay
// cache key (a later story) carries code hash, this version, provider and
// model id.
export const RUG_PROMPT_VERSION = "rug-3";

// Meta-statements about grounding or evidence carry no holder impact:
// drop any sentence talking about being grounded, frozen evidence or
// evidence signals/ids/lists instead of what the owner can do.
export function isRugMetaStatement(text: string): boolean {
  const lowered = text.toLowerCase();
  return (
    lowered.includes("grounded") ||
    lowered.includes("frozen evidence") ||
    lowered.includes("evidence signals") ||
    lowered.includes("evidence ids") ||
    lowered.includes("evidence id") ||
    lowered.includes("evidence list")
  );
}

export type CheckedRug = {
  readonly narrative: readonly string[];
  readonly droppedClaims: number;
};

// Pure citation check over collected evidence ids: keep a sentence only
// when it is not a meta-statement, every citation names a collected id
// and at least one citation is present. Uncited factual sentences drop
// like uncollected citations and meta-statements do. Kept sentences
// carry one `[E:<id>]` marker per validated citation (appended when the
// model text has none) so the web renders the citation chips.
export function checkRugCitations(
  sentences: readonly RugSentence[],
  collectedIds: ReadonlySet<string>,
): CheckedRug {
  const narrative: string[] = [];
  let droppedClaims = 0;
  for (const sentence of sentences) {
    if (isRugMetaStatement(sentence.text)) {
      droppedClaims += 1;
      continue;
    }
    if (sentence.citations.length === 0) {
      droppedClaims += 1;
      continue;
    }
    let cited = true;
    for (const citation of sentence.citations) {
      if (!collectedIds.has(citation)) {
        cited = false;
        break;
      }
    }
    if (!cited) {
      droppedClaims += 1;
      continue;
    }
    narrative.push(withCitationMarkers(sentence.text, sentence.citations));
  }
  return Object.freeze({ narrative: Object.freeze(narrative.slice()), droppedClaims });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validSentences(outcome: RugModelOutcome): RugSentence[] | null {
  if (outcome.kind !== "ok") {
    return null;
  }
  if (outcome.sentences.length > MAX_RUG_SENTENCES) {
    return null;
  }
  const checked: RugSentence[] = [];
  for (const entry of outcome.sentences) {
    if (!isRecord(entry)) {
      return null;
    }
    const text = entry["text"];
    const citations = entry["citations"];
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_RUG_SENTENCE_CHARS) {
      return null;
    }
    if (!Array.isArray(citations) || citations.length > MAX_RUG_CITATIONS_PER_SENTENCE) {
      return null;
    }
    const frozen: string[] = [];
    for (const citation of citations) {
      if (typeof citation !== "string" || citation.length === 0) {
        return null;
      }
      frozen.push(citation);
    }
    checked.push(Object.freeze({ text, citations: Object.freeze(frozen) }));
  }
  return checked;
}

export type RugOutcome =
  | {
      readonly kind: "ok";
      readonly narrative: readonly string[];
      readonly droppedClaims: number;
      readonly topRisk: string;
      readonly provider: string;
      readonly modelId: string;
    }
  | { readonly kind: "not-configured" }
  | { readonly kind: "invalid-output" }
  | { readonly kind: "capped" };

export type RugService = {
  readonly enabled: boolean;
  readonly provider: string | null;
  readonly modelId: string | null;
  narrate(input: RugInput, keyId?: string | undefined): Promise<RugOutcome>;
};

// Explicit opt-in factory: a null port builds the disabled service, so the
// overlay stays off until a caller wires a real port.
export function createRugService(
  port: RugModelPort | null,
  budget?: OverlayBudget | undefined,
): RugService {
  if (port === null) {
    return Object.freeze({
      enabled: false,
      provider: null,
      modelId: null,
      narrate: (): Promise<RugOutcome> => Promise.resolve(Object.freeze({ kind: "not-configured" })),
    });
  }
  return Object.freeze({
    enabled: true,
    provider: port.provider(),
    modelId: port.modelId(),
    narrate: async (input: RugInput, keyId?: string | undefined): Promise<RugOutcome> => {
      const cacheKey = `rug|${port.provider()}|${port.modelId()}|${JSON.stringify(input)}`;
      if (budget !== undefined && keyId !== undefined) {
        const hit = budget.lookup<RugOutcome>(cacheKey);
        if (hit !== null) {
          return hit;
        }
        if (!budget.trySpend(keyId)) {
          return Object.freeze({ kind: "capped" });
        }
      }
      const outcome = await port.narrate(input);
      if (outcome.kind === "not-configured") {
        return Object.freeze({ kind: "not-configured" });
      }
      const sentences = validSentences(outcome);
      if (sentences === null) {
        return Object.freeze({ kind: "invalid-output" });
      }
      const checked = checkRugCitations(sentences, new Set(input.evidenceIds));
      const final: RugOutcome = Object.freeze({
        kind: "ok",
        narrative: checked.narrative,
        droppedClaims: checked.droppedClaims,
        topRisk: input.topRisk,
        provider: port.provider(),
        modelId: port.modelId(),
      });
      if (budget !== undefined && keyId !== undefined) {
        budget.store(cacheKey, final);
      }
      return final;
    },
  });
}

export function serializeRugOutcome(outcome: RugOutcome): string {
  if (outcome.kind === "ok") {
    return JSON.stringify({
      kind: "ok",
      droppedClaims: outcome.droppedClaims,
      modelId: outcome.modelId,
      narrative: outcome.narrative,
      provider: outcome.provider,
      topRisk: outcome.topRisk,
    });
  }
  return JSON.stringify({ kind: outcome.kind });
}
