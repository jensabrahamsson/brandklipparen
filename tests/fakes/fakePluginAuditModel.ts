// Deterministic fake for PluginAuditModelPort (S-054, K-516, P-14).
// Test-only adapter with no network, no clock and no randomness: each
// scenario returns the same canned report for the same input. Reports are
// built through the same validation real adapters must repeat. The
// received input stays observable, so tests prove the audit sends exactly
// the listed plugin files (M-25) and carries injections as quoted data.
// Placeholder findings are test-only values, never learned model values.
import { err, ok } from "../../src/domain/result.ts";
import type { Result } from "../../src/domain/result.ts";
import { ModelId } from "../../src/domain/types.ts";
import type { ModelId as ModelIdType } from "../../src/domain/types.ts";
import type {
  PluginAuditFinding,
  PluginAuditInput,
  PluginAuditModelError,
  PluginAuditModelPort,
  PluginAuditProvider,
  PluginAuditReport,
} from "../../src/ports/pluginAuditModel.ts";
import type { PluginAuditContractScenario } from "../contract/pluginAuditModel.contract.ts";

export const PLUGIN_AUDIT_MODEL_ID = "meta-models/muse-spark-open-1026";

function mustModelId(raw: string): ModelIdType {
  const parsed = ModelId.parse(raw);
  if (!parsed.ok) {
    throw new Error(`fake plugin audit model id is invalid: ${parsed.error.message}`);
  }
  return parsed.value;
}

export class FakePluginAuditModelAdapter implements PluginAuditModelPort {
  private scenario: PluginAuditContractScenario;
  private calls = 0;
  private received: PluginAuditInput[] = [];

  constructor(scenario: PluginAuditContractScenario = "clean") {
    this.scenario = scenario;
  }

  setScenario(scenario: PluginAuditContractScenario): void {
    this.scenario = scenario;
  }

  get callCount(): number {
    return this.calls;
  }

  get receivedInputs(): readonly PluginAuditInput[] {
    return this.received;
  }

  reset(): void {
    this.calls = 0;
    this.received = [];
  }

  provider(): PluginAuditProvider {
    return "meta-model-api";
  }

  modelId(): ModelIdType {
    return mustModelId(PLUGIN_AUDIT_MODEL_ID);
  }

  async review(input: PluginAuditInput): Promise<Result<PluginAuditReport, PluginAuditModelError>> {
    this.calls += 1;
    this.received.push(input);
    switch (this.scenario) {
      case "clean":
        return ok(this.report(input, []));
      case "findings":
        return ok(
          this.report(input, [
            {
              severity: "medium",
              location: "PLUGIN.md:## What it detects",
              category: "docs-drift",
              rationale: "The docs claim a detection with no matching logic in the quoted source.",
              confidence: 0.6,
              quotedEvidence: input.files[1]?.quotedContent.slice(0, 200) ?? "Quoted docs excerpt for tests only.",
            },
          ]),
        );
      case "timeout":
        return err({ kind: "timeout", message: "fake audit provider timed out" });
      case "rate-limited":
        return err({ kind: "rate-limited", message: "fake audit provider rate limited" });
      case "invalid-output":
        return err({ kind: "invalid-output", message: "fake audit returned malformed output" });
      case "output-too-large":
        return err({ kind: "output-too-large", message: "fake audit output too large", limitChars: 4000 });
      case "unavailable":
        return err({ kind: "unavailable", message: "fake audit provider unavailable" });
      case "provider-mismatch":
        return err({ kind: "provider-mismatch", message: "fake audit provider mismatch" });
    }
  }

  private report(input: PluginAuditInput, findings: PluginAuditFinding[]): PluginAuditReport {
    return {
      pluginId: input.pluginId,
      pluginVersion: input.pluginVersion,
      promptVersion: input.promptVersion,
      provider: this.provider(),
      modelId: this.modelId(),
      findings: Object.freeze(findings.slice()),
    };
  }
}
