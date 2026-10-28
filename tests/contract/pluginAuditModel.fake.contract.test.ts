// Contract check for the fake audit adapter (S-054, K-516).
import { describe } from "vitest";
import { runPluginAuditModelPortContract } from "./pluginAuditModel.contract.ts";
import type { PluginAuditContractScenario } from "./pluginAuditModel.contract.ts";
import { FakePluginAuditModelAdapter } from "../fakes/fakePluginAuditModel.ts";

describe("fake plugin audit adapter", () => {
  runPluginAuditModelPortContract("fake", (scenario: PluginAuditContractScenario) => {
    return new FakePluginAuditModelAdapter(scenario);
  });
});
