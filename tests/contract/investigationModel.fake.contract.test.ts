// Contract check for the fake investigation adapter (S-073, K-036, K-520).
import { describe, expect, test } from "vitest";
import { runInvestigationModelPortContract } from "./investigationModel.contract.ts";
import type { InvestigationContractScenario } from "./investigationModel.contract.ts";
import type { InvestigationModelPort } from "../../src/ports/investigationModel.ts";
import { FakeInvestigationModelAdapter } from "../fakes/fakeInvestigationModel.ts";

describe("fake investigation adapter", () => {
  runInvestigationModelPortContract("fake", (scenario: InvestigationContractScenario) => {
    return new FakeInvestigationModelAdapter(scenario);
  });

  test("k513_investigation_provider_mismatch_rejected", async () => {
    const { CodeHash, Bytecode, RequestId, Timestamp } = await import("../../src/domain/types.ts");
    const { InvestigationModelInput } = await import("../../src/ports/investigationModel.ts");
    const mustOk = <T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
      if (!result.ok) {
        throw new Error(`expected ok: ${result.error.message}`);
      }
      return result.value;
    };
    const code = mustOk(Bytecode.parse("0x6001600055"));
    const input = mustOk(
      InvestigationModelInput.create({
        codeHash: mustOk(CodeHash.of(code)),
        scoreBand: "High",
        signalIds: ["sig-1"],
        tools: [{ toolId: "evidence.list", description: "list", argNames: [] }],
        trace: [],
        budgets: { stepsLeft: 8, tokensLeft: 4000, deadlineMs: 30000 },
      }),
    );
    const adapter: InvestigationModelPort = new FakeInvestigationModelAdapter("provider-mismatch");
    const result = await adapter.decide(input, {
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1761446400000)),
      block: "latest",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.kind).toBe("provider-mismatch");
  });
});
