// Shared contract for the experimental PluginPersonalizeModelPort
// (S-069, K-519, P-27). Every adapter — the fake and the
// meta-model-api adapter, each over a recorded transport — gives equal
// outcomes: the "ordered"
// scenario returns the validated spec, every error scenario reports its
// typed branch with no spec shown, and the input stays frozen.
import { describe, expect, test } from "vitest";
import {
  Bytecode,
  CodeHash,
  PromptVersion,
  RequestId,
  Timestamp,
} from "../../src/domain/types.ts";
import { PersonalizeInput } from "../../src/ports/pluginPersonalizeModel.ts";
import type {
  PersonalizeInput as PersonalizeInputValue,
  PluginPersonalizeCallContext,
  PluginPersonalizeModelPort,
} from "../../src/ports/pluginPersonalizeModel.ts";
import type { Result } from "../../src/domain/result.ts";

export type PluginPersonalizeContractScenario =
  | "ordered"
  | "timeout"
  | "rate-limited"
  | "invalid-output"
  | "output-too-large"
  | "provider-mismatch"
  | "unavailable";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function fixedInput(): PersonalizeInputValue {
  const bytecode = mustOk(Bytecode.parse(`0x6080604052348015600f${"00".repeat(8)}`));
  return mustOk(
    PersonalizeInput.create({
      codeHash: mustOk(CodeHash.of(bytecode)),
      scoreBand: "medium",
      sectionIds: ["score", "explanation", "signals", "plugin-findings", "cant-tell"],
      pluginIds: ["dev.brandklipparen.capability", "dev.brandklipparen.clone-match"],
      flooredSectionIds: ["score", "explanation"],
      priorities: "Can the owner stop me selling?",
      plugins: [
        {
          pluginId: "dev.brandklipparen.capability",
          tags: ["owner-powers", "upgradeability"],
          severityMax: "high",
          quotedExcerpt: "Structural bytecode capabilities, one finding per capability key.",
        },
        {
          pluginId: "dev.brandklipparen.clone-match",
          tags: ["honeypot"],
          severityMax: "high",
          quotedExcerpt: "A known trap-template hit from the clone index.",
        },
      ],
      promptVersion: mustOk(PromptVersion.parse("1.0.0")),
    }),
  );
}

function fixedContext(): PluginPersonalizeCallContext {
  return {
    requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(1761446400000)),
    block: "latest",
  };
}

const ERROR_SCENARIOS: readonly { scenario: PluginPersonalizeContractScenario; kind: string }[] = [
  { scenario: "timeout", kind: "timeout" },
  { scenario: "rate-limited", kind: "rate-limited" },
  { scenario: "invalid-output", kind: "invalid-output" },
  { scenario: "output-too-large", kind: "output-too-large" },
  { scenario: "provider-mismatch", kind: "provider-mismatch" },
  { scenario: "unavailable", kind: "unavailable" },
] as const;

export function runPluginPersonalizeModelPortContract(
  label: string,
  makeAdapter: (scenario: PluginPersonalizeContractScenario) => PluginPersonalizeModelPort,
  expected: { readonly provider: string; readonly modelId: string } = {
    provider: "meta-model-api",
    modelId: "meta-models/muse-spark-open-1026",
  },
): void {
  describe(`PluginPersonalizeModelPort contract: ${label}`, () => {
    test("ordered mapping returns the validated spec and leaves the input unchanged", async () => {
      const adapter = makeAdapter("ordered");
      const input = fixedInput();
      const before = JSON.stringify(input);
      const result = await adapter.personalize(input, fixedContext());
      expect(JSON.stringify(input)).toBe(before);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.specVersion).toBe(1);
      for (const id of result.value.pluginRanking) {
        expect(input.pluginIds).toContain(id);
      }
      const sections = result.value.placements.map((placement) => placement.sectionId);
      expect(sections).toContain("score");
      expect(sections).toContain("explanation");
    });

    test("adapter labels the provider and model id", () => {
      const adapter = makeAdapter("ordered");
      expect(adapter.provider()).toBe(expected.provider);
      expect(String(adapter.modelId())).toBe(expected.modelId);
    });

    test("spec carries no free text, markup, code, urls or styles", async () => {
      const adapter = makeAdapter("ordered");
      const result = await adapter.personalize(fixedInput(), fixedContext());
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const text = JSON.stringify(result.value);
      expect(text).not.toContain("<");
      expect(text).not.toContain("http");
      expect(text).not.toContain("function");
    });

    for (const { scenario, kind } of ERROR_SCENARIOS) {
      test(`scenario ${scenario} reports ${kind} with no spec shown`, async () => {
        const adapter = makeAdapter(scenario);
        const result = await adapter.personalize(fixedInput(), fixedContext());
        expect(result.ok).toBe(false);
        if (result.ok) {
          return;
        }
        expect(result.error.kind).toBe(kind);
      });
    }
  });
}
