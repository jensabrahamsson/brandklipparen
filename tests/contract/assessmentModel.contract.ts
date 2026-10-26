// Shared contract suite for AssessmentModelPort (A-22, A-34, K-305, K-309).
// Real adapters run this same suite over a recorded transport in later
// stories; the fake runs it here. Equal outcomes across adapters keep the
// fake honest and prove a provider swap changes nothing but the label.
// The suite also proves the one-way chain: the request leaves the call
// unchanged, and the response carries no scores or evidence of its own.
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { Evidence } from "../../src/domain/evidence.ts";
import { EvidenceList } from "../../src/ports/assessmentModel.ts";
import type {
  AssessmentModelError,
  AssessmentModelPort,
  CallContext,
} from "../../src/ports/assessmentModel.ts";
import {
  Bytecode,
  CodeHash,
  ExplanationSchemaVersion,
  PcOffset,
  PromptVersion,
  RequestId,
  Selector,
  SignalId,
  Timestamp,
} from "../../src/domain/types.ts";
import type { Result } from "../../src/domain/result.ts";

export type AssessmentContractScenario =
  | "success"
  | "timeout"
  | "rate-limited"
  | "invalid-output"
  | "output-too-large"
  | "unavailable"
  | "provider-mismatch";

const ERROR_SCENARIOS: ReadonlyArray<{
  readonly scenario: AssessmentContractScenario;
  readonly kind: AssessmentModelError["kind"];
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

const FIXED_PROMPT = "1.0.0";

function fixedRequest(): EvidenceList {
  const code = mustOk(Bytecode.parse("0x6001600055"));
  const codeHash = mustOk(CodeHash.of(code));
  const first = mustOk(Selector.parse("0xa9059cbb"));
  const second = mustOk(Selector.parse("0x70a08231"));
  const offset = mustOk(PcOffset.of(0, code));
  const withOffset = mustOk(Evidence.create({ selector: first, offset }));
  const withoutOffset = mustOk(Evidence.create({ selector: second }));
  return mustOk(EvidenceList.create(codeHash, [withOffset, withoutOffset]));
}

function fixedPrompt(): PromptVersion {
  return mustOk(PromptVersion.parse(FIXED_PROMPT));
}

function fixedContext(): CallContext {
  return {
    requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(1761446400000)),
    block: "latest",
  };
}

function allowedSignalIds(request: EvidenceList): string[] {
  return request.evidence.map(
    (entry) => mustOk(SignalId.of(request.codeHash, entry.selector)) as string,
  );
}

export function runAssessmentModelPortContract(
  label: string,
  makeAdapter: (scenario: AssessmentContractScenario) => AssessmentModelPort,
): void {
  describe(`AssessmentModelPort contract: ${label}`, () => {
    test("success returns a labelled assessment and leaves the request unchanged", async () => {
      const adapter = makeAdapter("success");
      const request = fixedRequest();
      const before = JSON.stringify(request);
      const result = await adapter.assess(request, fixedPrompt(), fixedContext());
      expect(JSON.stringify(request)).toBe(before);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const value = result.value;
      expect(value.provider).toBe(adapter.provider());
      expect(value.modelId).toBe(adapter.modelId());
      expect(value.promptVersion).toBe(FIXED_PROMPT);
      expect(ExplanationSchemaVersion.parse(value.explanationVersion).ok).toBe(true);
      expect(typeof value.text).toBe("string");
      expect(value.text.length).toBeGreaterThan(0);
      expect(Object.keys(value).sort()).toEqual([
        "claims",
        "explanationVersion",
        "modelId",
        "promptVersion",
        "provider",
        "text",
      ]);
      expect(Array.isArray(value.claims)).toBe(true);
      const allowed = allowedSignalIds(request);
      for (const claim of value.claims) {
        expect(claim.text.length).toBeGreaterThan(0);
        expect(claim.signalLinks.length).toBeGreaterThan(0);
        for (const link of claim.signalLinks) {
          expect(allowed).toContain(link as string);
        }
      }
    });

    for (const { scenario, kind } of ERROR_SCENARIOS) {
      test(`scenario ${scenario} yields typed error ${kind} without mutating the request`, async () => {
        const adapter = makeAdapter(scenario);
        const request = fixedRequest();
        const before = JSON.stringify(request);
        const result = await adapter.assess(request, fixedPrompt(), fixedContext());
        expect(JSON.stringify(request)).toBe(before);
        expect(result.ok).toBe(false);
        if (result.ok) {
          return;
        }
        expect(result.error.kind).toBe(kind);
        expect(result.error.message.length).toBeGreaterThan(0);
      });
    }

    test("property: generated evidence lists pass through unchanged with linked claims", async () => {
      const bodies = ["6001600055", "6002600055", "6001600056", "60016000556001600055"];
      const selectorTexts = ["0xa9059cbb", "0x70a08231", "0x18160ddd", "0x095ea7b3"];
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            body: fc.constantFrom(...bodies),
            selectorTexts: fc.array(fc.constantFrom(...selectorTexts), {
              minLength: 1,
              maxLength: 4,
            }),
          }),
          async (draw) => {
            const code = mustOk(Bytecode.parse(`0x${draw.body}`));
            const codeHash = mustOk(CodeHash.of(code));
            const entries = draw.selectorTexts.map((text) =>
              mustOk(Evidence.create({ selector: mustOk(Selector.parse(text)) })),
            );
            const first = entries[0];
            if (first === undefined) {
              throw new Error("expected at least one evidence entry");
            }
            const request = mustOk(EvidenceList.create(codeHash, [first, ...entries.slice(1)]));
            const before = JSON.stringify(request);
            const adapter = makeAdapter("success");
            const result = await adapter.assess(request, fixedPrompt(), fixedContext());
            expect(JSON.stringify(request)).toBe(before);
            expect(result.ok).toBe(true);
            if (!result.ok) {
              return;
            }
            const allowed = allowedSignalIds(request);
            for (const claim of result.value.claims) {
              expect(claim.signalLinks.length).toBeGreaterThan(0);
              for (const link of claim.signalLinks) {
                expect(allowed).toContain(link as string);
              }
            }
          },
        ),
        { seed: 305001, numRuns: 50 },
      );
    });
  });
}
