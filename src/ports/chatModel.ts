// Chat model port (S-096, K-302, K-305, K-309). Optional AI layer that
// answers one opt-in follow-up question over frozen analysis facts. The
// input is a closed frozen value (code hash, collected evidence ids in the
// `signal:<id>` form shared with the investigation facts, the meanings for
// those ids, the caller's question, prompt version) and the output is a
// validated answer list. Meanings pair each id with its stated meaning
// (plugin, kind, severity, direction, template meaning, temporality,
// selector names); an entry whose meaning says "not counted in the score"
// is an extended fact for extra context only, while one that says "sets
// the minimum score" is counted through the score floor. The answers are a labelled
// overlay only: they never enter the score, the evidence or the finding
// text. A null port (the default wiring) answers `not-configured` with
// zero provider calls and the deterministic explanation stands.
import type { FindingMeaning as FindingMeaningType } from "../domain/modelMeanings.ts";

export type ChatAnswer = {
  readonly text: string;
  readonly citations: readonly string[];
};

export type ChatInput = {
  readonly codeHash: string;
  readonly evidenceIds: readonly string[];
  readonly question: string;
  readonly promptVersion: string;
  readonly meanings?: readonly FindingMeaningType[] | undefined;
};

export const MAX_CHAT_QUESTION_CHARS = 500;

export const ChatInput = {
  create(input: {
    readonly codeHash: string;
    readonly evidenceIds: readonly string[];
    readonly question: string;
    readonly promptVersion: string;
    readonly meanings?: readonly FindingMeaningType[] | undefined;
  }): ChatInput | null {
    if (input.codeHash.length === 0 || input.promptVersion.length === 0) {
      return null;
    }
    if (
      input.question.length === 0 ||
      input.question.length > MAX_CHAT_QUESTION_CHARS
    ) {
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
      question: input.question,
      promptVersion: input.promptVersion,
      ...(input.meanings === undefined ? {} : { meanings: Object.freeze(input.meanings.slice()) }),
    });
  },
};

export type ChatModelOutcome =
  | { readonly kind: "ok"; readonly answers: readonly ChatAnswer[] }
  | { readonly kind: "not-configured" }
  | { readonly kind: "invalid-output" };

export type ChatModelPort = {
  chat(input: ChatInput): Promise<ChatModelOutcome>;
  provider(): string;
  modelId(): string;
};
