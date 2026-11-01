// Unit test for the decompiler view model (UI v2 §5.4 W-6):
// ordering, summary, filter, status mapping and the plain sentence.
// Behavior only: parsed rows, ordered selectors and rendered strings.
import { describe, expect, test } from "vitest";
import {
  annotationChipText,
  decompilerCountLine,
  decompilerFunctionSentence,
  decompilerStatusOf,
  decompilerSummaryLine,
  filterDecompilerFunctions,
  parseDecompilerFunction,
  parseDecompilerFunctions,
  sortDecompilerFunctions,
  summarizeDecompilerFunctions,
} from "./decompilerView.ts";

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    selector: "0x0ecb93c0",
    name: "addBlackList",
    signature: "addBlackList(address)",
    entryPc: 411,
    startPc: 411,
    endPc: 3057,
    annotations: ["token-pattern: guarded-state-update"],
    cause: "unexpected-control-flow",
    unresolvedJumps: 55,
    ...overrides,
  };
}

describe("decompiler status", () => {
  test("unexpected-control-flow maps to partly read", () => {
    expect(decompilerStatusOf("unexpected-control-flow")).toBe("partly-read");
    expect(parseDecompilerFunction(payload())?.status).toBe("partly-read");
  });

  test("a null cause reads as complete and any recorded cause as partly read", () => {
    expect(decompilerStatusOf(null)).toBe("complete");
    expect(decompilerStatusOf("no-plain-return")).toBe("partly-read");
    expect(decompilerStatusOf("unexpected-control-flow")).toBe("partly-read");
    expect(decompilerStatusOf("decompiler-error")).toBe("partly-read");
    expect(parseDecompilerFunction(payload({ cause: "no-plain-return" }))?.status).toBe("partly-read");
  });

  test("payloads without a valid selector are dropped", () => {
    expect(parseDecompilerFunction({ name: "nope" })).toBeNull();
    expect(parseDecompilerFunction(payload({ selector: "0x123" }))).toBeNull();
    expect(parseDecompilerFunctions([payload(), { name: "nope" }])).toHaveLength(1);
  });
});

describe("decompiler names", () => {
  test("the signature wins, then the short name, then Unnamed", () => {
    expect(parseDecompilerFunction(payload())?.displayName).toBe("addBlackList(address)");
    expect(parseDecompilerFunction(payload({ signature: "" }))?.displayName).toBe("addBlackList");
    expect(parseDecompilerFunction(payload({ signature: "", name: "function_0753c30c" }))?.displayName).toBe(
      "Unnamed 0x0ecb93c0",
    );
  });

  test("only non-empty signatures count as named", () => {
    expect(parseDecompilerFunction(payload())?.named).toBe(true);
    expect(parseDecompilerFunction(payload({ signature: "" }))?.named).toBe(false);
  });
});

describe("decompiler ordering", () => {
  test("guarded-state-update rows come first, then named, then unnamed", () => {
    const unnamed = payload({
      selector: "0x11111111",
      name: "function_11111111",
      signature: "",
      annotations: [],
      cause: null,
    });
    const namedPlain = payload({
      selector: "0x22222222",
      name: "pause",
      signature: "pause()",
      annotations: [],
      cause: null,
    });
    const guarded = payload({ selector: "0x33333333" });
    const ordered = sortDecompilerFunctions(parseDecompilerFunctions([unnamed, namedPlain, guarded]));
    expect(ordered.map((fn) => fn.selector)).toEqual(["0x33333333", "0x22222222", "0x11111111"]);
  });

  test("named rows sort by selector", () => {
    const second = payload({ selector: "0xbbbbbbbb", name: "b", signature: "b()", annotations: [] });
    const first = payload({ selector: "0xaaaaaaaa", name: "a", signature: "a()", annotations: [] });
    const ordered = sortDecompilerFunctions(parseDecompilerFunctions([second, first]));
    expect(ordered.map((fn) => fn.selector)).toEqual(["0xaaaaaaaa", "0xbbbbbbbb"]);
  });
});

describe("decompiler summary", () => {
  test("the jump total is the contract max, never the row sum", () => {
    const functions = parseDecompilerFunctions([
      payload({ selector: "0xaaaaaaaa" }),
      payload({ selector: "0xbbbbbbbb" }),
    ]);
    const summary = summarizeDecompilerFunctions(functions);
    expect(summary).toEqual({ total: 2, named: 2, partlyRead: 2, jumps: 55 });
    expect(decompilerSummaryLine(summary)).toBe("2 functions · 2 named · 2 partly read (55 jumps not followed)");
  });

  test("a fully read list says so with no jump count", () => {
    const functions = parseDecompilerFunctions([
      payload({ selector: "0xaaaaaaaa", cause: null, unresolvedJumps: 0 }),
    ]);
    const summary = summarizeDecompilerFunctions(functions);
    expect(decompilerSummaryLine(summary)).toBe("1 function · 1 named · fully read");
  });
});

describe("decompiler sentence", () => {
  test("bytes are endPc minus startPc with no raw cause", () => {
    const fn = parseDecompilerFunction(payload()) as NonNullable<ReturnType<typeof parseDecompilerFunction>>;
    expect(decompilerFunctionSentence(fn)).toBe(
      "Starts at 0x19b · 2 646 bytes · partly read: 55 jumps were not followed.",
    );
    expect(decompilerFunctionSentence(fn)).not.toContain("unexpected-control-flow");
  });

  test("no-plain-return reads as partly read with no plain return value", () => {
    const fn = parseDecompilerFunction(
      payload({ cause: "no-plain-return", unresolvedJumps: 0 }),
    ) as NonNullable<ReturnType<typeof parseDecompilerFunction>>;
    expect(fn.status).toBe("partly-read");
    expect(decompilerFunctionSentence(fn)).toBe("Starts at 0x19b · 2 646 bytes · partly read: no plain return value.");
    expect(decompilerFunctionSentence(fn)).not.toContain("no-plain-return");
  });
});

describe("decompiler filter", () => {
  test("text matches name, signature or selector with a live count", () => {
    const functions = parseDecompilerFunctions([
      payload({ selector: "0xaaaaaaaa", name: "pause", signature: "pause()" }),
      payload({ selector: "0xbbbbbbbb", name: "mint", signature: "mint(address)" }),
    ]);
    expect(filterDecompilerFunctions(functions, "pause", "all")).toHaveLength(1);
    expect(filterDecompilerFunctions(functions, "mint(address)", "all")).toHaveLength(1);
    expect(filterDecompilerFunctions(functions, "0xbbbb", "all")).toHaveLength(1);
    expect(decompilerCountLine(1, 2)).toBe("1 of 2");
  });

  test("the segmented control narrows to owner-only or named rows", () => {
    const functions = parseDecompilerFunctions([
      payload({ selector: "0xaaaaaaaa" }),
      payload({ selector: "0xbbbbbbbb", annotations: [], signature: "", name: "function_bbbbbbbb" }),
    ]);
    expect(filterDecompilerFunctions(functions, "", "owner-only")).toHaveLength(1);
    expect(filterDecompilerFunctions(functions, "", "named")).toHaveLength(1);
    expect(filterDecompilerFunctions(functions, "", "all")).toHaveLength(2);
  });
});

describe("annotation chips", () => {
  test("guarded-state-update has its own tag and never becomes a chip", () => {
    expect(annotationChipText("token-pattern: guarded-state-update")).toBeNull();
  });

  test("unknown annotations render in sentence case", () => {
    expect(annotationChipText("token-pattern: some-new-flag")).toBe("Token pattern: some new flag");
    expect(annotationChipText("  ")).toBeNull();
  });
});
