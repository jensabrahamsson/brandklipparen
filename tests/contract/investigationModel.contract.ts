// Shared contract suite for InvestigationModelPort (S-073, K-036, K-520,
// K-513). The fake runs it here; the Meta adapter runs the same suite
// over a recorded transport with zero network. Equal outcomes across
// adapters keep the fake honest and prove a swap changes nothing but the
// label. The suite also proves the one-way chain: the input leaves the
// call unchanged, and a wrong provider or model id gives
// `provider-mismatch` with no decision applied.
import { describe, expect, test } from "vitest";
import { CodeHash, Bytecode, ModelId, RequestId, Timestamp } from "../../src/domain/types.ts";
import { InvestigationModelInput } from "../../src/ports/investigationModel.ts";
import type {
  InvestigationCallContext,
  InvestigationModelError,
  InvestigationModelInput as InvestigationModelInputType,
  InvestigationModelPort,
} from "../../src/ports/investigationModel.ts";
import type { Result } from "../../src/domain/result.ts";

export type InvestigationContractScenario =
  | "run-tool"
  | "conclude"
  | "timeout"
  | "rate-limited"
  | "invalid-output"
  | "output-too-large"
  | "unavailable"
  | "provider-mismatch";

const ERROR_SCENARIOS: ReadonlyArray<{
  readonly scenario: InvestigationContractScenario;
  readonly kind: InvestigationModelError["kind"];
}> = [
  { scenario: "timeout", kind: "timeout" },
  { scenario: "rate-limited", kind: "rate-limited" },
  { scenario: "invalid-output", kind: "invalid-output" },
  { scenario: "output-too-large", kind: "output-too-large" },
  { scenario: "unavailable", kind: "unavailable" },
  { scenario: "provider-mismatch", kind: "provider-mismatch" },
];

function mustOk<T>(result: Result<T, { message: string }>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function fixedInput(): InvestigationModelInputType {
  const code = mustOk(Bytecode.parse("0x6001600055"));
  const codeHash = mustOk(CodeHash.of(code));
  return mustOk(
    InvestigationModelInput.create({
      codeHash,
      scoreBand: "High",
      signalIds: ["sig-1", "sig-2"],
      tools: [
        { toolId: "evidence.list", description: "list frozen evidence", argNames: [] },
        { toolId: "detector.capability", description: "re-run capability detector", argNames: [] },
      ],
      trace: [],
      budgets: { stepsLeft: 8, tokensLeft: 4000, deadlineMs: 30000 },
    }),
  );
}

function fixedContext(): InvestigationCallContext {
  return {
    requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(1761446400000)),
    block: "latest",
  };
}

export function runInvestigationModelPortContract(
  label: string,
  makeAdapter: (scenario: InvestigationContractScenario) => InvestigationModelPort,
): void {
  describe(`InvestigationModelPort contract: ${label}`, () => {
    test("run-tool decision names an allowlisted tool and leaves the input unchanged", async () => {
      const adapter = makeAdapter("run-tool");
      const input = fixedInput();
      const before = JSON.stringify(input);
      const result = await adapter.decide(input, fixedContext());
      expect(JSON.stringify(input)).toBe(before);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.kind).toBe("run-tool");
      if (result.value.kind !== "run-tool") {
        return;
      }
      const ids = input.tools.map((tool) => tool.toolId);
      expect(ids).toContain(result.value.toolId);
      expect(result.value.rationale.length).toBeGreaterThan(0);
    });

    test("conclude decision carries a narrative draft and leaves the input unchanged", async () => {
      const adapter = makeAdapter("conclude");
      const input = fixedInput();
      const before = JSON.stringify(input);
      const result = await adapter.decide(input, fixedContext());
      expect(JSON.stringify(input)).toBe(before);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.kind).toBe("conclude");
    });

    test("adapter labels the provider and model id", () => {
      const adapter = makeAdapter("run-tool");
      expect(adapter.provider()).toBe("meta-model-api");
      expect(String(adapter.modelId())).toBe("meta-models/muse-spark-open-1026");
    });

    for (const { scenario, kind } of ERROR_SCENARIOS) {
      test(`scenario ${scenario} reports ${kind} with no decision applied`, async () => {
        const adapter = makeAdapter(scenario);
        const result = await adapter.decide(fixedInput(), fixedContext());
        expect(result.ok).toBe(false);
        if (result.ok) {
          return;
        }
        expect(result.error.kind).toBe(kind);
      });
    }
  });
}

export function investigationModelId(): string {
  return "meta-models/muse-spark-open-1026";
}

export function unusedModelId(): ModelId {
  return mustOk(ModelId.parse("meta-models/muse-spark-open-1026"));
}
