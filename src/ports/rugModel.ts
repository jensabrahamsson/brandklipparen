// Rug narrative model port (S-097, K-302, K-305, K-309). Optional AI
// layer that drafts one opt-in capability summary for the top risk type
// over frozen analysis facts. The input is a closed frozen value (code
// hash, collected evidence ids in the `signal:<id>` form shared with the
// investigation facts, the meanings for those ids, the top risk type read
// from the frozen envelope's probabilities, prompt version) and the output
// is a validated sentence list. Meanings pair each id with its stated
// meaning (plugin, kind, severity, direction, template meaning,
// temporality, selector names); an entry whose meaning says "not counted
// in the score" is an extended fact for extra context only. The narrative
// is a labelled overlay only: it never enters the score, the evidence or
// the finding text. A null port (the default wiring) answers
// `not-configured` with zero provider calls and the deterministic
// explanation stands.
import type { FindingMeaning as FindingMeaningType } from "../domain/modelMeanings.ts";

export type RugSentence = {
  readonly text: string;
  readonly citations: readonly string[];
};

export type RugRisk = "rug-pull" | "honeypot" | "bot-pump";

export const RUG_RISKS: readonly RugRisk[] = Object.freeze(["rug-pull", "honeypot", "bot-pump"]);

export type RugInput = {
  readonly codeHash: string;
  readonly evidenceIds: readonly string[];
  readonly topRisk: RugRisk;
  readonly promptVersion: string;
  readonly meanings?: readonly FindingMeaningType[] | undefined;
};

export const RugInput = {
  create(input: {
    readonly codeHash: string;
    readonly evidenceIds: readonly string[];
    readonly topRisk: string;
    readonly promptVersion: string;
    readonly meanings?: readonly FindingMeaningType[] | undefined;
  }): RugInput | null {
    if (input.codeHash.length === 0 || input.promptVersion.length === 0) {
      return null;
    }
    if (!(RUG_RISKS as readonly string[]).includes(input.topRisk)) {
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
      topRisk: input.topRisk as RugRisk,
      promptVersion: input.promptVersion,
      ...(input.meanings === undefined ? {} : { meanings: Object.freeze(input.meanings.slice()) }),
    });
  },
};

export type RugModelOutcome =
  | { readonly kind: "ok"; readonly sentences: readonly RugSentence[] }
  | { readonly kind: "not-configured" }
  | { readonly kind: "invalid-output" };

export type RugModelPort = {
  narrate(input: RugInput): Promise<RugModelOutcome>;
  provider(): string;
  modelId(): string;
};
