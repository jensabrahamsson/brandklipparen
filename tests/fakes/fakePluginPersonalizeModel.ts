// Fake PluginPersonalizeModelPort for tests (S-069, K-519, P-27). One
// adapter per scenario: the contract suite drives every error branch
// with zero network calls, and "ordered" returns one valid spec ranking
// the request's present plugin ids. Never touches the network, the
// clock or the filesystem.
import { err, ok } from "../../src/domain/result.ts";
import type { Result } from "../../src/domain/result.ts";
import { parsePersonalizeSpec } from "../../src/plugins/personalizeSpec.ts";
import type {
  PersonalizeInput,
  PersonalizeSpec,
  PluginPersonalizeCallContext,
  PluginPersonalizeModelError,
  PluginPersonalizeModelPort,
  PluginPersonalizeProvider,
} from "../../src/ports/pluginPersonalizeModel.ts";
import type { ModelId as ModelIdType } from "../../src/domain/types.ts";
import type { PluginPersonalizeContractScenario } from "../contract/pluginPersonalizeModel.contract.ts";

export class FakePluginPersonalizeModelAdapter implements PluginPersonalizeModelPort {
  private readonly scenario: PluginPersonalizeContractScenario;
  private calls = 0;

  constructor(scenario: PluginPersonalizeContractScenario) {
    this.scenario = scenario;
  }

  get callCount(): number {
    return this.calls;
  }

  provider(): PluginPersonalizeProvider {
    return "hosted-open-weights";
  }

  modelId(): ModelIdType {
    return "meta-models/muse-spark-open-1026" as ModelIdType;
  }

  async personalize(
    input: PersonalizeInput,
    _ctx: PluginPersonalizeCallContext,
  ): Promise<Result<PersonalizeSpec, PluginPersonalizeModelError>> {
    void _ctx;
    this.calls += 1;
    switch (this.scenario) {
      case "ordered": {
        const present = input.pluginIds;
        const ranking = present.slice().reverse();
        const offered = new Set(input.sectionIds);
        const scoreId = offered.has("score") ? "score" : "summary";
        const explanationId = offered.has("explanation") ? "explanation" : "evidence";
        const placements: { sectionId: string; emphasis: "high" | "normal" }[] = [];
        if (offered.has("signals")) {
          placements.push({ sectionId: "signals", emphasis: "high" });
        }
        placements.push({ sectionId: scoreId, emphasis: "normal" });
        placements.push({ sectionId: explanationId, emphasis: "normal" });
        const checked = parsePersonalizeSpec(
          {
            specVersion: 1,
            pluginRanking: ranking,
            placements,
          },
          {
            sectionIds: input.sectionIds,
            pluginIds: input.pluginIds,
            flooredSectionIds: input.flooredSectionIds,
            maxPlacements: 16,
            maxRanking: 16,
          },
        );
        if (!checked.ok) {
          return err({ kind: "invalid-output", message: checked.error.message });
        }
        return ok(checked.value);
      }
      case "timeout":
        return err({ kind: "timeout", message: "fake personalize timeout" });
      case "rate-limited":
        return err({ kind: "rate-limited", message: "fake personalize rate limit" });
      case "invalid-output":
        return err({ kind: "invalid-output", message: "fake personalize invalid output" });
      case "output-too-large":
        return err({ kind: "output-too-large", message: "fake personalize output too large", limitChars: 1000 });
      case "provider-mismatch":
        return err({ kind: "provider-mismatch", message: "fake personalize provider mismatch" });
      case "unavailable":
        return err({ kind: "unavailable", message: "fake personalize unavailable" });
    }
  }
}
