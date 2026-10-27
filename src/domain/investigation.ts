// Investigation types, trace and deterministic citation checker (S-072,
// K-036, K-520, P-31, P-35). Pure domain module: the citation check is a
// total function of the narrative draft and the collected evidence ids.
// A sentence survives only when it cites at least one collected id and
// cites no uncollected id; every other sentence drops and is counted in
// `droppedClaims`. An empty survivor set yields an empty narrative, never
// a repaired substitute. Terminal states carry no outgoing transition in
// the type: `transitionInvestigation` turns away any event from `done`
// or `failed` with a typed error.
import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";

// Collected evidence id: opaque string minted by the runner when a tool
// returns evidence (P-32). The citation marker in narrative text is
// `[E:<id>]`, matched by CITATION_PATTERN below.
export type EvidenceRef = string;

// One executed step in the investigation trace (P-31, P-36). The trace is
// the replayable record: the same scripted decisions replay bit-identical
// apart from `elapsedMs`.
export type InvestigationTraceStep = {
  readonly step: number;
  readonly toolId: string;
  readonly rationale: string;
  readonly evidenceIds: readonly EvidenceRef[];
  readonly elapsedMs: number;
};

export type InvestigationTrace = readonly InvestigationTraceStep[];

// Typed terminal outcomes (P-31, P-34). `done` carries the checked report;
// every other outcome ends with the partial trace preserved.
export type InvestigationOutcome =
  | { kind: "done" }
  | { kind: "step-limit"; limit: number }
  | { kind: "token-limit"; limit: number }
  | { kind: "deadline"; limitMs: number }
  | { kind: "tool-timeout"; toolId: string }
  | { kind: "invalid-decision"; detail: string };

export type InvestigationFailure =
  | { kind: "step-limit"; message: string; limit: number }
  | { kind: "token-limit"; message: string; limit: number }
  | { kind: "deadline"; message: string; limitMs: number }
  | { kind: "tool-timeout"; message: string; toolId: string }
  | { kind: "invalid-decision"; message: string; detail: string };

// Checked narrative with its drop accounting (P-35).
export type CheckedNarrative = {
  readonly narrative: string;
  readonly droppedClaims: number;
};

// Final report written only by the runner into `done` (P-33): scores,
// probabilities, signals and evidence live outside this envelope and the
// investigation never writes them.
export type InvestigationReport = {
  readonly outcome: "done";
  readonly narrative: string;
  readonly droppedClaims: number;
  readonly steps: InvestigationTrace;
  readonly collectedEvidenceIds: readonly EvidenceRef[];
};

// Partial report for non-terminal and failed runs: the same trace shape
// with the outcome named, so streaming and replay share one record.
export type PartialInvestigationReport = {
  readonly outcome: Exclude<InvestigationOutcome["kind"], "done">;
  readonly narrative: string;
  readonly droppedClaims: number;
  readonly steps: InvestigationTrace;
  readonly collectedEvidenceIds: readonly EvidenceRef[];
};

// Explicit typed state machine (P-31). The model never moves the machine
// directly: it returns one closed decision value, the runner validates it
// and only a validated decision causes a transition. `done` and `failed`
// are terminal and carry no outgoing transition in this type.
export type InvestigationState =
  | { kind: "planning" }
  | { kind: "awaiting-tool"; toolId: string; rationale: string }
  | { kind: "observing"; toolId: string; evidenceIds: readonly EvidenceRef[] }
  | { kind: "deciding" }
  | { kind: "concluding"; draft: string }
  | { kind: "done"; report: InvestigationReport }
  | { kind: "failed"; reason: InvestigationFailure; partial: InvestigationTrace };

export type InvestigationEvent =
  | { kind: "decide" }
  | { kind: "tool-called"; toolId: string; rationale: string }
  | { kind: "tool-observed"; toolId: string; evidenceIds: readonly EvidenceRef[] }
  | { kind: "conclude"; draft: string }
  | { kind: "finish"; report: InvestigationReport }
  | { kind: "fail"; reason: InvestigationFailure; partial: InvestigationTrace };

export type InvestigationTransitionError =
  | { kind: "terminal-state"; message: string }
  | { kind: "illegal-transition"; message: string };

const TERMINAL_MESSAGE = "terminal investigation states carry no outgoing transition";

// Allowed next kinds per non-terminal state. Terminal states are absent,
// so no outgoing transition exists for them in this table or the type.
const ALLOWED: Record<string, readonly string[]> = Object.freeze({
  planning: Object.freeze(["decide", "fail"]),
  "awaiting-tool": Object.freeze(["tool-observed", "fail"]),
  observing: Object.freeze(["decide", "fail"]),
  deciding: Object.freeze(["tool-called", "conclude", "fail"]),
  concluding: Object.freeze(["finish", "fail"]),
});

export function transitionInvestigation(
  state: InvestigationState,
  event: InvestigationEvent,
): Result<InvestigationState, InvestigationTransitionError> {
  if (state.kind === "done" || state.kind === "failed") {
    return err({ kind: "terminal-state", message: TERMINAL_MESSAGE });
  }
  const allowed = ALLOWED[state.kind] ?? [];
  if (!allowed.includes(event.kind)) {
    return err({
      kind: "illegal-transition",
      message: `event ${event.kind} does not leave state ${state.kind}`,
    });
  }
  switch (event.kind) {
    case "decide":
      return ok({ kind: "deciding" });
    case "tool-called":
      return ok({ kind: "awaiting-tool", toolId: event.toolId, rationale: event.rationale });
    case "tool-observed":
      return ok({ kind: "observing", toolId: event.toolId, evidenceIds: event.evidenceIds.slice() });
    case "conclude":
      return ok({ kind: "concluding", draft: event.draft });
    case "finish":
      return ok({ kind: "done", report: event.report });
    case "fail":
      return ok({ kind: "failed", reason: event.reason, partial: event.partial.slice() });
  }
}

// Citation marker `[E:<id>]`: the id carries word characters, dashes and
// dots so runner-minted ids match without quoting surprises.
const CITATION_PATTERN = /\[E:([A-Za-z0-9_.-]+)\]/g;

function citedIds(sentence: string): string[] {
  const found: string[] = [];
  CITATION_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CITATION_PATTERN.exec(sentence)) !== null) {
    const id = match[1];
    if (id !== undefined) {
      found.push(id);
    }
  }
  return found;
}

// Sentence split on `.`, `!` and `?` followed by whitespace or the end of
// the draft. The split keeps the terminator with its sentence so the
// surviving narrative rejoins with single spaces. A trailing citation
// fragment (markers only, no words of its own) attaches to the sentence
// it follows, since drafts cite as `claim. [E:id]`.
function splitSentences(draft: string): string[] {
  const raw: string[] = [];
  let current = "";
  for (let index = 0; index < draft.length; index += 1) {
    const char = draft[index] ?? "";
    current += char;
    if (char === "." || char === "!" || char === "?") {
      const next = draft[index + 1];
      if (next === undefined || next === " " || next === "\t" || next === "\n") {
        const trimmed = current.trim();
        if (trimmed.length > 0) {
          raw.push(trimmed);
        }
        current = "";
      }
    }
  }
  const tail = current.trim();
  if (tail.length > 0) {
    raw.push(tail);
  }
  // Leading citation markers belong to the sentence they trail: drafts
  // cite as `claim. [E:id] next claim`, so the split leaves `[E:id]` at
  // the head of the following segment. Move those markers back.
  const sentences: string[] = [];
  const leadingMarkers = /^(\[E:[A-Za-z0-9_.-]+\]\s*)+/;
  for (const segment of raw) {
    const markers = segment.match(leadingMarkers)?.[0] ?? "";
    const rest = markers.length > 0 ? segment.slice(markers.length).trim() : segment;
    const previous = sentences.pop();
    if (markers.length > 0 && previous !== undefined) {
      sentences.push(`${previous} ${markers.trim()}`);
      if (rest.length > 0) {
        sentences.push(rest);
      }
    } else {
      if (previous !== undefined) {
        sentences.push(previous);
      }
      sentences.push(segment);
    }
  }
  return sentences;
}

// Deterministic sentence-level citation check (P-35): a sentence survives
// exactly when every id it cites is collected and it cites at least one.
// Uncited sentences drop (the checker cannot verify them), and sentences
// citing an uncollected id drop. Each drop increments `droppedClaims`.
export function checkCitations(
  draft: string,
  collectedIds: readonly EvidenceRef[],
): CheckedNarrative {
  const collected = new Set<string>(collectedIds);
  const kept: string[] = [];
  let dropped = 0;
  for (const sentence of splitSentences(draft)) {
    const cited = citedIds(sentence);
    if (cited.length === 0) {
      dropped += 1;
      continue;
    }
    let unknown = false;
    for (const id of cited) {
      if (!collected.has(id)) {
        unknown = true;
        break;
      }
    }
    if (unknown) {
      dropped += 1;
      continue;
    }
    kept.push(sentence);
  }
  return { narrative: kept.join(" "), droppedClaims: dropped };
}
