// Tests for S-023 (K-301, K-302, K-303, K-304): template-based deterministic
// explanations in the pure core. Written first (red) per A-21; the
// implementation lives in src/domain/explain.ts. All bytecode, addresses and
// selectors below are small synthetic values in this file: no real contract
// bytecode and no external data. Template text carries no thresholds,
// weights or limits: risk, direction, severity and cause travel as closed
// vocabulary words from the signals, and every number in the text is quoted
// evidence data (selector, offset, block, value, similarity, count).
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { CodeSnippet, Evidence } from "../../../src/domain/evidence.ts";
import type { Evidence as EvidenceType } from "../../../src/domain/evidence.ts";
import {
  SUPPORTED_TEMPLATE_VERSION,
  renderExplanation,
  templateCatalogueId,
} from "../../../src/domain/explain.ts";
import type { Explanation as ExplanationType } from "../../../src/domain/explain.ts";
import { explanationToCanonical } from "../../../src/domain/explain.ts";
import { canonicalSerialize } from "../../../src/domain/serialize.ts";
import { Signal } from "../../../src/domain/signals.ts";
import type {
  Direction,
  HardToAnalyzeCause,
  RiskType,
  Severity,
  Signal as SignalType,
  Temporality,
} from "../../../src/domain/signals.ts";
import {
  Address,
  BlockNumber,
  Bytecode,
  CloneGroupId,
  CodeHash,
  PcOffset,
  Probability,
  Selector,
  Slot,
  StorageWord,
  TemplateVersion,
  Timestamp,
} from "../../../src/domain/types.ts";
import type {
  Address as AddressType,
  Bytecode as BytecodeType,
  CodeHash as CodeHashType,
  TemplateVersion as TemplateVersionType,
} from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";

// Unwrap a Result in tests only; the domain itself never throws.
function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

// Fixed synthetic bytecode (128 zero bytes): offsets below 128 are derivable
// and the code hash is stable across runs. No real contract bytecode.
function syntheticCode(): BytecodeType {
  return mustOk(Bytecode.parse(`0x${"00".repeat(128)}`));
}

function codeHashOf(code: BytecodeType): CodeHashType {
  return mustOk(CodeHash.of(code));
}

function testChanger(): AddressType {
  return mustOk(Address.parse("0x0102030405060708090a0b0c0d0e0f1011121314"));
}

function changeableTemporality(): Temporality {
  return { kind: "can-change", changer: testChanger() };
}

function nowTemporality(): Temporality {
  return {
    kind: "applies-now",
    measuredValue: {
      value: mustOk(StorageWord.parse(`0x${"00".repeat(31)}01`)),
      slot: mustOk(Slot.parse(`0x${"00".repeat(32)}`)),
      block: mustOk(BlockNumber.of(18000000)),
      at: mustOk(Timestamp.of(1700000000000)),
    },
    block: mustOk(BlockNumber.of(18000000)),
    at: mustOk(Timestamp.of(1700000000000)),
  };
}

function evidenceAt(code: BytecodeType, selector: string, offset: number): EvidenceType {
  return mustOk(
    Evidence.create({
      selector: mustOk(Selector.parse(selector)),
      offset: mustOk(PcOffset.of(offset, code)),
    }),
  );
}

function evidenceBare(selector: string): EvidenceType {
  return mustOk(Evidence.create({ selector: mustOk(Selector.parse(selector)) }));
}

function capabilitySignal(
  code: BytecodeType,
  temporality: Temporality,
  risk: RiskType = "rug-pull",
  direction: Direction = "raises",
  severity: Severity = "high",
): SignalType {
  return mustOk(
    Signal.createCapability({
      codeHash: codeHashOf(code),
      risk,
      direction,
      severity,
      temporality,
      evidence: [evidenceAt(code, "0xa9059cbb", 11)],
    }),
  );
}

function cloneSignal(code: BytecodeType, priorCount: number): SignalType {
  return mustOk(
    Signal.createCloneMatch({
      codeHash: codeHashOf(code),
      risk: "honeypot",
      direction: "raises",
      severity: "medium",
      similarity: mustOk(Probability.ofRounded(0.85)),
      group: mustOk(CloneGroupId.parse("trap-erc20-fee")),
      priorCount,
      evidence: [evidenceBare("0x70a08231")],
    }),
  );
}

function hardSignal(code: BytecodeType, cause: HardToAnalyzeCause): SignalType {
  return mustOk(
    Signal.createHardToAnalyze({
      codeHash: codeHashOf(code),
      risk: "bot-pump",
      cause,
      evidence: [evidenceAt(code, "0x18160ddd", 42)],
    }),
  );
}

function renderText(explanation: ExplanationType): string {
  return canonicalSerialize(explanationToCanonical(explanation));
}

describe("k301 template explanations from evidence", () => {
  test("k301_each_explanation_describes_capability", () => {
    const code = syntheticCode();
    const explanation = mustOk(
      renderExplanation({
        signals: [capabilitySignal(code, changeableTemporality())],
        templateVersion: SUPPORTED_TEMPLATE_VERSION,
        observed: changeableTemporality(),
      }),
    );
    expect(explanation.kind).toBe("template");
    expect(explanation.claims.length).toBe(1);
    const claim = explanation.claims[0];
    if (claim === undefined) {
      throw new Error("expected one claim");
    }
    // Capability language in plain active English, with the can-change marker
    // carrying the authorised changer and the evidence pointer as data.
    expect(claim.text).toContain("lets an account");
    expect(claim.text).toContain("Can change");
    expect(claim.text).toContain(testChanger() as string);
    expect(claim.text).toContain("0xa9059cbb");
    expect(claim.text).toContain("11");
    expect(claim.text).toContain("rug-pull");
  });

  test("k303_each_capability_marked_now_or_changeable", () => {
    const code = syntheticCode();
    const now = mustOk(
      renderExplanation({
        signals: [capabilitySignal(code, nowTemporality())],
        templateVersion: SUPPORTED_TEMPLATE_VERSION,
        observed: changeableTemporality(),
      }),
    );
    const nowClaim = now.claims[0];
    if (nowClaim === undefined) {
      throw new Error("expected one claim");
    }
    expect(nowClaim.text).toContain("Holds now");
    expect(nowClaim.text).not.toContain("Can change");
    expect(nowClaim.temporality.kind).toBe("applies-now");

    const changeable = mustOk(
      renderExplanation({
        signals: [capabilitySignal(code, changeableTemporality())],
        templateVersion: SUPPORTED_TEMPLATE_VERSION,
        observed: nowTemporality(),
      }),
    );
    const changeClaim = changeable.claims[0];
    if (changeClaim === undefined) {
      throw new Error("expected one claim");
    }
    expect(changeClaim.text).toContain("Can change");
    expect(changeClaim.text).not.toContain("Holds now");
    expect(changeClaim.temporality.kind).toBe("can-change");
  });

  test("k301_every_claim_links_to_signal", () => {
    const code = syntheticCode();
    const signals = [
      capabilitySignal(code, changeableTemporality()),
      cloneSignal(code, 3),
      hardSignal(code, "timeout"),
    ];
    const explanation = mustOk(
      renderExplanation({
        signals,
        templateVersion: SUPPORTED_TEMPLATE_VERSION,
        observed: changeableTemporality(),
      }),
    );
    const ids = new Set(signals.map((signal) => signal.id as string));
    expect(explanation.claims.length).toBe(signals.length);
    for (const claim of explanation.claims) {
      expect(claim.signalLinks.length).toBeGreaterThanOrEqual(1);
      for (const link of claim.signalLinks) {
        expect(ids.has(link as string)).toBe(true);
      }
    }
  });

  test("k301_response_carries_template_version", () => {
    const code = syntheticCode();
    const explanation = mustOk(
      renderExplanation({
        signals: [capabilitySignal(code, nowTemporality())],
        templateVersion: SUPPORTED_TEMPLATE_VERSION,
        observed: nowTemporality(),
      }),
    );
    expect(explanation.templateVersion).toBe(SUPPORTED_TEMPLATE_VERSION);
  });

  test("k301_explanation_built_deterministically_from_evidence", () => {
    const first = mustOk(
      renderExplanation({
        signals: [capabilitySignal(syntheticCode(), changeableTemporality())],
        templateVersion: SUPPORTED_TEMPLATE_VERSION,
        observed: changeableTemporality(),
      }),
    );
    // Rebuilt from scratch from the same evidence: bit-identical text.
    const second = mustOk(
      renderExplanation({
        signals: [capabilitySignal(syntheticCode(), changeableTemporality())],
        templateVersion: SUPPORTED_TEMPLATE_VERSION,
        observed: changeableTemporality(),
      }),
    );
    expect(renderText(second)).toBe(renderText(first));
    // Rendering never reads bytecode: the input carries signals only, and the
    // output text names selectors and offsets but no code hash.
    expect(renderText(first)).not.toContain(codeHashOf(syntheticCode()) as string);
  });

  test("k301_missing_template_yields_typed_error", () => {
    const code = syntheticCode();
    const unknown = mustOk(TemplateVersion.parse("9.9.9"));
    const result = renderExplanation({
      signals: [capabilitySignal(code, changeableTemporality())],
      templateVersion: unknown,
      observed: changeableTemporality(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected an unknown-template-version error");
    }
    expect(result.error.kind).toBe("unknown-template-version");
    expect(result.error.templateVersion).toBe("9.9.9");
  });

  test("k301_templates_keyed_by_signal_catalogue_id", () => {
    const code = syntheticCode();
    const capability = capabilitySignal(code, changeableTemporality());
    const clone = cloneSignal(code, 1);
    const hard = hardSignal(code, "decompiler-error");
    const ids = [capability, clone, hard].map(templateCatalogueId);
    expect(new Set(ids).size).toBe(3);
    expect(templateCatalogueId(capability)).toBe(templateCatalogueId(capabilitySignal(code, nowTemporality())));
  });

  test("k301_untrusted_strings_rendered_as_data", () => {
    const code = syntheticCode();
    const hostile = `{{severity}} \${risk} "quoted"\nnew line`;
    const snippet = mustOk(
      CodeSnippet.create({
        text: hostile,
        line: 3,
        selector: mustOk(Selector.parse("0x18160ddd")),
      }),
    );
    const plainSnippet = mustOk(
      CodeSnippet.create({
        text: "revert(0, 0)",
        line: 0,
        selector: mustOk(Selector.parse("0x095ea7b3")),
      }),
    );
    const signal = mustOk(
      Signal.createHardToAnalyze({
        codeHash: codeHashOf(code),
        risk: "bot-pump",
        cause: "timeout",
        evidence: [
          mustOk(
            Evidence.create({
              selector: mustOk(Selector.parse("0x18160ddd")),
              offset: mustOk(PcOffset.of(42, code)),
              snippet,
            }),
          ),
          mustOk(
            Evidence.create({
              selector: mustOk(Selector.parse("0x095ea7b3")),
              snippet: plainSnippet,
            }),
          ),
        ],
      }),
    );
    const explanation = mustOk(
      renderExplanation({
        signals: [signal],
        templateVersion: SUPPORTED_TEMPLATE_VERSION,
        observed: changeableTemporality(),
      }),
    );
    expect(explanation.claims.length).toBe(1);
    const claim = explanation.claims[0];
    if (claim === undefined) {
      throw new Error("expected one claim");
    }
    // The hostile snippet text travels quoted as data: template braces stay
    // literal and the claim structure (one claim, valid link) stands. The
    // snippet-only entry without an offset renders too.
    expect(claim.text).toContain(JSON.stringify(hostile));
    expect(claim.text).toContain(JSON.stringify("revert(0, 0)"));
    expect(claim.signalLinks[0]).toBe(signal.id);
  });

  test("k301_template_covers_clone_match_and_hard_to_analyze", () => {
    const code = syntheticCode();
    const one = mustOk(
      renderExplanation({
        signals: [cloneSignal(code, 1)],
        templateVersion: SUPPORTED_TEMPLATE_VERSION,
        observed: changeableTemporality(),
      }),
    );
    const oneClaim = one.claims[0];
    if (oneClaim === undefined) {
      throw new Error("expected one claim");
    }
    expect(oneClaim.text).toContain("1 earlier token");
    expect(oneClaim.text).not.toContain("tokens");

    const many = mustOk(
      renderExplanation({
        signals: [cloneSignal(code, 3)],
        templateVersion: SUPPORTED_TEMPLATE_VERSION,
        observed: changeableTemporality(),
      }),
    );
    const manyClaim = many.claims[0];
    if (manyClaim === undefined) {
      throw new Error("expected one claim");
    }
    expect(manyClaim.text).toContain("3 earlier tokens");

    const causes: readonly HardToAnalyzeCause[] = [
      "timeout",
      "resource-limit",
      "decompiler-error",
      "obfuscated-structure",
    ];
    for (const cause of causes) {
      const explanation = mustOk(
        renderExplanation({
          signals: [hardSignal(code, cause)],
          templateVersion: SUPPORTED_TEMPLATE_VERSION,
          observed: nowTemporality(),
        }),
      );
      expect(explanation.claims.length).toBe(1);
      const claim = explanation.claims[0];
      if (claim === undefined) {
        throw new Error(`expected one claim for cause ${cause}`);
      }
      expect(claim.text).toContain("bot-pump");
      expect(claim.text).toContain("Holds now");
    }
  });

  test("k301_rendering_deterministic_and_never_throws", () => {
    const selectorArb = fc.integer({ min: 0, max: 0xffffffff }).map((n) => {
      const parsed = Selector.parse(`0x${n.toString(16).padStart(8, "0")}`);
      if (!parsed.ok) {
        throw new Error("generated selector must parse");
      }
      return parsed.value;
    });
    const temporalityArb: fc.Arbitrary<Temporality> = fc.constantFrom(nowTemporality(), changeableTemporality());
    const riskArb: fc.Arbitrary<RiskType> = fc.constantFrom("rug-pull", "honeypot", "bot-pump");
    const directionArb: fc.Arbitrary<Direction> = fc.constantFrom("raises", "lowers");
    const severityArb: fc.Arbitrary<Severity> = fc.constantFrom("low", "medium", "high");
    const causeArb: fc.Arbitrary<HardToAnalyzeCause> = fc.constantFrom(
      "timeout",
      "resource-limit",
      "decompiler-error",
      "obfuscated-structure",
    );

    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(selectorArb, riskArb, directionArb, severityArb, causeArb, temporalityArb).chain(
            ([selector, risk, direction, severity, cause, temporality]) => {
              const code = syntheticCode();
              const hash = codeHashOf(code);
              return fc.constantFrom<SignalType>(
                mustOk(
                  Signal.createCapability({
                    codeHash: hash,
                    risk,
                    direction,
                    severity,
                    temporality,
                    evidence: [
                      mustOk(Evidence.create({ selector })),
                      mustOk(
                        Evidence.create({
                          selector,
                          offset: mustOk(PcOffset.of(11, code)),
                        }),
                      ),
                    ],
                  }),
                ),
                mustOk(
                  Signal.createCloneMatch({
                    codeHash: hash,
                    risk,
                    direction,
                    severity,
                    similarity: mustOk(Probability.ofRounded(0.5)),
                    group: mustOk(CloneGroupId.parse("trap-erc20-fee")),
                    priorCount: 2,
                    evidence: [mustOk(Evidence.create({ selector }))],
                  }),
                ),
                mustOk(
                  Signal.createHardToAnalyze({
                    codeHash: hash,
                    risk,
                    cause,
                    evidence: [mustOk(Evidence.create({ selector }))],
                  }),
                ),
              );
            },
          ),
          { maxLength: 6 },
        ),
        temporalityArb,
        (signals, observed) => {
          const input = {
            signals,
            templateVersion: SUPPORTED_TEMPLATE_VERSION as TemplateVersionType,
            observed,
          };
          const before = JSON.stringify(signals);
          const first = renderExplanation(input);
          const second = renderExplanation(input);
          // The renderer is total: arbitrary signals never throw and never
          // fail construction-free rendering.
          if (!first.ok || !second.ok) {
            throw new Error("rendering must succeed for constructed signals");
          }
          // Deterministic: repeated runs agree bit for bit.
          expect(renderText(second.value)).toBe(renderText(first.value));
          // One claim per signal, every claim linked to an input signal, and
          // the input left unchanged.
          expect(first.value.claims.length).toBe(signals.length);
          const ids = new Set(signals.map((signal) => signal.id as string));
          for (const claim of first.value.claims) {
            expect(claim.signalLinks.length).toBeGreaterThanOrEqual(1);
            for (const link of claim.signalLinks) {
              expect(ids.has(link as string)).toBe(true);
            }
          }
          expect(JSON.stringify(signals)).toBe(before);
        },
      ),
    );
  });
});
