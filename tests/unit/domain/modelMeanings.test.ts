// Per finding and signal meanings for model input (M-02e). A listed
// finding id means its detector FOUND the pattern, so each id travels
// with its stated meaning: plugin id, kind, severity, direction, the
// template sentence, temporality and labelled selectors. Unknown
// selectors stay the raw selector with a null name; least important
// entries trim first under the caps.
import { describe, expect, test } from "vitest";
import { Evidence } from "../../../src/domain/evidence.ts";
import type { Evidence as EvidenceType } from "../../../src/domain/evidence.ts";
import { SUPPORTED_TEMPLATE_VERSION, renderExplanation } from "../../../src/domain/explain.ts";
import type { Claim } from "../../../src/domain/explain.ts";
import {
  MAX_MEANING_CHARS,
  MAX_MEANING_SELECTORS,
  MAX_MODEL_MEANINGS,
  capMeaningsForModel,
  claimBySignalId,
  meaningForCoverage,
  meaningForEvidenceFinding,
  meaningForSignal,
  orderMeaningsForModel,
} from "../../../src/domain/modelMeanings.ts";
import type { FindingMeaning } from "../../../src/domain/modelMeanings.ts";
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
      evidence: [evidenceFor("0x8456cb59"), evidenceFor("0xdeadbeef")],
      sourcePlugin: "dev.brandklipparen.blacklist",
    }),
  );
}

function claimFor(signal: SignalType, observed: Temporality): Claim {
  const rendered = mustOk(
    renderExplanation({
      signals: [signal],
      templateVersion: SUPPORTED_TEMPLATE_VERSION,
      observed,
    }),
  );
  const claim = claimBySignalId(rendered.claims).get(`signal:${(signal.id as string).replace(/^signal:/, "")}`);
  if (claim === undefined) {
    throw new Error("expected a claim for the signal");
  }
  return claim;
}

describe("m02e finding and signal meanings", () => {
  test("m02e_signal_meaning_carries_plugin_kind_severity_direction_claim_and_names", () => {
    const value = code();
    const signal = blacklistSignal(value);
    const observed = unknownObserved();
    const meaning = meaningForSignal(signal, null, observed);
    expect(meaning.id).toBe(`signal:${signal.id as string}`);
    expect(meaning.pluginId).toBe("dev.brandklipparen.blacklist");
    expect(meaning.kind).toBe("capability");
    expect(meaning.severity).toBe("high");
    expect(meaning.direction).toBe("raises");

    const claim = claimFor(signal, observed);
    const withClaim = meaningForSignal(signal, claim, observed);
    expect(withClaim.meaning).toBe(claim.text);
    expect(withClaim.temporality).toContain("no controlling account");
    expect(withClaim.selectors).toContainEqual({ selector: "0x8456cb59", name: "pause()" });
    expect(withClaim.selectors).toContainEqual({ selector: "0xdeadbeef", name: null });
  });

  test("m02e_blacklist_finding_is_presented_as_found", () => {
    const meaning = meaningForEvidenceFinding({
      id: "dev.brandklipparen.blacklist:blacklist",
      pluginId: "dev.brandklipparen.blacklist",
      title: "Privileged caller can set a mapping entry that gates the transfer path",
      selectors: ["0xa9059cbb"],
    });
    expect(meaning.id).toBe("dev.brandklipparen.blacklist:blacklist");
    expect(meaning.pluginId).toBe("dev.brandklipparen.blacklist");
    expect(meaning.kind).toBe("finding");
    expect(meaning.meaning).toBe("Privileged caller can set a mapping entry that gates the transfer path");
    expect(meaning.selectors).toContainEqual({ selector: "0xa9059cbb", name: "transfer(address,uint256)" });
  });

  test("m02e_ordering_puts_signals_before_findings_and_decompiler_last", () => {
    const value = code();
    const high = mustOk(
      Signal.createCapability({
        codeHash: codeHashOf(value),
        risk: "honeypot",
        direction: "raises",
        severity: "high",
        temporality: unknownObserved(),
        evidence: [evidenceFor("0xa9059cbb")],
      }),
    );
    const low = mustOk(
      Signal.createCapability({
        codeHash: codeHashOf(value),
        risk: "honeypot",
        direction: "raises",
        severity: "low",
        temporality: unknownObserved(),
        evidence: [evidenceFor("0x70a08231")],
      }),
    );
    const observed = unknownObserved();
    const ordered = orderMeaningsForModel([
      meaningForEvidenceFinding({
        id: "dev.brandklipparen.decompiler:0x70a08231",
        pluginId: "dev.brandklipparen.decompiler",
        title: "Decompiled function balanceOf (0x70a08231)",
        selectors: ["0x70a08231"],
      }),
      meaningForEvidenceFinding({
        id: "dev.brandklipparen.blacklist:blacklist",
        pluginId: "dev.brandklipparen.blacklist",
        title: "Privileged caller can set a mapping entry that gates the transfer path",
        selectors: ["0xa9059cbb"],
      }),
      meaningForSignal(low, null, observed),
      meaningForSignal(high, null, observed),
    ]);
    expect(ordered.map((meaning) => meaning.id)).toEqual([
      `signal:${high.id as string}`,
      `signal:${low.id as string}`,
      "dev.brandklipparen.blacklist:blacklist",
      "dev.brandklipparen.decompiler:0x70a08231",
    ]);
  });

  test("c19_coverage_ranks_after_every_finding_and_trims_first", () => {
    const value = code();
    const observed = unknownObserved();
    const signal = meaningForSignal(blacklistSignal(value), null, observed);
    const finding = meaningForEvidenceFinding({
      id: "dev.brandklipparen.blacklist:blacklist",
      pluginId: "dev.brandklipparen.blacklist",
      title: "Privileged caller can set a mapping entry that gates the transfer path",
      selectors: ["0xa9059cbb"],
    });
    const decompiler = meaningForEvidenceFinding({
      id: "dev.brandklipparen.decompiler:0x70a08231",
      pluginId: "dev.brandklipparen.decompiler",
      title: "Decompiled function balanceOf (0x70a08231)",
      selectors: ["0x70a08231"],
    });
    const coverage = meaningForCoverage({
      id: "analysis:summary",
      meaning: "Analysis limits: an absent finding means no proof was found, not proof that the pattern is absent.",
    });
    const ordered = orderMeaningsForModel([coverage, decompiler, finding, signal]);
    expect(ordered.map((meaning) => meaning.id)).toEqual([signal.id, finding.id, decompiler.id, coverage.id]);
    expect(coverage.kind).toBe("coverage");
    expect(coverage.severity).toBeNull();
    expect(coverage.selectors).toEqual([]);
  });

  test("m02e_caps_trim_least_important_first_and_bound_field_sizes", () => {
    const value = code();
    const signal = blacklistSignal(value);
    const observed = unknownObserved();
    const signalMeaning = meaningForSignal(signal, null, observed);
    const findings: FindingMeaning[] = [signalMeaning];
    for (let index = 0; index < MAX_MODEL_MEANINGS + 8; index += 1) {
      findings.push(
        meaningForEvidenceFinding({
          id: `dev.brandklipparen.decompiler:0x${index.toString(16).padStart(8, "0")}`,
          pluginId: "dev.brandklipparen.decompiler",
          title: `Decompiled function ${index} (0x${index.toString(16).padStart(8, "0")})`,
          selectors: Array.from(
            { length: MAX_MEANING_SELECTORS + 3 },
            (_, selectorIndex) => `0x${(selectorIndex + 1).toString(16).padStart(8, "0")}`,
          ),
        }),
      );
    }
    const capped = capMeaningsForModel(findings);
    expect(capped.length).toBe(MAX_MODEL_MEANINGS);
    expect(capped.map((meaning) => meaning.id)).toContain(signalMeaning.id);
    for (const meaning of capped) {
      expect(meaning.meaning.length).toBeLessThanOrEqual(MAX_MEANING_CHARS);
      expect(meaning.temporality.length).toBeLessThanOrEqual(MAX_MEANING_CHARS);
      expect(meaning.selectors.length).toBeLessThanOrEqual(MAX_MEANING_SELECTORS);
    }
  });
});
