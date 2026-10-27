// Deterministic fake for InvestigationModelPort (S-073, K-036, K-520).
// Test-only adapter with no network, no clock and no randomness: each
// scenario returns the same canned decision for the same input. Decisions
// always name a tool from the input catalogue (run-tool) or carry a fixed
// draft citing the first trace evidence id (conclude), so the fake proves
// the validation the real adapter must repeat. Call count stays
// observable, so tests verify zero model calls without a key (P-29) and
// frozen-only input (P-30).
import { err, ok } from "../../src/domain/result.ts";
import type { Result } from "../../src/domain/result.ts";
import { ModelId } from "../../src/domain/types.ts";
import type { ModelId as ModelIdType } from "../../src/domain/types.ts";
import type {
  InvestigationDecision,
  InvestigationModelError,
  InvestigationModelInput,
  InvestigationModelPort,
  InvestigationProvider,
} from "../../src/ports/investigationModel.ts";
import type { InvestigationContractScenario } from "../contract/investigationModel.contract.ts";

export const INVESTIGATION_MODEL_ID = "meta-models/muse-spark-open-1026";

function mustModelId(raw: string): ModelIdType {
  const parsed = ModelId.parse(raw);
  if (!parsed.ok) {
    throw new Error(`fake investigation model id is invalid: ${parsed.error.message}`);
  }
  return parsed.value;
}

export class FakeInvestigationModelAdapter implements InvestigationModelPort {
  private scenario: InvestigationContractScenario;
  private calls = 0;

  constructor(scenario: InvestigationContractScenario = "run-tool") {
    this.scenario = scenario;
  }

  setScenario(scenario: InvestigationContractScenario): void {
    this.scenario = scenario;
  }

  get callCount(): number {
    return this.calls;
  }

  reset(): void {
    this.calls = 0;
  }

  provider(): InvestigationProvider {
    return "hosted-open-weights";
  }

  modelId(): ModelIdType {
    return mustModelId(INVESTIGATION_MODEL_ID);
  }

  async decide(
    input: InvestigationModelInput,
  ): Promise<Result<InvestigationDecision, InvestigationModelError>> {
    this.calls += 1;
    const firstTool = input.tools[0];
    switch (this.scenario) {
      case "run-tool": {
        if (firstTool === undefined) {
          return err({ kind: "invalid-output", message: "fake investigation saw an empty catalogue" });
        }
        return ok({
          kind: "run-tool",
          toolId: firstTool.toolId,
          args: {},
          rationale: "Fake rationale: inspect the frozen evidence first.",
        });
      }
      case "conclude": {
        const firstEvidence = input.trace[0]?.evidenceIds[0] ?? input.signalIds[0] ?? "sig-1";
        return ok({
          kind: "conclude",
          narrativeDraft: `The frozen evidence shows the finding. [E:${firstEvidence}]`,
        });
      }
      case "timeout":
        return err({ kind: "timeout", message: "fake investigation provider timed out" });
      case "rate-limited":
        return err({ kind: "rate-limited", message: "fake investigation provider rate limited" });
      case "invalid-output":
        return err({ kind: "invalid-output", message: "fake investigation returned malformed output" });
      case "output-too-large":
        return err({ kind: "output-too-large", message: "fake investigation output too large", limitChars: 4000 });
      case "unavailable":
        return err({ kind: "unavailable", message: "fake investigation provider unavailable" });
      case "provider-mismatch":
        return err({ kind: "provider-mismatch", message: "fake investigation provider mismatch" });
    }
  }
}
