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
import type { CantTellQuestion } from "../domain/cantTell.ts";
import { ANALYSIS_SUMMARY_COVERAGE_ID, DECOMPILE_INCOMPLETE_COVERAGE_ID } from "./modelMeanings.ts";
import { withCitationMarkers } from "./citationMarkers.ts";
import type { OverlayBudget } from "./overlayBudget.ts";


export const MAX_EXPLAIN_SENTENCES = 16;
export const MAX_EXPLAIN_SENTENCE_CHARS = 1000;
export const MAX_EXPLAIN_CITATIONS_PER_SENTENCE = 8;
// Versioned identifier of the explain prompt and evidence format. The
// overlay cache key (a later story) carries code hash, this version,
// provider and model id.
export const EXPLAIN_PROMPT_VERSION = "explain-4";

// Reassurance terms (C-19): words that read as a clean bill of health.
// A sentence carrying one survives only when it cites a `signal:`
// evidence id, so "safe" can never be backed by a coverage limit entry
// (`analysis:*`, `cant-tell:*`) alone. Word boundaries keep "unsafe"
// and similar non-reassuring words out.
const REASSURANCE_PATTERN = /\b(safe|safely|safety|legit|legitimate|renounced|no[ -]risk|risk[ -]free)\b/i;

export function isReassuringSentence(text: string): boolean {
  return REASSURANCE_PATTERN.test(text);
}

function citesSignal(citations: readonly string[]): boolean {
  for (const citation of citations) {
    if (citation.startsWith("signal:")) {
      return true;
    }
  }
  return false;
}

// Meta-statements about grounding or evidence carry no holder impact:
// drop any sentence talking about being grounded, frozen evidence or
// evidence signals/ids/lists instead of what the owner can do.
export function isMetaStatement(text: string): boolean {
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

export type CheckedExplanation = {
  readonly narrative: readonly string[];
  readonly droppedClaims: number;
};

// Coverage citations the checker accepts beside collected `signal:`
// ids: exactly `analysis:summary`, `analysis:decompile-incomplete`,
// `cant-tell:<known question>` and
// `check:<detector>:not-found|could-not-check`. Anything else keeps
// the old rule: it must be a collected `signal:` id.
const CANT_TELL_QUESTIONS: ReadonlySet<string> = Object.freeze(
  new Set<string>([
    "liquidity-locks",
    "owner-shares",
    "wallet-clusters",
    "team-identity",
    "code-intent",
    "external-contracts",
  ] satisfies readonly CantTellQuestion[]),
);

export function isExplainCoverageId(id: string): boolean {
  if (id === ANALYSIS_SUMMARY_COVERAGE_ID || id === DECOMPILE_INCOMPLETE_COVERAGE_ID) {
    return true;
  }
  if (id.startsWith("cant-tell:")) {
    return CANT_TELL_QUESTIONS.has(id.slice("cant-tell:".length));
  }
  if (id.startsWith("check:")) {
    const rest = id.slice("check:".length);
    const split = rest.lastIndexOf(":");
    if (split <= 0 || split === rest.length - 1) {
      return false;
    }
    const outcome = rest.slice(split + 1);
    return outcome === "not-found" || outcome === "could-not-check";
  }
  return false;
}

// Pure citation check over collected evidence ids: keep a sentence only
// when it is not a meta-statement, at least one citation is present and
// every citation both names a collected id and carries a known shape (a
// `signal:` id or exactly one of the coverage ids above). Reassurance
// sentences (safe, legitimate, risk-free, renounced) survive only with a
// `signal:` citation, never on a coverage limit entry alone. Uncited
// factual sentences drop like uncollected citations, unknown shapes and
// meta-statements do. Kept sentences carry one `[E:<id>]` marker per
// validated citation (appended when the model text has none) so the web
// renders the citation chips.
export function checkExplainCitations(
  sentences: readonly ExplainSentence[],
  collectedIds: ReadonlySet<string>,
): CheckedExplanation {
  const narrative: string[] = [];
  let droppedClaims = 0;
  for (const sentence of sentences) {
    if (isMetaStatement(sentence.text)) {
      droppedClaims += 1;
      continue;
    }
    if (sentence.citations.length === 0) {
      droppedClaims += 1;
      continue;
    }
    if (isReassuringSentence(sentence.text) && !citesSignal(sentence.citations)) {
      droppedClaims += 1;
      continue;
    }
    let cited = true;
    for (const citation of sentence.citations) {
      if (!collectedIds.has(citation)) {
        cited = false;
        break;
      }
      if (!citation.startsWith("signal:") && !isExplainCoverageId(citation)) {
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
  | { readonly kind: "invalid-output" }
  | { readonly kind: "capped" };

export type ExplainService = {
  readonly enabled: boolean;
  readonly provider: string | null;
  readonly modelId: string | null;
  explain(input: ExplainInput, keyId?: string | undefined): Promise<ExplainOutcome>;
};

// Explicit opt-in factory: a null port builds the disabled service, so the
// overlay stays off until a caller wires a real port.
export function createExplainService(
  port: ExplainModelPort | null,
  budget?: OverlayBudget | undefined,
): ExplainService {
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
    explain: async (input: ExplainInput, keyId?: string | undefined): Promise<ExplainOutcome> => {
      const cacheKey = `explain|${port.provider()}|${port.modelId()}|${JSON.stringify(input)}`;
      if (budget !== undefined && keyId !== undefined) {
        const hit = budget.lookup<ExplainOutcome>(cacheKey);
        if (hit !== null) {
          return hit;
        }
        if (!budget.trySpend(keyId)) {
          return Object.freeze({ kind: "capped" });
        }
      }
      const outcome = await port.explain(input);
      if (outcome.kind === "not-configured") {
        return Object.freeze({ kind: "not-configured" });
      }
      const sentences = validSentences(outcome);
      if (sentences === null) {
        return Object.freeze({ kind: "invalid-output" });
      }
      const checked = checkExplainCitations(sentences, new Set(input.evidenceIds));
      const final: ExplainOutcome = Object.freeze({
        kind: "ok",
        narrative: checked.narrative,
        droppedClaims: checked.droppedClaims,
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
