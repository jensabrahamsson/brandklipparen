// Envelope meanings for model input (M-02e). A listed finding id means
// its detector FOUND the pattern: the service pairs every signal and
// finding id with its stated meaning for the prompt, ordered with
// signals first and decompiler display records last, capped so the
// input stays bounded while the evidence ids travel whole beside them.
import { describe, expect, test } from "vitest";
import type { AssessmentEnvelope } from "../../../src/application/analyzeToken.ts";
import {
  catalogueOfEnvelope,
  frozenFactsOfEnvelope,
} from "../../../src/application/investigationService.ts";
import { envelopeMeanings } from "../../../src/application/modelMeanings.ts";
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";
import { Evidence } from "../../../src/domain/evidence.ts";
import type { Evidence as EvidenceType } from "../../../src/domain/evidence.ts";
import { SUPPORTED_TEMPLATE_VERSION, renderExplanation } from "../../../src/domain/explain.ts";
import { MAX_MODEL_MEANINGS } from "../../../src/domain/modelMeanings.ts";
import { Signal } from "../../../src/domain/signals.ts";
import type { Signal as SignalType, Temporality } from "../../../src/domain/signals.ts";
import { Bytecode, CodeHash, Selector } from "../../../src/domain/types.ts";
import type {
  Bytecode as BytecodeType,
  CodeHash as CodeHashType,
} from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function code(): BytecodeType {
  return mustOk(Bytecode.parse(`0x${"00".repeat(64)}`));
}

function codeHashOf(value: BytecodeType): CodeHashType {
  return mustOk(CodeHash.of(value));
}

function evidenceFor(selector: string): EvidenceType {
  return mustOk(Evidence.create({ selector: mustOk(Selector.parse(selector)) }));
}

function unknownObserved(): Temporality {
  return { kind: "can-change-unknown" };
}

function blacklistSignal(value: BytecodeType): SignalType {
  return mustOk(
    Signal.createCapability({
      codeHash: codeHashOf(value),
      risk: "honeypot",
      direction: "raises",
      severity: "high",
      temporality: unknownObserved(),
      evidence: [evidenceFor("0x8456cb59")],
      sourcePlugin: "dev.brandklipparen.blacklist",
    }),
  );
}

function blacklistFinding(): {
  readonly id: string;
  readonly pluginId: string;
  readonly title: string;
  readonly evidence: readonly EvidenceType[];
  readonly payload: { readonly feature: string };
} {
  return {
    id: "dev.brandklipparen.blacklist:blacklist",
    pluginId: "dev.brandklipparen.blacklist",
    title: "Privileged caller can set a mapping entry that gates the transfer path",
    evidence: [evidenceFor("0x8456cb59")],
    payload: { feature: "blacklist" },
  };
}

function decompilerFinding(index: number): {
  readonly id: string;
  readonly pluginId: string;
  readonly title: string;
  readonly evidence: readonly EvidenceType[];
  readonly payload: { readonly feature: string };
} {
  const selector = `0x${index.toString(16).padStart(8, "0")}`;
  return {
    id: `dev.brandklipparen.decompiler:${selector}`,
    pluginId: "dev.brandklipparen.decompiler",
    title: `Decompiled function ${selector} (${selector})`,
    evidence: [evidenceFor(selector)],
    payload: { feature: "decompiled-function" },
  };
}

function envelopeWith(
  signals: readonly SignalType[],
  findingsByPlugin: Readonly<Record<string, ReadonlyArray<ReturnType<typeof blacklistFinding>>>>,
): AssessmentEnvelope {
  const rendered = mustOk(
    renderExplanation({
      signals: [...signals],
      templateVersion: SUPPORTED_TEMPLATE_VERSION,
      observed: unknownObserved(),
    }),
  );
  const pluginResults = Object.entries(findingsByPlugin).map(([pluginId, findings]) => ({
    pluginId,
    pluginVersion: "1.0.0",
    apiVersion: "1.0",
    outcome: "ok",
    findings: [...findings],
  }));
  // Score and probabilities travel for the unchanged-proof snapshot only;
  // the meanings below never read them.
  return {
    signals: [...signals],
    explanation: rendered,
    pluginResults,
    score: 81,
    probabilities: { "rug-pull": 0, honeypot: 0, "bot-pump": 0 },
  } as unknown as AssessmentEnvelope;
}

describe("m02e envelope meanings for model input", () => {
  test("m02e_blacklist_finding_is_presented_as_found_with_its_meaning", () => {
    const value = code();
    const envelope = envelopeWith([blacklistSignal(value)], {
      "dev.brandklipparen.blacklist": [blacklistFinding()],
    });
    const meanings = envelopeMeanings(envelope);
    const listed = meanings.find((meaning) => meaning.id === "dev.brandklipparen.blacklist:blacklist");
    expect(listed).toBeDefined();
    expect(listed?.pluginId).toBe("dev.brandklipparen.blacklist");
    expect(listed?.meaning).toBe("Privileged caller can set a mapping entry that gates the transfer path");
    expect(listed?.selectors).toContainEqual({ selector: "0x8456cb59", name: "pause()" });
    const signalMeaning = meanings.find((meaning) => meaning.id.startsWith("signal:"));
    expect(signalMeaning?.pluginId).toBe("dev.brandklipparen.blacklist");
    expect(signalMeaning?.severity).toBe("high");
    expect(signalMeaning?.direction).toBe("raises");
  });

  test("m02e_meanings_cap_holds_while_evidence_ids_stay_whole", () => {
    const value = code();
    const decompiler = Array.from({ length: 64 }, (_, index) => decompilerFinding(index));
    const envelope = envelopeWith([blacklistSignal(value)], {
      "dev.brandklipparen.blacklist": [blacklistFinding()],
      "dev.brandklipparen.decompiler": decompiler,
    });
    const meanings = envelopeMeanings(envelope);
    expect(meanings.length).toBeLessThanOrEqual(MAX_MODEL_MEANINGS);
    expect(meanings.map((meaning) => meaning.id)).toContain("dev.brandklipparen.blacklist:blacklist");
    const facts = frozenFactsOfEnvelope(envelope);
    expect(facts.evidenceIds).toContain("dev.brandklipparen.blacklist:blacklist");
    expect(facts.evidenceIds.length).toBe(1 + 1 + 64);
    expect(facts.meanings?.length).toBeLessThanOrEqual(MAX_MODEL_MEANINGS);
  });

  test("m02e_catalogue_tool_descriptions_carry_finding_titles", () => {
    const value = code();
    const envelope = envelopeWith([blacklistSignal(value)], {
      "dev.brandklipparen.blacklist": [blacklistFinding()],
    });
    const catalogue = catalogueOfEnvelope(mustDefaultDetectorSet(), envelope, {});
    const blacklist = catalogue.tools.find((tool) => tool.toolId === "detector.dev.brandklipparen.blacklist");
    expect(blacklist).toBeDefined();
    expect(blacklist?.description).toContain("dev.brandklipparen.blacklist:blacklist");
    expect(blacklist?.description).toContain("Privileged caller can set a mapping entry that gates the transfer path");
    expect(blacklist?.description).toContain("FOUND");
  });
});
