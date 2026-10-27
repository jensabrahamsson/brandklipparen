// hosted open-weights adapter over a recorded transport (S-037,
// K-305, K-309). Written first per A-21: every assessment logs provider
// and model id beside the response label, the adapter reports the
// open-weights model id, and the recorded assessment text refines
// nothing but the assessment field. No live calls, no real keys: the
// transport replays a fixture from tests/fixtures/assessment.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { Evidence } from "../../src/domain/evidence.ts";
import { parseModelArtifact } from "../../src/domain/risk.ts";
import type { ModelArtifact } from "../../src/domain/risk.ts";
import { canonicalSerialize } from "../../src/domain/serialize.ts";
import { Signal } from "../../src/domain/signals.ts";
import {
  Address,
  Bytecode,
  CodeHash,
  ModelId,
  PromptVersion,
  RequestId,
  Selector,
  Timestamp,
} from "../../src/domain/types.ts";
import type {
  CodeHash as CodeHashType,
  PromptVersion as PromptVersionType,
} from "../../src/domain/types.ts";
import type { Evidence as EvidenceType } from "../../src/domain/evidence.ts";
import type { Result } from "../../src/domain/result.ts";
import { SecretString } from "../../src/ports/config.ts";
import { EvidenceList } from "../../src/ports/assessmentModel.ts";
import type { CallContext } from "../../src/ports/assessmentModel.ts";
import {
  hosted_OPEN_WEIGHTS_MODEL_ID,
  hostedOpenWeightsAdapter,
} from "../../src/adapters/assessment/hostedOpenWeights/hostedOpenWeightsAdapter.ts";
import type { hostedAssessmentLogEntry } from "../../src/adapters/assessment/hostedOpenWeights/hostedOpenWeightsAdapter.ts";
import { requestAssessment } from "../../src/application/requestAssessment.ts";
import { SUPPORTED_TEMPLATE_VERSION } from "../../src/domain/explain.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "fixtures", "assessment");

const FAKE_KEY = "fake-hosted-key-for-tests-only";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function mustModelId(): ModelId {
  return mustOk(ModelId.parse(hosted_OPEN_WEIGHTS_MODEL_ID));
}

function successBody(): string {
  return readFileSync(join(fixtureDir, "hosted-success.json"), "utf8");
}

function fixedEvidence(): { codeHash: CodeHashType; entries: [EvidenceType, EvidenceType] } {
  const code = mustOk(Bytecode.parse("0x6001600055"));
  const codeHash = mustOk(CodeHash.of(code));
  const first = mustOk(Evidence.create({ selector: mustOk(Selector.parse("0xa9059cbb")) }));
  const second = mustOk(Evidence.create({ selector: mustOk(Selector.parse("0x70a08231")) }));
  return { codeHash, entries: [first, second] };
}

function fixedPrompt(): PromptVersionType {
  return mustOk(PromptVersion.parse("1.0.0"));
}

function fixedContext(): CallContext {
  return {
    requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(1700000000000)),
    block: "latest",
  };
}

function recordedAdapter(log: hostedAssessmentLogEntry[]): hostedOpenWeightsAdapter {
  return new hostedOpenWeightsAdapter({
    endpoint: "https://hosted.example.invalid/assessment",
    apiKey: new SecretString(FAKE_KEY),
    modelId: mustModelId(),
    transport: async () => ({ status: 200, bodyText: successBody() }),
    onLog: (entry) => {
      log.push(entry);
    },
  });
}

// Placeholder calibration for tests only (K-210): finite test weights with
// no learned values, so score() runs deterministically in the comparison.
function placeholderArtifact(): ModelArtifact {
  const parsed = parseModelArtifact({
    version: "0.1.0",
    severityWeights: { low: 0.2, medium: 0.5, high: 1.0 },
    causeWeights: {
      timeout: 0.4,
      "resource-limit": 0.4,
      "decompiler-error": 0.6,
      "obfuscated-structure": 0.6,
    },
    biases: { "rug-pull": 0.0, honeypot: 0.0, "bot-pump": 0.0 },
    calibration: {
      "rug-pull": { slope: 1.0, intercept: 0.0 },
      honeypot: { slope: 1.0, intercept: 0.0 },
      "bot-pump": { slope: 1.0, intercept: 0.0 },
    },
    scoreWeights: { "rug-pull": 1.0, honeypot: 1.0, "bot-pump": 1.0 },
  });
  if (!parsed.ok) {
    throw new Error("placeholder artifact must parse");
  }
  return parsed.value;
}

describe("hosted open-weights adapter over a recorded transport (S-037)", () => {
  test("k309_hosted_adapter_uses_open_weights_model_id", async () => {
    const { codeHash, entries } = fixedEvidence();
    const evidence = mustOk(EvidenceList.create(codeHash, [entries[0], entries[1]]));
    const log: hostedAssessmentLogEntry[] = [];
    const adapter = recordedAdapter(log);
    expect(adapter.provider()).toBe("hosted-open-weights");
    expect(adapter.modelId()).toBe("meta-models/muse-spark-open-1026");
    const result = await adapter.assess(evidence, fixedPrompt(), fixedContext());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.provider).toBe("hosted-open-weights");
    expect(result.value.modelId).toBe("meta-models/muse-spark-open-1026");
    expect(log.length).toBe(1);
    const entry = log[0];
    if (entry === undefined) {
      throw new Error("expected one log entry per assessment");
    }
    expect(entry.provider).toBe("hosted-open-weights");
    expect(entry.modelId).toBe("meta-models/muse-spark-open-1026");
    expect(entry.promptVersion).toBe("1.0.0");
    expect(entry.requestId.length).toBeGreaterThan(0);
    expect(JSON.stringify(entry).includes(FAKE_KEY)).toBe(false);
  });

  test("k307_scores_and_evidence_identical_with_hosted_adapter", async () => {
    const { codeHash, entries } = fixedEvidence();
    const signal = mustOk(
      Signal.createCapability({
        codeHash,
        risk: "rug-pull",
        direction: "raises",
        severity: "high",
        temporality: {
          kind: "can-change",
          changer: mustOk(Address.parse("0xe943a4b43ad372355be29445a2532cc0920a7108")),
        },
        evidence: [entries[0]],
      }),
    );
    const evidence = mustOk(EvidenceList.create(codeHash, [entries[0]]));
    const base = {
      signals: [signal],
      artifact: placeholderArtifact(),
      evidence,
      templateVersion: SUPPORTED_TEMPLATE_VERSION,
      observed: {
        kind: "can-change",
        changer: mustOk(Address.parse("0xe943a4b43ad372355be29445a2532cc0920a7108")),
      } as const,
      promptVersion: fixedPrompt(),
      ctx: fixedContext(),
    };
    const withoutAdapter = await requestAssessment(base);
    const withhosted = await requestAssessment({ ...base, adapter: recordedAdapter([]) });
    expect(withoutAdapter.ok).toBe(true);
    expect(withhosted.ok).toBe(true);
    if (!withoutAdapter.ok || !withhosted.ok) {
      return;
    }
    const envelopeOf = (risk: typeof withoutAdapter.value.risk): string =>
      canonicalSerialize({
        probabilities: {
          "bot-pump": (risk.probabilities as Record<string, number>)["bot-pump"] ?? 0,
          honeypot: (risk.probabilities as Record<string, number>)["honeypot"] ?? 0,
          "rug-pull": (risk.probabilities as Record<string, number>)["rug-pull"] ?? 0,
        },
        score: risk.score as number,
        signals: [signal.id as string],
        evidence: evidence.evidence.map((item) => ({
          selector: item.selector as string,
          offset: (item.offset as number | undefined) ?? null,
        })),
      });
    expect(envelopeOf(withhosted.value.risk)).toBe(envelopeOf(withoutAdapter.value.risk));
    expect(withhosted.value.explanation).toEqual(withoutAdapter.value.explanation);
    expect(withhosted.value.assessment).not.toBeNull();
    expect(withhosted.value.assessment?.provider).toBe("hosted-open-weights");
    expect(withhosted.value.assessment?.modelId).toBe("meta-models/muse-spark-open-1026");
    expect(withoutAdapter.value.assessment).toBeNull();
  });
});
