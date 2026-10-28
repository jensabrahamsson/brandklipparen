// Shared contract suite for PluginAuditModelPort (S-054, K-516, P-14).
// The fake runs it here; the hosted adapter runs the same suite over a
// recorded transport with zero network. Equal outcomes across adapters
// keep the fake honest. The suite also proves the advisory shape: closed
// finding enums, identity match, and no approval state in any response.
import { describe, expect, test } from "vitest";
import { PromptVersion, RequestId, Timestamp } from "../../src/domain/types.ts";
import { PluginAuditInput } from "../../src/ports/pluginAuditModel.ts";
import type {
  PluginAuditCallContext,
  PluginAuditInput as PluginAuditInputType,
  PluginAuditModelError,
  PluginAuditModelPort,
} from "../../src/ports/pluginAuditModel.ts";
import type { Result } from "../../src/domain/result.ts";

export type PluginAuditContractScenario =
  | "clean"
  | "findings"
  | "timeout"
  | "rate-limited"
  | "invalid-output"
  | "output-too-large"
  | "unavailable"
  | "provider-mismatch";

const ERROR_SCENARIOS: ReadonlyArray<{
  readonly scenario: PluginAuditContractScenario;
  readonly kind: PluginAuditModelError["kind"];
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

function fixedInput(): PluginAuditInputType {
  return mustOk(
    PluginAuditInput.create({
      pluginId: "dev.brandklipparen.capability",
      pluginVersion: "1.0.0",
      files: [
        { path: "index.ts", sha256: "abc123", quotedContent: "Quoted detector source for tests only." },
        { path: "PLUGIN.md", sha256: "def456", quotedContent: "Quoted plugin docs for tests only." },
      ],
      promptVersion: mustOk(PromptVersion.parse("1.0.0")),
    }),
  );
}

function fixedContext(): PluginAuditCallContext {
  return {
    requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(1761446400000)),
    block: "latest",
  };
}

const CLOSED_SEVERITIES = ["info", "low", "medium", "high"];
const CLOSED_CATEGORIES = [
  "forbidden-capability",
  "injection-surface",
  "determinism",
  "evidence-integrity",
  "docs-drift",
  "other",
];

export function runPluginAuditModelPortContract(
  label: string,
  makeAdapter: (scenario: PluginAuditContractScenario) => PluginAuditModelPort,
): void {
  describe(`PluginAuditModelPort contract: ${label}`, () => {
    test("clean review carries no findings and leaves the input unchanged", async () => {
      const adapter = makeAdapter("clean");
      const input = fixedInput();
      const before = JSON.stringify(input);
      const result = await adapter.review(input, fixedContext());
      expect(JSON.stringify(input)).toBe(before);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.findings).toEqual([]);
      expect(result.value.pluginId).toBe(input.pluginId);
    });

    test("findings review uses closed enums with quoted evidence only", async () => {
      const adapter = makeAdapter("findings");
      const result = await adapter.review(fixedInput(), fixedContext());
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.findings.length).toBeGreaterThan(0);
      for (const finding of result.value.findings) {
        expect(CLOSED_SEVERITIES).toContain(finding.severity);
        expect(CLOSED_CATEGORIES).toContain(finding.category);
        expect(finding.rationale.length).toBeGreaterThan(0);
        expect(finding.quotedEvidence.length).toBeGreaterThan(0);
        expect(finding.confidence).toBeGreaterThanOrEqual(0);
        expect(finding.confidence).toBeLessThanOrEqual(1);
      }
    });

    test("adapter labels the open-weights provider and model id", () => {
      const adapter = makeAdapter("clean");
      expect(adapter.provider()).toBe("hosted-open-weights");
      expect(String(adapter.modelId())).toBe("meta-models/muse-spark-open-1026");
    });

    test("report carries no approval state", async () => {
      const adapter = makeAdapter("findings");
      const result = await adapter.review(fixedInput(), fixedContext());
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const keys = Object.keys(result.value).sort();
      expect(keys).toEqual(["findings", "modelId", "pluginId", "pluginVersion", "promptVersion", "provider"]);
    });

    for (const { scenario, kind } of ERROR_SCENARIOS) {
      test(`scenario ${scenario} reports ${kind} with no findings shown`, async () => {
        const adapter = makeAdapter(scenario);
        const result = await adapter.review(fixedInput(), fixedContext());
        expect(result.ok).toBe(false);
        if (result.ok) {
          return;
        }
        expect(result.error.kind).toBe(kind);
      });
    }
  });
}
