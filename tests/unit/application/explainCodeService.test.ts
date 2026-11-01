// Explain-code service checks (VS-B3): summary and line-anchored notes
// survive only with valid line and evidence citations; unknown lines,
// unknown evidence, uncited entries and meta-statements drop with a count.
// Malformed model output discards the whole overlay as `invalid-output`.
// The budget cache key hashes the full input, so re-opening a function
// costs zero provider calls while changed lines or files miss.
import { describe, expect, test } from "vitest";
import {
  checkExplainCodeCitations,
  createExplainCodeService,
  serializeExplainCodeOutcome,
} from "../../../src/application/explainCodeService.ts";
import { OverlayBudget } from "../../../src/application/overlayBudget.ts";
import { ExplainCodeInput } from "../../../src/ports/explainCodeModel.ts";
import { FakeExplainCodeModelAdapter } from "../../fakes/fakeExplainCodeModel.ts";

function testLines(): { readonly lineNumber: number; readonly text: string }[] {
  return [
    { lineNumber: 1, text: "function move(address to) {" },
    { lineNumber: 2, text: "balances[to] += 1;" },
    { lineNumber: 3, text: "}" },
  ];
}

function testInput(): NonNullable<ReturnType<typeof ExplainCodeInput.create>> {
  const created = ExplainCodeInput.create({
    codeHash: "code-hash-for-unit-suite",
    selector: "0xa9059cbb",
    view: "decompiled",
    promptVersion: "explain-code-1",
    lines: testLines(),
    evidenceIds: ["signal:first"],
  });
  if (created === null) {
    throw new Error("expected valid explain-code input");
  }
  return created;
}

describe("explain-code citation check", () => {
  test("keeps cited lines and drops unknown lines, evidence and meta-statements", () => {
    const checked = checkExplainCodeCitations(
      [
        { text: "This function moves tokens.", cites: ["line:2", "signal:first"] },
        { text: "An uncited summary states intent.", cites: [] },
        { text: "Grounded in the frozen evidence list.", cites: ["line:1"] },
      ],
      [
        { lines: [2], text: "The transfer happens here.", cites: ["line:2"] },
        { lines: [9999], text: "A note cites a line that is not there.", cites: ["line:9999"] },
        { lines: [1], text: "A note cites uncollected evidence.", cites: ["signal:no-such-signal"] },
        { lines: [], text: "A note with no lines.", cites: ["line:1"] },
      ],
      new Set([1, 2, 3]),
      new Set(["signal:first"]),
    );
    expect(checked.summary).toEqual(["This function moves tokens."]);
    expect(checked.notes).toEqual([{ lines: [2], text: "The transfer happens here." }]);
    expect(checked.droppedClaims).toBe(5);
  });

  test("rejects malformed shapes at the input boundary", () => {
    expect(
      ExplainCodeInput.create({
        codeHash: "",
        selector: "0xa9059cbb",
        view: "decompiled",
        promptVersion: "explain-code-1",
        lines: testLines(),
        evidenceIds: ["signal:first"],
      }),
    ).toBeNull();
    expect(
      ExplainCodeInput.create({
        codeHash: "hash",
        selector: "0x123",
        view: "decompiled",
        promptVersion: "explain-code-1",
        lines: testLines(),
        evidenceIds: ["signal:first"],
      }),
    ).toBeNull();
    expect(
      ExplainCodeInput.create({
        codeHash: "hash",
        selector: "0xa9059cbb",
        view: "sideways" as unknown as "decompiled",
        promptVersion: "explain-code-1",
        lines: testLines(),
        evidenceIds: ["signal:first"],
      }),
    ).toBeNull();
    expect(
      ExplainCodeInput.create({
        codeHash: "hash",
        selector: "0xa9059cbb",
        view: "decompiled",
        promptVersion: "explain-code-1",
        lines: [],
        evidenceIds: ["signal:first"],
      }),
    ).toBeNull();
  });
});

describe("explain-code service", () => {
  test("a null port answers not-configured with zero calls", async () => {
    const service = createExplainCodeService(null);
    expect(service.enabled).toBe(false);
    expect(await service.explainCode(testInput())).toEqual({ kind: "not-configured" });
  });

  test("malformed model output falls back to invalid-output, never a throw", async () => {
    const fake = new FakeExplainCodeModelAdapter("invalid-output");
    const service = createExplainCodeService(fake);
    expect(await service.explainCode(testInput())).toEqual({ kind: "invalid-output" });
  });

  test("mixed output keeps only valid entries and counts the dropped ones", async () => {
    const fake = new FakeExplainCodeModelAdapter("mixed");
    const service = createExplainCodeService(fake);
    const outcome = await service.explainCode(testInput());
    expect(fake.calls.length).toBe(1);
    if (outcome.kind !== "ok") {
      throw new Error(`expected ok, got ${outcome.kind}`);
    }
    expect(fake.calls[0]?.evidenceIds).toEqual(["signal:first"]);
    expect(outcome.summary).toEqual(["This function moves tokens."]);
    expect(outcome.notes).toEqual([{ lines: [2], text: "The transfer happens here." }]);
    expect(outcome.droppedClaims).toBe(4);
    expect(outcome.provider).toBe("test-adapter");
    expect(JSON.parse(serializeExplainCodeOutcome(outcome))).toMatchObject({
      kind: "ok",
      summary: ["This function moves tokens."],
      droppedClaims: 4,
    });
  });

  test("the cache keys on code hash, selector, view and prompt version", async () => {
    const fake = new FakeExplainCodeModelAdapter("ok");
    const budget = new OverlayBudget({ dailyCapPerKey: 100, today: () => "2026-11-01" });
    const service = createExplainCodeService(fake, budget);
    const first = await service.explainCode(testInput(), "key-1");
    const second = await service.explainCode(testInput(), "key-1");
    expect(fake.calls.length).toBe(1);
    expect(second).toBe(first);
    const sourceView = ExplainCodeInput.create({
      codeHash: "code-hash-for-unit-suite",
      selector: "0xa9059cbb",
      view: "source",
      promptVersion: "explain-code-1",
      lines: testLines(),
      evidenceIds: ["signal:first"],
    });
    if (sourceView === null) {
      throw new Error("expected valid source input");
    }
    await service.explainCode(sourceView, "key-1");
    expect(fake.calls.length).toBe(2);
  });

  test("c20_explain_code_key_includes_lines_and_file", async () => {
    // The key hashes the full input: different lines or a different file
    // miss even when code hash, selector, view and prompt version match.
    const fake = new FakeExplainCodeModelAdapter("ok");
    const budget = new OverlayBudget({ dailyCapPerKey: 100, today: () => "2026-11-01" });
    const service = createExplainCodeService(fake, budget);
    await service.explainCode(testInput(), "key-1");
    const relined = ExplainCodeInput.create({
      codeHash: "code-hash-for-unit-suite",
      selector: "0xa9059cbb",
      view: "decompiled",
      promptVersion: "explain-code-1",
      lines: [
        { lineNumber: 1, text: "function move(address to) {" },
        { lineNumber: 2, text: "balances[to] += 2;" },
        { lineNumber: 3, text: "}" },
      ],
      evidenceIds: ["signal:first"],
    });
    if (relined === null) {
      throw new Error("expected valid explain-code input");
    }
    await service.explainCode(relined, "key-1");
    expect(fake.calls.length).toBe(2);
    const withFile = ExplainCodeInput.create({
      codeHash: "code-hash-for-unit-suite",
      selector: "0xa9059cbb",
      view: "source",
      promptVersion: "explain-code-1",
      lines: testLines(),
      file: "contracts/Token.sol",
      evidenceIds: ["signal:first"],
    });
    if (withFile === null) {
      throw new Error("expected valid explain-code input");
    }
    await service.explainCode(withFile, "key-1");
    expect(fake.calls.length).toBe(3);
    await service.explainCode(withFile, "key-1");
    expect(fake.calls.length).toBe(3);
  });

  test("a capped key answers capped with zero provider calls", async () => {
    const fake = new FakeExplainCodeModelAdapter("ok");
    const budget = new OverlayBudget({ dailyCapPerKey: 1, today: () => "2026-11-01" });
    const service = createExplainCodeService(fake, budget);
    expect((await service.explainCode(testInput(), "key-9")).kind).toBe("ok");
    // A cache miss on the capped key spends nothing: a new prompt version
    // answers capped with zero provider calls, while the cached input
    // still serves.
    const recut = ExplainCodeInput.create({
      codeHash: "code-hash-for-unit-suite",
      selector: "0xa9059cbb",
      view: "decompiled",
      promptVersion: "explain-code-2",
      lines: testLines(),
      evidenceIds: ["signal:first"],
    });
    if (recut === null) {
      throw new Error("expected valid explain-code input");
    }
    expect(await service.explainCode(recut, "key-9")).toEqual({ kind: "capped" });
    expect(await service.explainCode(testInput(), "key-9")).toEqual(await service.explainCode(testInput(), "key-9"));
    expect(fake.calls.length).toBe(1);
  });
});
