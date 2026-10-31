// Tests for P-1 (1.1.0 honest claim sentences, no duplicates, correct
// temporality). Template rendering is display-only: score, probabilities
// and the signal list are identical before and after the rewording.
// Fixture inputs under tests/fixtures/golden are frozen synthetic values
// only (no real contract bytecode, no real addresses); expected outputs
// are reviewed text with signal ids normalised to `signal:<fixture
// index>` because the raw ids are code-hash keccaks. 1.0.0 goldens stay
// byte-identical under tests/golden/k301-explanation.test.ts.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { CodeSnippet, Evidence } from "../../../src/domain/evidence.ts";
import {
  TEMPLATE_VERSION_1_1_0,
  explanationToCanonical,
  renderExplanation,
} from "../../../src/domain/explain.ts";
import type {
  Explanation as ExplanationType,
  ExplanationOrigin,
} from "../../../src/domain/explain.ts";
import { canonicalSerialize } from "../../../src/domain/serialize.ts";
import { Signal } from "../../../src/domain/signals.ts";
import type { Signal as SignalType, Temporality } from "../../../src/domain/signals.ts";
import { parseModelArtifact, score } from "../../../src/domain/risk.ts";
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
import type { Result } from "../../../src/domain/result.ts";
import type {
  Bytecode as BytecodeType,
  DomainError,
} from "../../../src/domain/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, "..", "..", "fixtures", "golden");

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

// Fixed synthetic bytecode (512 zero bytes) backing every fixture: it
// keeps each fixture offset derivable and the code hash stable. No real
// contract bytecode is committed.
function fixtureCode(): BytecodeType {
  return mustOk(Bytecode.parse(`0x${"00".repeat(512)}`));
}

function testChanger(): string {
  return mustOk(Address.parse("0x0102030405060708090a0b0c0d0e0f1011121314")) as string;
}

type FixtureEvidence = {
  readonly selector: string;
  readonly offset?: number;
  readonly snippet?: { readonly text: string; readonly line: number };
};

type FixtureSignal =
  | {
      readonly kind: "capability";
      readonly risk: "rug-pull" | "honeypot" | "bot-pump";
      readonly direction: "raises" | "lowers";
      readonly severity: "low" | "medium" | "high";
      readonly temporality: Temporality;
      readonly evidence: readonly FixtureEvidence[];
    }
  | {
      readonly kind: "clone-match";
      readonly risk: "rug-pull" | "honeypot" | "bot-pump";
      readonly direction: "raises" | "lowers";
      readonly severity: "low" | "medium" | "high";
      readonly similarity: number;
      readonly group: string;
      readonly priorCount: number;
      readonly evidence: readonly FixtureEvidence[];
    }
  | {
      readonly kind: "hard-to-analyze";
      readonly risk: "rug-pull" | "honeypot" | "bot-pump";
      readonly cause: "timeout" | "resource-limit" | "decompiler-error" | "obfuscated-structure";
      readonly evidence: readonly FixtureEvidence[];
    };

type FixtureInput = {
  readonly templateVersion: string;
  readonly observed: Temporality;
  readonly signals: readonly FixtureSignal[];
  readonly origins?: Readonly<Record<string, { readonly pluginId: string; readonly key: string }>>;
};

function buildSignal(code: BytecodeType, entry: FixtureSignal): Result<SignalType, DomainError> {
  const codeHash = mustOk(CodeHash.of(code));
  const evidence = entry.evidence.map((item) => {
    const selector = mustOk(Selector.parse(item.selector));
    if (item.offset === undefined && item.snippet === undefined) {
      return mustOk(Evidence.create({ selector }));
    }
    if (item.snippet === undefined) {
      return mustOk(Evidence.create({ selector, offset: mustOk(PcOffset.of(item.offset ?? 0, code)) }));
    }
    const snippet = mustOk(
      CodeSnippet.create({ text: item.snippet.text, line: item.snippet.line, selector }),
    );
    if (item.offset === undefined) {
      return mustOk(Evidence.create({ selector, snippet }));
    }
    return mustOk(
      Evidence.create({ selector, offset: mustOk(PcOffset.of(item.offset, code)), snippet }),
    );
  });
  switch (entry.kind) {
    case "capability":
      return Signal.createCapability({
        codeHash,
        risk: entry.risk,
        direction: entry.direction,
        severity: entry.severity,
        temporality: entry.temporality,
        evidence,
      });
    case "clone-match":
      return Signal.createCloneMatch({
        codeHash,
        risk: entry.risk,
        direction: entry.direction,
        severity: entry.severity,
        similarity: mustOk(Probability.ofRounded(entry.similarity)),
        group: mustOk(CloneGroupId.parse(entry.group)),
        priorCount: entry.priorCount,
        evidence,
      });
    case "hard-to-analyze":
      return Signal.createHardToAnalyze({
        codeHash,
        risk: entry.risk,
        cause: entry.cause,
        evidence,
      });
  }
}

function buildOrigins(
  signals: readonly SignalType[],
  origins: Readonly<Record<string, { readonly pluginId: string; readonly key: string }>> | undefined,
): Map<string, ExplanationOrigin> {
  const out = new Map<string, ExplanationOrigin>();
  if (origins === undefined) {
    return out;
  }
  signals.forEach((signal, index) => {
    const entry = origins[String(index)];
    if (entry === undefined) {
      return;
    }
    const id = signal.id as string;
    if (!out.has(id)) {
      out.set(id, Object.freeze({ pluginId: entry.pluginId, key: entry.key }));
    }
  });
  return out;
}

function render110(fixture: FixtureInput): { explanation: ExplanationType; signals: SignalType[] } {
  const code = fixtureCode();
  const signals = fixture.signals.map((entry) => mustOk(buildSignal(code, entry)));
  const explanation = mustOk(
    renderExplanation({
      signals,
      templateVersion: mustOk(TemplateVersion.parse(fixture.templateVersion)),
      observed: fixture.observed,
      origins: buildOrigins(signals, fixture.origins),
    }),
  );
  return { explanation, signals };
}

type NormalizedClaim = {
  readonly text: string;
  readonly signalLinks: readonly string[];
  readonly temporality: unknown;
};

// Raw signal ids are code-hash keccaks, so golden comparison normalises
// each id to the fixture index of its first signal. Claims sort by text
// so hash order never leaks into the expectation.
function normalizedClaims(explanation: ExplanationType, signals: readonly SignalType[]): NormalizedClaim[] {
  const idToIndex = new Map<string, number>();
  signals.forEach((signal, index) => {
    const id = signal.id as string;
    if (!idToIndex.has(id)) {
      idToIndex.set(id, index);
    }
  });
  const claims = explanation.claims.map((claim) =>
    Object.freeze({
      text: claim.text,
      signalLinks: Object.freeze(
        claim.signalLinks.map((link) => `signal:${String(idToIndex.get(link as string) ?? -1)}`),
      ),
      temporality: JSON.parse(JSON.stringify(claim.temporality)) as unknown,
    }),
  );
  claims.sort((left, right) => {
    if (left.text < right.text) {
      return -1;
    }
    if (left.text > right.text) {
      return 1;
    }
    return 0;
  });
  return claims;
}

function testArtifact() {
  return mustOk(
    parseModelArtifact({
      version: "0.1.0-prior.test",
      severityWeights: { low: 0.2, medium: 0.5, high: 1.0 },
      causeWeights: { timeout: 0.4, "resource-limit": 0.4, "decompiler-error": 0.6, "obfuscated-structure": 0.6 },
      biases: { "rug-pull": 0.0, honeypot: 0.0, "bot-pump": 0.0 },
      calibration: {
        "rug-pull": { slope: 1.0, intercept: 0.0 },
        honeypot: { slope: 1.0, intercept: 0.0 },
        "bot-pump": { slope: 1.0, intercept: 0.0 },
      },
      scoreWeights: { "rug-pull": 1.0, honeypot: 1.0, "bot-pump": 1.0 },
    }),
  );
}

function capabilitySignal(
  code: BytecodeType,
  selector: string,
  offset: number,
  origin: ExplanationOrigin,
): { signal: SignalType; origins: Map<string, ExplanationOrigin> } {
  const signal = mustOk(
    Signal.createCapability({
      codeHash: mustOk(CodeHash.of(code)),
      risk: "rug-pull",
      direction: "raises",
      severity: "high",
      temporality: { kind: "can-change", changer: mustOk(Address.parse(testChanger())) },
      evidence: [
        mustOk(Evidence.create({ selector: mustOk(Selector.parse(selector)), offset: mustOk(PcOffset.of(offset, code)) })),
      ],
    }),
  );
  return { signal, origins: new Map([[signal.id as string, origin]]) };
}

describe("p1 honest claim sentences (1.1.0)", () => {
  test("p1_110_golden_c_renders_reviewed_claims", () => {
    const fixture = JSON.parse(readFileSync(join(goldenDir, "p1-explanation-c.input.json"), "utf8")) as FixtureInput;
    const expected = JSON.parse(readFileSync(join(goldenDir, "p1-explanation-c.expected.json"), "utf8")) as {
      readonly templateVersion: string;
      readonly claims: readonly NormalizedClaim[];
    };
    const { explanation, signals } = render110(fixture);
    expect(explanation.templateVersion as string).toBe("1.1.0");
    expect(expected.templateVersion).toBe("1.1.0");
    // The storage-write signal stays scored but renders no claim.
    expect(explanation.claims.length).toBe(4);
    const actual = normalizedClaims(explanation, signals);
    const wanted = expected.claims.slice().sort((left, right) => {
      if (left.text < right.text) {
        return -1;
      }
      if (left.text > right.text) {
        return 1;
      }
      return 0;
    });
    expect(actual).toEqual(wanted);
  });

  test("p1_110_golden_d_merges_two_signals_with_one_id", () => {
    const fixture = JSON.parse(readFileSync(join(goldenDir, "p1-explanation-d.input.json"), "utf8")) as FixtureInput;
    const expected = JSON.parse(readFileSync(join(goldenDir, "p1-explanation-d.expected.json"), "utf8")) as {
      readonly templateVersion: string;
      readonly claims: readonly NormalizedClaim[];
    };
    const { explanation, signals } = render110(fixture);
    expect(signals[0]?.id).toBe(signals[1]?.id);
    expect(explanation.claims.length).toBe(1);
    expect(normalizedClaims(explanation, signals)).toEqual(expected.claims);
  });

  test("p1_weth_shaped_payout_plus_store_states_no_block_or_favor", () => {
    const code = fixtureCode();
    const changer = mustOk(Address.parse(testChanger()));
    // A payout CALL plus an SSTORE with no caller guard: the call stays a
    // neutral call sentence and the store stays silent.
    const call = mustOk(
      Signal.createCapability({
        codeHash: mustOk(CodeHash.of(code)),
        risk: "honeypot",
        direction: "raises",
        severity: "medium",
        temporality: { kind: "can-change", changer },
        evidence: [
          mustOk(Evidence.create({ selector: mustOk(Selector.parse("0x2e1a7d4d")), offset: mustOk(PcOffset.of(30, code)) })),
        ],
      }),
    );
    const store = mustOk(
      Signal.createCapability({
        codeHash: mustOk(CodeHash.of(code)),
        risk: "bot-pump",
        direction: "raises",
        severity: "low",
        temporality: { kind: "can-change-unknown" },
        evidence: [
          mustOk(Evidence.create({ selector: mustOk(Selector.parse("0x70a08231")), offset: mustOk(PcOffset.of(64, code)) })),
        ],
      }),
    );
    const signals = [call, store];
    const explanation = mustOk(
      renderExplanation({
        signals,
        templateVersion: TEMPLATE_VERSION_1_1_0,
        observed: { kind: "can-change-unknown" },
        origins: new Map<string, ExplanationOrigin>([
          [call.id as string, { pluginId: "dev.brandklipparen.capability", key: "call" }],
          [store.id as string, { pluginId: "dev.brandklipparen.capability", key: "storage-write" }],
        ]),
      }),
    );
    expect(explanation.claims.length).toBe(1);
    const text = explanation.claims[0]?.text ?? "";
    expect(text).not.toContain("block a withdrawal");
    expect(text).not.toContain("favor one trade");
    expect(text.startsWith("The contract can call other contracts or send ETH")).toBe(true);
  });

  test("p1_one_sentence_per_origin", () => {
    const code = fixtureCode();
    const cases: ReadonlyArray<{ readonly key: string; readonly first: string }> = [
      { key: "blacklist", first: "The owner can stop chosen wallets from sending tokens." },
      { key: "pause", first: "The owner can freeze all transfers." },
      { key: "mint", first: "The owner can create new tokens." },
      { key: "transfer-fee", first: "The owner can change the fee taken on each transfer." },
      { key: "transfer-limits", first: "The owner can cap how much a wallet may send or hold." },
      { key: "sell-block", first: "Transfers to the trading pair can be blocked." },
      { key: "transfer-hooks", first: "Each transfer can call an outside contract the owner set." },
      { key: "proxy-upgrade", first: "The admin can replace the contract's code." },
      { key: "ownership", first: "An owner account controls the functions below." },
      { key: "owner-slot", first: "An owner account controls the functions below." },
      { key: "renounce", first: "The owner can give up ownership." },
      { key: "selfdestruct", first: "The contract can destroy itself and redirect funds." },
      { key: "delegatecall", first: "The contract can run foreign code in local storage context." },
      { key: "call", first: "The contract can call other contracts or send ETH (in `transfer(address,uint256)`)." },
    ];
    for (const { key, first } of cases) {
      const { signal, origins } = capabilitySignal(code, "0xa9059cbb", 11, {
        pluginId: "dev.brandklipparen.test",
        key,
      });
      const explanation = mustOk(
        renderExplanation({
          signals: [signal],
          templateVersion: TEMPLATE_VERSION_1_1_0,
          observed: { kind: "can-change-unknown" },
          origins,
        }),
      );
      expect(explanation.claims.length).toBe(1);
      const text = explanation.claims[0]?.text ?? "";
      expect(text.startsWith(`${first} This raises the rug-pull risk (severity high).`)).toBe(true);
    }
  });

  test("p1_storage_write_renders_no_claim", () => {
    const code = fixtureCode();
    const { signal, origins } = capabilitySignal(code, "0x70a08231", 64, {
      pluginId: "dev.brandklipparen.capability",
      key: "storage-write",
    });
    const explanation = mustOk(
      renderExplanation({
        signals: [signal],
        templateVersion: TEMPLATE_VERSION_1_1_0,
        observed: { kind: "can-change-unknown" },
        origins,
      }),
    );
    expect(explanation.claims).toEqual([]);
  });

  test("p1_100_ignores_origins_bit_identical", () => {
    const fixture = JSON.parse(
      readFileSync(join(goldenDir, "k301-explanation-a.input.json"), "utf8"),
    ) as FixtureInput;
    const code = fixtureCode();
    const signals = fixture.signals.map((entry) => mustOk(buildSignal(code, entry)));
    const origins = buildOrigins(signals, {
      "0": { pluginId: "dev.brandklipparen.mint", key: "mint" },
      "1": { pluginId: "dev.brandklipparen.blacklist", key: "blacklist" },
    });
    const without = mustOk(
      renderExplanation({
        signals,
        templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
        observed: fixture.observed,
      }),
    );
    const withOrigins = mustOk(
      renderExplanation({
        signals,
        templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
        observed: fixture.observed,
        origins,
      }),
    );
    expect(canonicalSerialize(explanationToCanonical(withOrigins))).toBe(
      canonicalSerialize(explanationToCanonical(without)),
    );
  });

  test("p1_display_only_score_probabilities_signals_identical", () => {
    const artifact = testArtifact();
    for (const name of [
      "k301-explanation-a.input.json",
      "k301-explanation-b.input.json",
      "p1-explanation-c.input.json",
      "p1-explanation-d.input.json",
    ]) {
      const fixture = JSON.parse(readFileSync(join(goldenDir, name), "utf8")) as FixtureInput;
      const code = fixtureCode();
      const signals = fixture.signals.map((entry) => mustOk(buildSignal(code, entry)));
      const before = JSON.stringify(signals);
      const origins = buildOrigins(signals, fixture.origins);
      const first = mustOk(
        renderExplanation({
          signals,
          templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
          observed: fixture.observed,
        }),
      );
      const second = mustOk(
        renderExplanation({
          signals,
          templateVersion: TEMPLATE_VERSION_1_1_0,
          observed: fixture.observed,
          origins,
        }),
      );
      // Rendering never mutates the signal list.
      expect(JSON.stringify(signals)).toBe(before);
      expect(first.templateVersion as string).toBe("1.0.0");
      expect(second.templateVersion as string).toBe("1.1.0");
      // Score, probabilities and the signal list do not move with the
      // template version: both renders read the same frozen signals.
      const risk = score(signals, artifact);
      expect(JSON.parse(JSON.stringify(risk))).toEqual(JSON.parse(JSON.stringify(score(signals, artifact))));
      expect(risk.probabilities).toEqual(score(signals, artifact).probabilities);
      expect(risk.score).toBe(score(signals, artifact).score);
    }
  });

  test("p1_applies_now_marker_keeps_measured_value", () => {
    const code = fixtureCode();
    const signal = mustOk(
      Signal.createCapability({
        codeHash: mustOk(CodeHash.of(code)),
        risk: "rug-pull",
        direction: "raises",
        severity: "high",
        evidence: [
          mustOk(
            Evidence.create({
              selector: mustOk(Selector.parse("0xa9059cbb")),
              offset: mustOk(PcOffset.of(11, code)),
            }),
          ),
        ],
        temporality: {
          kind: "applies-now",
          measuredValue: {
            value: mustOk(StorageWord.parse(`0x${"00".repeat(31)}01`)),
            slot: mustOk(Slot.parse(`0x${"00".repeat(32)}`)),
            block: mustOk(BlockNumber.of(18000000)),
            at: mustOk(Timestamp.of(1700000000000)),
          },
          block: mustOk(BlockNumber.of(18000000)),
          at: mustOk(Timestamp.of(1700000000000)),
        },
      }),
    );
    const explanation = mustOk(
      renderExplanation({
        signals: [signal],
        templateVersion: TEMPLATE_VERSION_1_1_0,
        observed: { kind: "can-change-unknown" },
        origins: new Map<string, ExplanationOrigin>([
          [signal.id as string, { pluginId: "dev.brandklipparen.mint", key: "mint" }],
        ]),
      }),
    );
    expect(explanation.claims.length).toBe(1);
    expect(explanation.claims[0]?.temporality.kind).toBe("applies-now");
    expect(explanation.claims[0]?.text).toContain("The owner can create new tokens.");
    expect(explanation.claims[0]?.text).toContain("Holds now");
  });
});
