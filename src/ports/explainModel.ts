// Explain model port (S-094, K-302, K-305, K-309). Optional AI layer that
// drafts one sentence-level explanation over frozen analysis facts. The
// input is a closed frozen value (code hash, collected evidence ids in the
// `signal:<id>` form shared with the investigation facts, the meanings for
// those ids, prompt version) and the output is a validated sentence list.
// Meanings pair each id with its stated meaning (plugin, kind, severity,
// direction, template meaning, temporality, selector names); an entry whose
// meaning says "not counted in the score" is an extended fact for extra
// context only. The suggestions are a labelled overlay only: they never
// enter the score, the evidence or the finding text. A null port (the
// default wiring) answers `not-configured` with zero provider calls and
// the deterministic explanation stands.
import type { FindingMeaning as FindingMeaningType } from "../domain/modelMeanings.ts";

export type ExplainSentence = {
  readonly text: string;
  readonly citations: readonly string[];
};

export type ExplainInput = {
  readonly codeHash: string;
  readonly evidenceIds: readonly string[];
  readonly promptVersion: string;
  readonly meanings?: readonly FindingMeaningType[] | undefined;
};

export const ExplainInput = {
  create(input: {
    readonly codeHash: string;
    readonly evidenceIds: readonly string[];
    readonly promptVersion: string;
    readonly meanings?: readonly FindingMeaningType[] | undefined;
  }): ExplainInput | null {
    if (input.codeHash.length === 0 || input.promptVersion.length === 0) {
      return null;
    }
    if (input.evidenceIds.length > 256) {
      return null;
    }
    for (const id of input.evidenceIds) {
      if (typeof id !== "string" || id.length === 0) {
        return null;
      }
    }
    return Object.freeze({
      codeHash: input.codeHash,
      evidenceIds: Object.freeze(input.evidenceIds.slice()),
      promptVersion: input.promptVersion,
      ...(input.meanings === undefined ? {} : { meanings: Object.freeze(input.meanings.slice()) }),
    });
  },
};

export type ExplainModelOutcome =
  | { readonly kind: "ok"; readonly sentences: readonly ExplainSentence[] }
  | { readonly kind: "not-configured" }
  | { readonly kind: "invalid-output" };

export type ExplainModelPort = {
  explain(input: ExplainInput): Promise<ExplainModelOutcome>;
  provider(): string;
  modelId(): string;
};
