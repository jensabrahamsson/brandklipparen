// Chat service (S-096, K-302, K-305, K-309, K-502, K-513). Opt-in,
// advisory and display-only: a null port (the default) builds the disabled
// service, so every resolve answers `not-configured` with zero provider
// calls and the deterministic explanation stands. Model output is validated
// whole (answer count, text length, citation count and string shapes);
// any malformed answer discards the whole overlay as `invalid-output`.
// Surviving answers pass the citation check: an answer stays only when it
// carries at least one citation and every citation names a collected
// evidence id. Each dropped answer counts into `droppedClaims`; an empty
// survivor list yields an empty answer list, never a repaired substitute.
// Scores, evidence and finding text are untouched: this service reads the
// frozen envelope and returns a separate overlay.
import type { ChatAnswer, ChatInput, ChatModelOutcome, ChatModelPort } from "../ports/chatModel.ts";

export const MAX_CHAT_ANSWERS = 8;
export const MAX_CHAT_ANSWER_CHARS = 1000;
export const MAX_CHAT_CITATIONS_PER_ANSWER = 8;
// Versioned identifier of the chat prompt and evidence format. The overlay
// cache key (a later story) carries code hash, this version, provider and
// model id.
export const CHAT_PROMPT_VERSION = "chat-1";

export type CheckedChat = {
  readonly answers: readonly string[];
  readonly droppedClaims: number;
};

// Pure citation check over collected evidence ids: keep an answer only
// when every citation names a collected id and at least one citation is
// present. Uncited factual answers drop like uncollected citations do.
export function checkChatCitations(
  answers: readonly ChatAnswer[],
  collectedIds: ReadonlySet<string>,
): CheckedChat {
  const kept: string[] = [];
  let droppedClaims = 0;
  for (const answer of answers) {
    if (answer.citations.length === 0) {
      droppedClaims += 1;
      continue;
    }
    let cited = true;
    for (const citation of answer.citations) {
      if (!collectedIds.has(citation)) {
        cited = false;
        break;
      }
    }
    if (!cited) {
      droppedClaims += 1;
      continue;
    }
    kept.push(answer.text);
  }
  return Object.freeze({ answers: Object.freeze(kept.slice()), droppedClaims });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validAnswers(outcome: ChatModelOutcome): ChatAnswer[] | null {
  if (outcome.kind !== "ok") {
    return null;
  }
  if (outcome.answers.length > MAX_CHAT_ANSWERS) {
    return null;
  }
  const checked: ChatAnswer[] = [];
  for (const entry of outcome.answers) {
    if (!isRecord(entry)) {
      return null;
    }
    const text = entry["text"];
    const citations = entry["citations"];
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_CHAT_ANSWER_CHARS) {
      return null;
    }
    if (!Array.isArray(citations) || citations.length > MAX_CHAT_CITATIONS_PER_ANSWER) {
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

export type ChatOutcome =
  | {
      readonly kind: "ok";
      readonly answers: readonly string[];
      readonly droppedClaims: number;
      readonly provider: string;
      readonly modelId: string;
    }
  | { readonly kind: "not-configured" }
  | { readonly kind: "invalid-output" };

export type ChatService = {
  readonly enabled: boolean;
  readonly provider: string | null;
  readonly modelId: string | null;
  chat(input: ChatInput): Promise<ChatOutcome>;
};

// Explicit opt-in factory: a null port builds the disabled service, so the
// overlay stays off until a caller wires a real port.
export function createChatService(port: ChatModelPort | null): ChatService {
  if (port === null) {
    return Object.freeze({
      enabled: false,
      provider: null,
      modelId: null,
      chat: (): Promise<ChatOutcome> => Promise.resolve(Object.freeze({ kind: "not-configured" })),
    });
  }
  return Object.freeze({
    enabled: true,
    provider: port.provider(),
    modelId: port.modelId(),
    chat: async (input: ChatInput): Promise<ChatOutcome> => {
      const outcome = await port.chat(input);
      if (outcome.kind === "not-configured") {
        return Object.freeze({ kind: "not-configured" });
      }
      const answers = validAnswers(outcome);
      if (answers === null) {
        return Object.freeze({ kind: "invalid-output" });
      }
      const checked = checkChatCitations(answers, new Set(input.evidenceIds));
      return Object.freeze({
        kind: "ok",
        answers: checked.answers,
        droppedClaims: checked.droppedClaims,
        provider: port.provider(),
        modelId: port.modelId(),
      });
    },
  });
}

export function serializeChatOutcome(outcome: ChatOutcome): string {
  if (outcome.kind === "ok") {
    return JSON.stringify({
      kind: "ok",
      droppedClaims: outcome.droppedClaims,
      modelId: outcome.modelId,
      answers: outcome.answers,
      provider: outcome.provider,
    });
  }
  return JSON.stringify({ kind: outcome.kind });
}
