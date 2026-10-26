// Strict assessment schema with template fallback (S-024, K-306, K-502).
// Written first per A-21: model output is untrusted, so validation rejects
// extra fields at every level, enforces the output size limit from the
// configuration with a placeholder default, and requires every claim to
// reference a signal id from the closed evidence list.
import { describe, expect, test } from "vitest";
import { Evidence } from "../../../src/domain/evidence.ts";
import {
  DEFAULT_ASSESSMENT_MAX_OUTPUT_CHARS,
  resolveAssessmentOutputLimit,
  validateAssessmentOutput,
} from "../../../src/adapters/assessment/validateAssessment.ts";
import type { AssessmentExpectation } from "../../../src/adapters/assessment/validateAssessment.ts";
import { EvidenceList } from "../../../src/ports/assessmentModel.ts";
import {
  Bytecode,
  CodeHash,
  ModelId,
  PromptVersion,
  Selector,
  SignalId,
} from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function fixedEvidence(): EvidenceList {
  const code = mustOk(Bytecode.parse("0x6001600055"));
  const codeHash = mustOk(CodeHash.of(code));
  const first = mustOk(Evidence.create({ selector: mustOk(Selector.parse("0xa9059cbb")) }));
  const second = mustOk(Evidence.create({ selector: mustOk(Selector.parse("0x70a08231")) }));
  return mustOk(EvidenceList.create(codeHash, [first, second]));
}

function fixedExpectation(maxOutputChars: number = DEFAULT_ASSESSMENT_MAX_OUTPUT_CHARS): AssessmentExpectation {
  return {
    provider: "meta-model-api",
    modelId: mustOk(ModelId.parse("fake-meta-spark-1")),
    promptVersion: mustOk(PromptVersion.parse("1.0.0")),
    maxOutputChars,
  };
}

function signalLinkOf(evidence: EvidenceList, index: number): string {
  const entry = evidence.evidence[index];
  if (entry === undefined) {
    throw new Error("expected an evidence entry");
  }
  return mustOk(SignalId.of(evidence.codeHash, entry.selector)) as string;
}

function validRaw(evidence: EvidenceList): Record<string, unknown> {
  return {
    provider: "meta-model-api",
    modelId: "fake-meta-spark-1",
    promptVersion: "1.0.0",
    explanationVersion: "1.0.0",
    text: "Placeholder assessment text for tests only.",
    claims: [
      {
        text: "Placeholder claim linked to the request evidence.",
        signalLinks: [signalLinkOf(evidence, 0)],
        temporality: {
          kind: "can-change",
          changer: "0x0102030405060708090a0b0c0d0e0f1011121314",
        },
      },
    ],
  };
}

describe("strict assessment schema with template fallback (K-306)", () => {
  test("k306_extra_top_level_fields_rejected", () => {
    const evidence = fixedEvidence();
    const raw = { ...validRaw(evidence), debugScore: 99 };
    const result = validateAssessmentOutput(raw, evidence, fixedExpectation());
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.kind).toBe("invalid-output");
  });

  test("k306_extra_claim_fields_rejected", () => {
    const evidence = fixedEvidence();
    const raw = validRaw(evidence);
    const claims = raw["claims"];
    if (!Array.isArray(claims)) {
      throw new Error("expected a claims array");
    }
    const first = claims[0];
    if (typeof first !== "object" || first === null) {
      throw new Error("expected a claim object");
    }
    const hostile = {
      ...(first as Record<string, unknown>),
      confidence: 0.99,
    };
    const hostileRaw = { ...raw, claims: [hostile] };
    const result = validateAssessmentOutput(hostileRaw, evidence, fixedExpectation());
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.kind).toBe("invalid-output");
  });

  test("k306_extra_temporality_fields_rejected", () => {
    const evidence = fixedEvidence();
    const raw = validRaw(evidence);
    const hostileRaw = {
      ...raw,
      claims: [
        {
          text: "Placeholder claim linked to the request evidence.",
          signalLinks: [signalLinkOf(evidence, 0)],
          temporality: {
            kind: "can-change",
            changer: "0x0102030405060708090a0b0c0d0e0f1011121314",
            note: "extra field must fail",
          },
        },
      ],
    };
    const result = validateAssessmentOutput(hostileRaw, evidence, fixedExpectation());
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.kind).toBe("invalid-output");
  });

  test("k306_claim_linking_to_unknown_signal_rejected", () => {
    const evidence = fixedEvidence();
    const raw = {
      ...validRaw(evidence),
      claims: [
        {
          text: "Claim pointing outside the closed evidence list.",
          signalLinks: ["unlinked-signal-id-for-tests"],
          temporality: {
            kind: "can-change",
            changer: "0x0102030405060708090a0b0c0d0e0f1011121314",
          },
        },
      ],
    };
    const result = validateAssessmentOutput(raw, evidence, fixedExpectation());
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.kind).toBe("invalid-output");
  });

  test("k306_output_limit_comes_from_config_with_placeholder_default", () => {
    expect(resolveAssessmentOutputLimit(undefined)).toBe(DEFAULT_ASSESSMENT_MAX_OUTPUT_CHARS);
    expect(resolveAssessmentOutputLimit(8192)).toBe(8192);
    const evidence = fixedEvidence();
    const raw = { ...validRaw(evidence), text: "x".repeat(65) };
    const result = validateAssessmentOutput(raw, evidence, fixedExpectation(64));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.kind).toBe("output-too-large");
    if (result.error.kind !== "output-too-large") {
      return;
    }
    expect(result.error.limitChars).toBe(64);
  });
});
