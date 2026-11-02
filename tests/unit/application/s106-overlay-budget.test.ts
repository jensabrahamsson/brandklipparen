// Overlay cost caps and cache (S-106, K-507): the second identical call
// within the cap costs zero provider calls through the exact-input cache,
// and a key past its daily cap is turned away with zero provider calls.
// Written first (red) per A-21: the services take no budget. No network;
// the fake explain adapter counts provider calls.
import { describe, expect, test } from "vitest";
import { createExplainService } from "../../../src/application/explainService.ts";
import { EXPLAIN_PROMPT_VERSION } from "../../../src/application/explainService.ts";
import { OverlayBudget, SharedAiGlobalBudget } from "../../../src/application/overlayBudget.ts";
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

  test("sec1_s8_global_daily_cap_caps_every_key_for_the_day", async () => {
    const fake = new FakeExplainModelAdapter("ok");
    let today = "2030-01-01";
    const budget = new OverlayBudget({
      dailyCapPerKey: 10,
      globalDailyCap: 1,
      today: () => today,
    });
    const service = createExplainService(fake, budget);
    const first = await service.explain(explainInput(), "key-1");
    expect(first.kind).toBe("ok");
    expect(fake.calls.length).toBe(1);
    // A different key with a fresh per-key cap is still capped globally,
    // with zero new provider calls (a distinct input, so no cache hit).
    const other = ExplainInput.create({
      codeHash: "ef".repeat(32),
      evidenceIds: ["signal:deadbeef"],
      promptVersion: EXPLAIN_PROMPT_VERSION,
    });
    if (other === null) throw new Error("fixture explain input must build");
    const capped = await service.explain(other, "key-2");
    expect(capped).toEqual({ kind: "capped" });
    expect(fake.calls.length).toBe(1);
    // The next day the global budget is fresh again.
    today = "2030-01-02";
    const nextDay = await service.explain(other, "key-2");
    expect(nextDay.kind).toBe("ok");
    expect(fake.calls.length).toBe(2);
  });

  test("shared global budget caps across two feature budgets", () => {
    const shared = new SharedAiGlobalBudget({ globalDailyCap: 1, today: () => "2030-01-01" });
    const explainBudget = new OverlayBudget({ dailyCapPerKey: 10, globalBudget: shared, today: () => "2030-01-01" });
    const chatBudget = new OverlayBudget({ dailyCapPerKey: 10, globalBudget: shared, today: () => "2030-01-01" });
    expect(explainBudget.trySpend("key-1")).toBe(true);
    expect(chatBudget.trySpend("key-2")).toBe(false);
    expect(shared.trySpend()).toBe(false);
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
