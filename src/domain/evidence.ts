// Evidence with selector and PC offset (K-010, A-13).
// Pure domain module: construction validates and freezes, detection helpers
// sort canonically. Every evidence carries at least one selector in its
// type; the PC offset travels beside the selector in every case where the
// offset is derived from the bytecode. A decompiled snippet joins the entry
// after the deepening. No thresholds, weights or tables live here.
import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";
import type {
  DomainError,
  PcOffset as PcOffsetType,
  Selector as SelectorType,
} from "./types.ts";

// At least one entry; Signal.create turns away empty evidence arrays, so a
// signal that reaches the risk model always carries evidence.
export type NonEmpty<T> = readonly [T, ...T[]];

// Decompiled snippet linked to one selector (K-008 deepening, K-010).
// The text is quoted untrusted data at the boundary; the size cap is
// enforced by the deepening adapter under its port limits, so the core
// checks shape only: non-empty text and a non-negative integer line.
export type CodeSnippet = {
  readonly text: string;
  readonly line: number;
  readonly selector: SelectorType;
};

export const CodeSnippet = {
  create(input: {
    readonly text: string;
    readonly line: number;
    readonly selector: SelectorType;
  }): Result<CodeSnippet, DomainError> {
    if (input.text.length === 0) {
      return err({
        kind: "invalid-code-snippet",
        message: "code snippet text must be non-empty",
      });
    }
    if (!Number.isInteger(input.line) || input.line < 0) {
      return err({
        kind: "invalid-code-snippet",
        message: `code snippet line must be an integer at least 0: ${input.line}`,
      });
    }
    return ok(
      Object.freeze({
        text: input.text,
        line: input.line,
        selector: input.selector,
      }),
    );
  },
};

// One evidence entry: the selector is mandatory in the type, while offset
// and snippet stay optional. Callers pass an already validated PcOffset, so
// the constructor takes validity as given and only freezes.
export type Evidence = {
  readonly selector: SelectorType;
  readonly offset?: PcOffsetType;
  readonly snippet?: CodeSnippet;
};

export const Evidence = {
  create(input: {
    readonly selector: SelectorType;
    readonly offset?: PcOffsetType;
    readonly snippet?: CodeSnippet;
  }): Result<Evidence, DomainError> {
    if (input.offset === undefined && input.snippet === undefined) {
      return ok(Object.freeze({ selector: input.selector }));
    }
    if (input.offset === undefined) {
      return ok(
        Object.freeze({ selector: input.selector, snippet: input.snippet as CodeSnippet }),
      );
    }
    if (input.snippet === undefined) {
      return ok(Object.freeze({ selector: input.selector, offset: input.offset }));
    }
    return ok(
      Object.freeze({ selector: input.selector, offset: input.offset, snippet: input.snippet }),
    );
  },
};

// Canonical evidence order (A-32): selector first, then PC offset with
// entries lacking an offset sorting after entries carrying one. Returns a
// new frozen array and leaves the input untouched.
export function sortEvidence(items: readonly Evidence[]): readonly Evidence[] {
  const copy = items.slice();
  copy.sort((left, right) => {
    const leftSelector = left.selector as string;
    const rightSelector = right.selector as string;
    if (leftSelector < rightSelector) {
      return -1;
    }
    if (leftSelector > rightSelector) {
      return 1;
    }
    const leftOffset = left.offset as number | undefined;
    const rightOffset = right.offset as number | undefined;
    if (leftOffset === undefined && rightOffset === undefined) {
      return 0;
    }
    if (leftOffset === undefined) {
      return 1;
    }
    if (rightOffset === undefined) {
      return -1;
    }
    if (leftOffset < rightOffset) {
      return -1;
    }
    if (leftOffset > rightOffset) {
      return 1;
    }
    return 0;
  });
  return Object.freeze(copy);
}
