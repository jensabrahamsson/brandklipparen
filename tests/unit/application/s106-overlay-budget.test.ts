// Overlay cost caps and cache (S-106, K-507): the second identical call
// within the cap costs zero provider calls through the exact-input cache,
// and a key past its daily cap is turned away with zero provider calls.
// Written first (red) per A-21: the services take no budget. No network;
// the fake explain adapter counts provider calls.
import { describe, expect, test } from "vitest";
import { createExplainService } from "../../../src/application/explainService.ts";
import { EXPLAIN_PROMPT_VERSION } from "../../../src/application/explainService.ts";
import { OverlayBudget } from "../../../src/application/overlayBudget.ts";
import { FakeExplainModelAdapter } from "../../fakes/fakeExplainModel.ts";
import { ExplainInput } from "../../../src/ports/explainModel.ts";

const CODE_HASH = "cd".repeat(32);

function explainInput() {
  const built = ExplainInput.create({
    codeHash: CODE_HASH,
    evidenceIds: ["signal:deadbeef"],
    promptVersion: EXPLAIN_PROMPT_VERSION,
  });
  if (built === null) {
    throw new Error("fixture explain input must build");
  }
  return built;
}

describe("overlay cost caps and cache (S-106)", () => {
  test("s106_overlay_second_call_within_cap_spends_nothing", async () => {
    const fake = new FakeExplainModelAdapter("ok");
    const budget = new OverlayBudget({ dailyCapPerKey: 10, today: () => "2030-01-01" });
    const service = createExplainService(fake, budget);
    const first = await service.explain(explainInput(), "key-1");
    expect(first.kind).toBe("ok");
    expect(fake.calls.length).toBe(1);
    const second = await service.explain(explainInput(), "key-1");
    expect(second).toEqual(first);
    expect(fake.calls.length).toBe(1);
  });

  test("s106_overlay_capped_key_spends_nothing", async () => {
    const fake = new FakeExplainModelAdapter("ok");
    const budget = new OverlayBudget({ dailyCapPerKey: 0, today: () => "2030-01-01" });
    const service = createExplainService(fake, budget);
    const outcome = await service.explain(explainInput(), "key-1");
    expect(outcome).toEqual({ kind: "capped" });
    expect(fake.calls.length).toBe(0);
  });
});
