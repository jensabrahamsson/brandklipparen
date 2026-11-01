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
import {
  ANALYSIS_SUMMARY_COVERAGE_ID,
  DECOMPILE_INCOMPLETE_COVERAGE_ID,
  envelopeMeanings,
  explainCoverageIds,
  explainCoverageMeanings,
  explainMeanings,
} from "../../../src/application/modelMeanings.ts";
import { capMeaningsForModel } from "../../../src/domain/modelMeanings.ts";
import { standardCantTell } from "../../../src/domain/cantTell.ts";
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

  test("c19_coverage_ids_always_collect_summary_and_cant_tell", () => {
    const value = code();
    const envelope = envelopeWith([blacklistSignal(value)], {
      "dev.brandklipparen.blacklist": [blacklistFinding()],
      "dev.brandklipparen.decompiler": [decompilerFinding(0)],
    });
    const withCantTell = { ...envelope, cantTell: standardCantTell() };
    const ids = explainCoverageIds(withCantTell);
    expect(ids[0]).toBe(ANALYSIS_SUMMARY_COVERAGE_ID);
    expect(ids).toContain("cant-tell:liquidity-locks");
    expect(ids).toContain("cant-tell:owner-shares");
    expect(ids).toContain("cant-tell:wallet-clusters");
    expect(ids).toContain("cant-tell:team-identity");
    expect(ids).toContain("cant-tell:code-intent");
    expect(ids).toContain("cant-tell:external-contracts");
    expect(ids).not.toContain(DECOMPILE_INCOMPLETE_COVERAGE_ID);
  });

  test("c19_coverage_decompile_flag_follows_plugin_outcome", () => {
    const value = code();
    const envelope = envelopeWith([blacklistSignal(value)], {
      "dev.brandklipparen.blacklist": [blacklistFinding()],
    });
    const withCantTell = { ...envelope, cantTell: standardCantTell() };
    expect(explainCoverageIds(withCantTell)).toContain(DECOMPILE_INCOMPLETE_COVERAGE_ID);
    const failing = {
      ...withCantTell,
      pluginResults: [
        ...withCantTell.pluginResults,
        {
          pluginId: "dev.brandklipparen.decompiler",
          pluginVersion: "1.0.0",
          apiVersion: "1.0",
          outcome: "threw" as const,
          findings: [],
        },
      ] as AssessmentEnvelope["pluginResults"],
    };
    expect(explainCoverageIds(failing)).toContain(DECOMPILE_INCOMPLETE_COVERAGE_ID);
    expect(explainCoverageMeanings(failing).find((meaning) => meaning.id === DECOMPILE_INCOMPLETE_COVERAGE_ID)?.meaning).toContain(
      "threw",
    );
    const recovered = {
      ...withCantTell,
      pluginResults: [
        ...withCantTell.pluginResults,
        {
          pluginId: "dev.brandklipparen.decompiler",
          pluginVersion: "1.0.0",
          apiVersion: "1.0",
          outcome: "ok" as const,
          findings: [],
        },
      ] as AssessmentEnvelope["pluginResults"],
    };
    expect(explainCoverageIds(recovered)).not.toContain(DECOMPILE_INCOMPLETE_COVERAGE_ID);
  });

  test("c19_coverage_meanings_state_limits_not_safety", () => {
    const value = code();
    const envelope = envelopeWith([blacklistSignal(value)], {
      "dev.brandklipparen.blacklist": [blacklistFinding()],
      "dev.brandklipparen.decompiler": [decompilerFinding(0), decompilerFinding(1)],
    });
    const withCantTell = { ...envelope, cantTell: standardCantTell() };
    const meanings = explainCoverageMeanings(withCantTell);
    const summary = meanings.find((meaning) => meaning.id === ANALYSIS_SUMMARY_COVERAGE_ID);
    expect(summary?.kind).toBe("coverage");
    expect(summary?.meaning).toContain("1 of 2 decompiled functions");
    expect(summary?.meaning).toContain("not proof that the pattern is absent");
    for (const meaning of meanings) {
      expect(meaning.meaning).toContain("not proof");
    }
    const open = meanings.find((meaning) => meaning.id === "cant-tell:liquidity-locks");
    expect(open?.meaning).toContain("cannot settle");
  });

  test("c19_explain_meanings_rank_coverage_after_findings_and_trim_first", () => {
    const value = code();
    const decompiler = Array.from({ length: 20 }, (_, index) => decompilerFinding(index));
    const envelope = envelopeWith([blacklistSignal(value)], {
      "dev.brandklipparen.blacklist": [blacklistFinding()],
      "dev.brandklipparen.decompiler": decompiler,
    });
    const withCantTell = { ...envelope, cantTell: standardCantTell() };
    const small = explainMeanings(withCantTell);
    const lastCoverage = small.map((meaning) => meaning.id).findIndex((id) => id === ANALYSIS_SUMMARY_COVERAGE_ID);
    expect(lastCoverage).toBeGreaterThan(-1);
    expect(small.slice(0, lastCoverage).every((meaning) => meaning.kind !== "coverage")).toBe(true);
    const crowded = Array.from({ length: 40 }, (_, index) => decompilerFinding(100 + index));
    const full = envelopeWith([blacklistSignal(value)], {
      "dev.brandklipparen.blacklist": [blacklistFinding()],
      "dev.brandklipparen.decompiler": crowded,
    });
    const capped = explainMeanings({ ...full, cantTell: standardCantTell() });
    expect(capped.length).toBeLessThanOrEqual(MAX_MODEL_MEANINGS);
    expect(capped.some((meaning) => meaning.kind === "coverage")).toBe(false);
    expect(explainCoverageIds({ ...full, cantTell: standardCantTell() }).length).toBeGreaterThan(0);
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

  test("m02e_coverage_ids_name_what_was_checked_with_zero_findings", () => {
    const rendered = mustOk(
      renderExplanation({
        signals: [],
        templateVersion: SUPPORTED_TEMPLATE_VERSION,
        observed: unknownObserved(),
      }),
    );
    const envelope = {
      signals: [],
      explanation: rendered,
      pluginResults: [
        {
          pluginId: "dev.brandklipparen.pause",
          pluginVersion: "1.0.0",
          apiVersion: "1.0",
          outcome: "ok",
          findings: [],
        },
        {
          pluginId: "dev.brandklipparen.mint",
          pluginVersion: "1.0.0",
          apiVersion: "1.0",
          outcome: "timeout",
          findings: [],
        },
      ],
      proxy: { kind: "none" },
      cantTell: [
        { question: "liquidity-locks", dataSource: "liquidity-lock-registry" },
        { question: "code-intent", dataSource: "team-disclosure" },
      ],
      score: 19,
      probabilities: { "rug-pull": 0, honeypot: 0, "bot-pump": 0 },
    } as unknown as AssessmentEnvelope;
    const ids = explainCoverageIds(envelope);
    expect(ids).toContain("cant-tell:liquidity-locks");
    expect(ids).toContain("cant-tell:code-intent");
    expect(ids).toContain("check:dev.brandklipparen.pause:not-found");
    expect(ids).toContain("check:dev.brandklipparen.mint:could-not-check");
    expect(ids).toContain("analysis:summary");
    const meanings = explainCoverageMeanings(envelope);
    const summary = meanings.find((meaning) => meaning.id === "analysis:summary");
    expect(summary?.meaning).toContain("0 scored signals found");
    expect(summary?.meaning).toContain("1 detectors could not be read");
    expect(summary?.meaning).toContain("proxy: none");
    const combined = capMeaningsForModel([...envelopeMeanings(envelope), ...meanings]);
    expect(combined.length).toBeLessThanOrEqual(MAX_MODEL_MEANINGS);
    expect(combined.map((meaning) => meaning.id)).toContain("analysis:summary");
  });
});
