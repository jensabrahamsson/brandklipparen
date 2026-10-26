// K-301 golden test (S-023): the same evidence and the same template
// version give bit-identical explanation text. Fixture inputs under
// tests/fixtures/golden are frozen synthetic values only (no real contract
// bytecode) and expected outputs are reviewed bytes: tests read them and
// never regenerate them.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { CodeSnippet, Evidence } from "../../src/domain/evidence.ts";
import { explanationToCanonical, renderExplanation } from "../../src/domain/explain.ts";
import { canonicalSerialize } from "../../src/domain/serialize.ts";
import { Signal } from "../../src/domain/signals.ts";
import type { Signal as SignalType, Temporality } from "../../src/domain/signals.ts";
import {
  Bytecode,
  CloneGroupId,
  CodeHash,
  PcOffset,
  Probability,
  Selector,
  TemplateVersion,
} from "../../src/domain/types.ts";
import type { Result } from "../../src/domain/result.ts";
import type {
  Bytecode as BytecodeType,
  DomainError,
} from "../../src/domain/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, "..", "fixtures", "golden");

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
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
};

// Fixed synthetic bytecode (512 zero bytes) backing every golden fixture: it
// keeps each fixture offset derivable and the code hash stable. No real
// contract bytecode is committed.
function fixtureCode(): BytecodeType {
  return mustOk(Bytecode.parse(`0x${"00".repeat(512)}`));
}

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

function listK301Inputs(): string[] {
  return readdirSync(goldenDir)
    .filter((name) => name.startsWith("k301-explanation-") && name.endsWith(".input.json"))
    .sort();
}

describe("k301 golden explanation fixtures", () => {
  test("k301_template_text_bit_identical_from_evidence", () => {
    const inputs = listK301Inputs();
    expect(inputs.length).toBeGreaterThan(0);
    const code = fixtureCode();
    for (const name of inputs) {
      const raw = readFileSync(join(goldenDir, name), "utf8");
      const fixture = JSON.parse(raw) as FixtureInput;
      const signals = fixture.signals.map((entry) => mustOk(buildSignal(code, entry)));
      const explanation = mustOk(
        renderExplanation({
          signals,
          templateVersion: mustOk(TemplateVersion.parse(fixture.templateVersion)),
          observed: fixture.observed,
        }),
      );
      const actual = Buffer.from(canonicalSerialize(explanationToCanonical(explanation)), "utf8");
      const expectedName = name.replace(/\.input\.json$/, ".expected.json");
      const expected = readFileSync(join(goldenDir, expectedName));
      expect(actual.equals(expected), `fixture ${name} differs`).toBe(true);
    }
  });
});
