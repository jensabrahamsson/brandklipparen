// Explain-code service (VS-B3). Opt-in, advisory and display-only: a
// null port (the default) builds the disabled service, so every resolve
// answers `not-configured` with zero provider calls and the deterministic
// code view stands. Model output is validated whole (summary and note
// counts, text lengths, line ranges, citation string shapes); any malformed
// entry discards the whole overlay as `invalid-output`. Surviving entries
// pass the line and citation check: an entry stays only when it is not a
// meta-statement, every cited line exists in the frozen sent lines, every
// cited evidence id names a collected id, and at least one citation is
// present. Each dropped entry counts into `droppedClaims`; an empty
// survivor list yields an empty explanation, never a repaired substitute.
// Scores, evidence and finding text are untouched: this service reads the
// frozen code lines and returns a separate overlay. The budget cache key
// carries code hash, selector, view, prompt version, provider and model
// id, so re-opening a function costs zero and spends nothing.
import type {
  ExplainCodeInput,
  ExplainCodeModelOutcome,
  ExplainCodeModelPort,
  ExplainCodeNote,
  ExplainCodeSummarySentence,
} from "../ports/explainCodeModel.ts";
import type { OverlayBudget } from "./overlayBudget.ts";

export const MAX_EXPLAIN_CODE_SUMMARY_SENTENCES = 3;
export const MAX_EXPLAIN_CODE_NOTES = 6;
export const MAX_EXPLAIN_CODE_TEXT_CHARS = 1000;
export const MAX_EXPLAIN_CODE_CITES_PER_ENTRY = 8;
export const MAX_EXPLAIN_CODE_LINES_PER_NOTE = 32;
// Versioned identifier of the explain-code prompt and code format. The
// overlay cache key carries code hash, selector, view, this version,
// provider and model id.
export const EXPLAIN_CODE_PROMPT_VERSION = "explain-code-1";

// Meta-statements about grounding or evidence carry no holder impact:
// drop any entry talking about being grounded, frozen evidence or
// evidence signals/ids/lists instead of what the function does.
export function isExplainCodeMetaStatement(text: string): boolean {
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

function isLineCite(cite: string): boolean {
  return /^line:\d+$/.test(cite);
}

function lineOfCite(cite: string): number {
  return Number(cite.slice("line:".length));
}

// Pure line and citation check over the frozen sent lines and the
// collected evidence ids: keep an entry only when it is not a
// meta-statement, every cited line exists in the sent view, every other
// citation names a collected id, and at least one citation is present.
// Notes additionally need at least one line in range.
type CheckableEntry = {
  readonly text: string;
  readonly cites: readonly string[];
  readonly lines?: readonly number[] | undefined;
};

function checkEntries(
  entries: readonly CheckableEntry[],
  validLines: ReadonlySet<number>,
  collectedIds: ReadonlySet<string>,
  requireLines: boolean,
  noteLines: (entry: CheckableEntry) => readonly number[] | null,
): { readonly kept: readonly string[]; readonly droppedClaims: number } {
  const kept: string[] = [];
  let droppedClaims = 0;
  for (const entry of entries) {
    if (isExplainCodeMetaStatement(entry.text)) {
      droppedClaims += 1;
      continue;
    }
    if (entry.cites.length === 0) {
      droppedClaims += 1;
      continue;
    }
    const lines = noteLines(entry);
    if (requireLines && (lines === null || lines.length === 0)) {
      droppedClaims += 1;
      continue;
    }
    if (lines !== null) {
      let ranged = true;
      for (const line of lines) {
        if (!validLines.has(line)) {
          ranged = false;
          break;
        }
      }
      if (!ranged) {
        droppedClaims += 1;
        continue;
      }
    }
    let cited = true;
    for (const cite of entry.cites) {
      if (isLineCite(cite)) {
        if (!validLines.has(lineOfCite(cite))) {
          cited = false;
          break;
        }
      } else if (!collectedIds.has(cite)) {
        cited = false;
        break;
      }
    }
    if (!cited) {
      droppedClaims += 1;
      continue;
    }
    kept.push(entry.text);
  }
  return Object.freeze({ kept: Object.freeze(kept.slice()), droppedClaims });
}

export type CheckedExplainCode = {
  readonly summary: readonly string[];
  readonly notes: readonly { readonly lines: readonly number[]; readonly text: string }[];
  readonly droppedClaims: number;
};

// Pure check over the frozen sent lines and collected evidence ids. Notes
// keep their line ranges beside the text so the UI can anchor them.
export function checkExplainCodeCitations(
  summary: readonly ExplainCodeSummarySentence[],
  notes: readonly ExplainCodeNote[],
  validLines: ReadonlySet<number>,
  collectedIds: ReadonlySet<string>,
): CheckedExplainCode {
  const keptNotes: { readonly lines: readonly number[]; readonly text: string }[] = [];
  let droppedClaims = 0;
  const checkedSummary = checkEntries(
    summary,
    validLines,
    collectedIds,
    false,
    () => null,
  );
  droppedClaims += checkedSummary.droppedClaims;
  for (const note of notes) {
    const single = checkEntries(
      [{ text: note.text, cites: note.cites }],
      validLines,
      collectedIds,
      true,
      () => note.lines,
    );
    droppedClaims += single.droppedClaims;
    if (single.kept.length === 1) {
      keptNotes.push(Object.freeze({ lines: Object.freeze(note.lines.slice()), text: single.kept[0] as string }));
    }
  }
  return Object.freeze({
    summary: checkedSummary.kept,
    notes: Object.freeze(keptNotes),
    droppedClaims,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validCites(cites: unknown): string[] | null {
  if (!Array.isArray(cites) || cites.length === 0 || cites.length > MAX_EXPLAIN_CODE_CITES_PER_ENTRY) {
    return null;
  }
  const frozen: string[] = [];
  for (const cite of cites) {
    if (typeof cite !== "string" || cite.length === 0) {
      return null;
    }
    frozen.push(cite);
  }
  return frozen;
}

function validSummary(outcome: ExplainCodeModelOutcome): ExplainCodeSummarySentence[] | null {
  if (outcome.kind !== "ok") {
    return null;
  }
  if (outcome.summary.length > MAX_EXPLAIN_CODE_SUMMARY_SENTENCES) {
    return null;
  }
  const checked: ExplainCodeSummarySentence[] = [];
  for (const entry of outcome.summary) {
    if (!isRecord(entry)) {
      return null;
    }
    const text = entry["text"];
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_EXPLAIN_CODE_TEXT_CHARS) {
      return null;
    }
    const cites = validCites(entry["cites"]);
    if (cites === null) {
      return null;
    }
    checked.push(Object.freeze({ text, cites: Object.freeze(cites) }));
  }
  return checked;
}

function validNotes(outcome: ExplainCodeModelOutcome): ExplainCodeNote[] | null {
  if (outcome.kind !== "ok") {
    return null;
  }
  if (outcome.notes.length > MAX_EXPLAIN_CODE_NOTES) {
    return null;
  }
  const checked: ExplainCodeNote[] = [];
  for (const entry of outcome.notes) {
    if (!isRecord(entry)) {
      return null;
    }
    const rawLines = entry["lines"];
    if (!Array.isArray(rawLines) || rawLines.length === 0 || rawLines.length > MAX_EXPLAIN_CODE_LINES_PER_NOTE) {
      return null;
    }
    const lines: number[] = [];
    for (const line of rawLines) {
      if (!Number.isInteger(line) || (line as number) < 1) {
        return null;
      }
      lines.push(line as number);
    }
    for (let index = 1; index < lines.length; index += 1) {
      if ((lines[index] as number) < (lines[index - 1] as number)) {
        return null;
      }
    }
    const text = entry["text"];
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_EXPLAIN_CODE_TEXT_CHARS) {
      return null;
    }
    const cites = validCites(entry["cites"]);
    if (cites === null) {
      return null;
    }
    checked.push(Object.freeze({ lines: Object.freeze(lines), text, cites: Object.freeze(cites) }));
  }
  return checked;
}

export type ExplainCodeOutcome =
  | {
      readonly kind: "ok";
      readonly summary: readonly string[];
      readonly notes: readonly { readonly lines: readonly number[]; readonly text: string }[];
      readonly droppedClaims: number;
      readonly provider: string;
      readonly modelId: string;
    }
  | { readonly kind: "not-configured" }
  | { readonly kind: "invalid-output" }
  | { readonly kind: "capped" };

export type ExplainCodeService = {
  readonly enabled: boolean;
  readonly provider: string | null;
  readonly modelId: string | null;
  explainCode(input: ExplainCodeInput, keyId?: string | undefined): Promise<ExplainCodeOutcome>;
};

// Explicit opt-in factory: a null port builds the disabled service, so the
// overlay stays off until a caller wires a real port.
export function createExplainCodeService(
  port: ExplainCodeModelPort | null,
  budget?: OverlayBudget | undefined,
): ExplainCodeService {
  if (port === null) {
    return Object.freeze({
      enabled: false,
      provider: null,
      modelId: null,
      explainCode: (): Promise<ExplainCodeOutcome> =>
        Promise.resolve(Object.freeze({ kind: "not-configured" })),
    });
  }
  return Object.freeze({
    enabled: true,
    provider: port.provider(),
    modelId: port.modelId(),
    explainCode: async (input: ExplainCodeInput, keyId?: string | undefined): Promise<ExplainCodeOutcome> => {
      const cacheKey =
        `explain-code|${port.provider()}|${port.modelId()}|${input.codeHash}|${input.selector.toLowerCase()}|${input.view}|${input.promptVersion}`;
      if (budget !== undefined && keyId !== undefined) {
        const hit = budget.lookup<ExplainCodeOutcome>(cacheKey);
        if (hit !== null) {
          return hit;
        }
        if (!budget.trySpend(keyId)) {
          return Object.freeze({ kind: "capped" });
        }
      }
      const outcome = await port.explainCode(input);
      if (outcome.kind === "not-configured") {
        return Object.freeze({ kind: "not-configured" });
      }
      const summary = validSummary(outcome);
      const notes = validNotes(outcome);
      if (summary === null || notes === null) {
        return Object.freeze({ kind: "invalid-output" });
      }
      const validLines = new Set(input.lines.map((line) => line.lineNumber));
      const checked = checkExplainCodeCitations(summary, notes, validLines, new Set(input.evidenceIds));
      const final: ExplainCodeOutcome = Object.freeze({
        kind: "ok",
        summary: checked.summary,
        notes: checked.notes,
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

export function serializeExplainCodeOutcome(outcome: ExplainCodeOutcome): string {
  if (outcome.kind === "ok") {
    return JSON.stringify({
      kind: "ok",
      droppedClaims: outcome.droppedClaims,
      modelId: outcome.modelId,
      notes: outcome.notes,
      summary: outcome.summary,
      provider: outcome.provider,
    });
  }
  return JSON.stringify({ kind: outcome.kind });
}
