// Explain-code model port (VS-B3). Optional AI layer that explains one
// decompiled or verified-source function over frozen code lines. The input
// is a closed frozen value (code hash, selector, view, the function's own
// numbered lines for that view, the collected evidence ids for the
// selector with their meanings, prompt version) and the output is a short
// summary plus line-anchored notes. Line cites use the `line:N` form where
// N is a 1-based line number in the sent view; evidence cites name
// collected evidence ids. The notes are a labelled overlay only: they
// never enter the score, the evidence or the finding text. A null port
// (the default wiring) answers `not-configured` with zero provider calls
// and the deterministic code view stands.
import type { FindingMeaning as FindingMeaningType } from "../domain/modelMeanings.ts";

export const EXPLAIN_CODE_VIEWS = ["decompiled", "source"] as const;

export type ExplainCodeView = (typeof EXPLAIN_CODE_VIEWS)[number];

export type ExplainCodeLine = {
  readonly lineNumber: number;
  readonly text: string;
};

export type ExplainCodeCite = string;

export type ExplainCodeSummarySentence = {
  readonly text: string;
  readonly cites: readonly ExplainCodeCite[];
};

export type ExplainCodeNote = {
  // Line numbers in the sent view, in ascending order: snippet-relative
  // (from 1) for the decompiled view, absolute file numbers for source.
  readonly lines: readonly number[];
  readonly text: string;
  readonly cites: readonly ExplainCodeCite[];
};

export type ExplainCodeInput = {
  readonly codeHash: string;
  readonly selector: string;
  readonly view: ExplainCodeView;
  readonly promptVersion: string;
  // The function's own lines in the requested view (decompiled lines carry
  // the snippet text numbered from 1; source lines carry the verified
  // range text under absolute file numbers).
  readonly lines: readonly ExplainCodeLine[];
  // Verified file path for the source view; absent for decompiled.
  readonly file?: string | undefined;
  readonly evidenceIds: readonly string[];
  readonly meanings?: readonly FindingMeaningType[] | undefined;
};

export const ExplainCodeInput = {
  create(input: {
    readonly codeHash: string;
    readonly selector: string;
    readonly view: ExplainCodeView;
    readonly promptVersion: string;
    readonly lines: readonly ExplainCodeLine[];
    readonly file?: string | undefined;
    readonly evidenceIds: readonly string[];
    readonly meanings?: readonly FindingMeaningType[] | undefined;
  }): ExplainCodeInput | null {
    if (input.codeHash.length === 0 || input.promptVersion.length === 0) {
      return null;
    }
    if (!/^0x[0-9a-fA-F]{8}$/.test(input.selector)) {
      return null;
    }
    if (input.view !== "decompiled" && input.view !== "source") {
      return null;
    }
    if (input.lines.length === 0 || input.lines.length > 512) {
      return null;
    }
    let previous: number | null = null;
    for (const line of input.lines) {
      if (!Number.isInteger(line.lineNumber) || line.lineNumber < 1) {
        return null;
      }
      if (previous !== null && line.lineNumber !== previous + 1) {
        return null;
      }
      previous = line.lineNumber;
      if (typeof line.text !== "string" || line.text.length > 4096) {
        return null;
      }
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
      selector: input.selector,
      view: input.view,
      promptVersion: input.promptVersion,
      lines: Object.freeze(input.lines.slice()),
      ...(input.file === undefined ? {} : { file: input.file }),
      evidenceIds: Object.freeze(input.evidenceIds.slice()),
      ...(input.meanings === undefined ? {} : { meanings: Object.freeze(input.meanings.slice()) }),
    });
  },
};

export type ExplainCodeModelOutcome =
  | {
      readonly kind: "ok";
      readonly summary: readonly ExplainCodeSummarySentence[];
      readonly notes: readonly ExplainCodeNote[];
    }
  | { readonly kind: "not-configured" }
  | { readonly kind: "invalid-output" };

export type ExplainCodeModelPort = {
  explainCode(input: ExplainCodeInput): Promise<ExplainCodeModelOutcome>;
  provider(): string;
  modelId(): string;
};
