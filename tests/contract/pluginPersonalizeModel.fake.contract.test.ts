// Contract check for the fake personalize adapter (S-069, K-519,
// P-27). The fake runs the shared `runPluginPersonalizeModelPortContract`
// suite over recorded scenarios: equal outcomes across adapters keep the
// fake honest. No test reaches the network.
import { describe } from "vitest";
import { runPluginPersonalizeModelPortContract } from "./pluginPersonalizeModel.contract.ts";
import type { PluginPersonalizeContractScenario } from "./pluginPersonalizeModel.contract.ts";
import { FakePluginPersonalizeModelAdapter } from "../fakes/fakePluginPersonalizeModel.ts";

describe("fake personalize adapter", () => {
  runPluginPersonalizeModelPortContract("fake", (scenario: PluginPersonalizeContractScenario) => {
    return new FakePluginPersonalizeModelAdapter(scenario);
  });
});
