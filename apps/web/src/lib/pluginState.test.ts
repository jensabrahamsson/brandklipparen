import { describe, expect, test } from "vitest";
import { pluginState, proofHeadline } from "./pluginState.ts";
import type { CantTellContext } from "./pluginState.ts";

const QUIET: CantTellContext = { hardToAnalyzeFired: false, partialTransfer: false };

function scoredView(payload: unknown): { outcome: string; findings: { payload?: unknown }[] } {
  return { outcome: "ok", findings: [{ payload }] };
}

describe("plugin board states (UI v2 §5.1)", () => {
  test("error outcomes name the failure", () => {
    for (const outcome of ["threw", "invalid-output", "timeout"]) {
      expect(pluginState({ outcome, findings: [] }, QUIET)).toBe("error");
    }
  });

  test("input-unavailable and missing results are not run", () => {
    expect(pluginState({ outcome: "input-unavailable", findings: [] }, QUIET)).toBe("not-run");
    expect(pluginState(undefined, QUIET)).toBe("not-run");
  });

  test("scored findings read found", () => {
    expect(pluginState(scoredView({ feature: "blacklist" }), QUIET)).toBe("found-scored");
    expect(pluginState(scoredView({ capability: "call" }), QUIET)).toBe("found-scored");
    expect(pluginState(scoredView({ similarity: 0.9, group: "drain-template" }), QUIET)).toBe(
      "found-scored",
    );
    expect(pluginState(scoredView({ selector: "0x70a08231", cause: null }), QUIET)).toBe(
      "found-scored",
    );
  });

  test("extended facts read found but not in score", () => {
    expect(
      pluginState(scoredView({ fact: "pause", slot: 3, mode: "pause", proof: "extended" }), QUIET),
    ).toBe("extended");
  });

  test("a scored finding wins over an extended one", () => {
    expect(
      pluginState(
        {
          outcome: "ok",
          findings: [{ payload: { feature: "mint", slot: 1 } }, { payload: { fact: "mint", proof: "extended" } }],
        },
        QUIET,
      ),
    ).toBe("found-scored");
  });

  test("no finding with a hard read reads can't tell", () => {
    expect(
      pluginState(
        { outcome: "ok", findings: [] },
        { hardToAnalyzeFired: true, partialTransfer: false },
      ),
    ).toBe("cant-tell");
    expect(
      pluginState(
        { outcome: "ok", findings: [] },
        { hardToAnalyzeFired: false, partialTransfer: true },
      ),
    ).toBe("cant-tell");
  });

  test("no finding with a clean read reads not found", () => {
    expect(pluginState({ outcome: "ok", findings: [] }, QUIET)).toBe("not-found");
  });

  test("junk payloads with findings are not found, not scored", () => {
    expect(pluginState(scoredView({ note: "heavy" }), QUIET)).toBe("not-found");
  });
});

describe("proof headline (UI v2 §5.5)", () => {
  test("every step ok reads all steps proven", () => {
    expect(proofHeadline([{ ok: true }, { ok: true }])).toBe("All steps proven");
  });

  test("a failing transfer gate names the stopped step", () => {
    expect(
      proofHeadline([
        { ok: true },
        { ok: true },
        { ok: true },
        { ok: false },
        { ok: false },
        { ok: false },
        { ok: false },
      ]),
    ).toBe("We stopped at step 4 of 7");
  });

  test("an empty trace never names a step", () => {
    expect(proofHeadline([])).toBe("No proof steps reported.");
  });
});
