// Explain service (S-094, K-302, K-305, K-309, K-502, K-513). Opt-in,
// advisory and display-only: a null port (the default) builds the disabled
// service, so every resolve answers `not-configured` with zero provider
// calls and the deterministic explanation stands. Model output is validated
// whole (sentence count, text length, citation count and string shapes);
// any malformed sentence discards the whole overlay as `invalid-output`.
// Surviving sentences pass the citation check: a sentence stays only when
// it carries at least one citation and every citation names a collected
// evidence id. Each dropped sentence counts into `droppedClaims`; an empty
// survivor list yields an empty narrative, never a repaired substitute.
// Scores, evidence and finding text are untouched: this service reads the
// frozen envelope and returns a separate overlay.
import type { ExplainInput, ExplainModelOutcome, ExplainModelPort, ExplainSentence } from "../ports/explainModel.ts";

export const MAX_EXPLAIN_SENTENCES = 16;
export const MAX_EXPLAIN_SENTENCE_CHARS = 1000;
export const MAX_EXPLAIN_CITATIONS_PER_SENTENCE = 8;
// Versioned identifier of the explain prompt and evidence format. The
// overlay cache key (a later story) carries code hash, this version,
// provider and model id.
export const EXPLAIN_PROMPT_VERSION = "explain-1";

export type CheckedExplanation = {
  readonly narrative: readonly string[];
  readonly droppedClaims: number;
};

// Pure citation check over collected evidence ids: keep a sentence only
// when every citation names a collected id and at least one citation is
// present. Uncited factual sentences drop like uncollected citations do.
export function checkExplainCitations(
  sentences: readonly ExplainSentence[],
  collectedIds: ReadonlySet<string>,
): CheckedExplanation {
  const narrative: string[] = [];
  let droppedClaims = 0;
  for (const sentence of sentences) {
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
    narrative.push(sentence.text);
  }
  return Object.freeze({ narrative: Object.freeze(narrative.slice()), droppedClaims });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validSentences(outcome: ExplainModelOutcome): ExplainSentence[] | null {
  if (outcome.kind !== "ok") {
    return null;
  }
  if (outcome.sentences.length > MAX_EXPLAIN_SENTENCES) {
    return null;
  }
  const checked: ExplainSentence[] = [];
  for (const entry of outcome.sentences) {
    if (!isRecord(entry)) {
      return null;
    }
    const text = entry["text"];
    const citations = entry["citations"];
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_EXPLAIN_SENTENCE_CHARS) {
      return null;
    }
    if (!Array.isArray(citations) || citations.length > MAX_EXPLAIN_CITATIONS_PER_SENTENCE) {
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

export type ExplainOutcome =
  | {
      readonly kind: "ok";
      readonly narrative: readonly string[];
      readonly droppedClaims: number;
      readonly provider: string;
      readonly modelId: string;
    }
  | { readonly kind: "not-configured" }
  | { readonly kind: "invalid-output" };

export type ExplainService = {
  readonly enabled: boolean;
  readonly provider: string | null;
  readonly modelId: string | null;
  explain(input: ExplainInput): Promise<ExplainOutcome>;
};

// Explicit opt-in factory: a null port builds the disabled service, so the
// overlay stays off until a caller wires a real port.
export function createExplainService(port: ExplainModelPort | null): ExplainService {
  if (port === null) {
    return Object.freeze({
      enabled: false,
      provider: null,
      modelId: null,
      explain: (): Promise<ExplainOutcome> => Promise.resolve(Object.freeze({ kind: "not-configured" })),
    });
  }
  return Object.freeze({
    enabled: true,
    provider: port.provider(),
    modelId: port.modelId(),
    explain: async (input: ExplainInput): Promise<ExplainOutcome> => {
      const outcome = await port.explain(input);
      if (outcome.kind === "not-configured") {
        return Object.freeze({ kind: "not-configured" });
      }
      const sentences = validSentences(outcome);
      if (sentences === null) {
        return Object.freeze({ kind: "invalid-output" });
      }
      const checked = checkExplainCitations(sentences, new Set(input.evidenceIds));
      return Object.freeze({
        kind: "ok",
        narrative: checked.narrative,
        droppedClaims: checked.droppedClaims,
        provider: port.provider(),
        modelId: port.modelId(),
      });
    },
  });
}

export function serializeExplainOutcome(outcome: ExplainOutcome): string {
  if (outcome.kind === "ok") {
    return JSON.stringify({
      kind: "ok",
      droppedClaims: outcome.droppedClaims,
      modelId: outcome.modelId,
      narrative: outcome.narrative,
      provider: outcome.provider,
    });
  }
  return JSON.stringify({ kind: outcome.kind });
}
