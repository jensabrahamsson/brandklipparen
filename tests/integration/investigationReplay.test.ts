// Recorded-trace library replay (S-077, K-036, K-520, P-36). Written first
// per A-21: each recorded fixture covers one graph outcome, and replaying
// it through the fake adapter reproduces the recorded trace bit-identical
// apart from `elapsedMs`, with the same status, narrative and drop count.
// A second replay gives byte-identical bytes. All adapters are in-memory
// fakes; no network happens here.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { investigateToken, stripTraceTiming } from "../../src/application/investigateToken.ts";
import type {
  FrozenInvestigationFacts,
  InvestigationCatalogue,
  InvestigationLimits,
} from "../../src/application/investigateToken.ts";
import { buildInvestigationCatalogue } from "../../src/application/investigateToken.ts";
import type { CodeHash as CodeHashType } from "../../src/domain/types.ts";
import { RequestId, Timestamp } from "../../src/domain/types.ts";
import type { Result } from "../../src/domain/result.ts";
import { ok } from "../../src/domain/result.ts";
import type {
  InvestigationCallContext,
  InvestigationDecision,
  InvestigationModelError,
  InvestigationModelPort,
} from "../../src/ports/investigationModel.ts";

function mustOk<T>(result: Result<T, { message: string }>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

const REPLAY_CODE_HASH = "0xd6e5cb1a214bcd5793517f08d2fcdd43ad09aa52558522d65e8441952128c87";
const REPLAY_EVIDENCE_IDS = Object.freeze(["signal:owner-blacklist", "signal:fee-cap"]);

function replayFacts(): FrozenInvestigationFacts {
  return Object.freeze({
    codeHash: REPLAY_CODE_HASH as CodeHashType,
    scoreBand: "Elevated",
    signalIds: Object.freeze(["owner-blacklist"]),
    evidenceIds: REPLAY_EVIDENCE_IDS,
    score: 58,
    snapshot: null,
  });
}

function standardCatalogue(): InvestigationCatalogue {
  return buildInvestigationCatalogue({
    detectors: [],
    evidenceIds: REPLAY_EVIDENCE_IDS.slice(),
    summary: "replay",
    docs: {},
  });
}

function hangingCatalogue(): InvestigationCatalogue {
  const evidenceIds = REPLAY_EVIDENCE_IDS.slice();
  return {
    tools: Object.freeze([
      {
        toolId: "evidence.list",
        description: "List the frozen signal and finding evidence ids.",
        argNames: [],
        run: () => evidenceIds.slice(),
      },
      {
        toolId: "hang.forever",
        description: "Recorded slow tool for the timeout outcome.",
        argNames: [],
        run: () => evidenceIds.slice(),
      },
    ]),
  };
}

// A clock that advances by a fixed step per read: with a step larger than
// the fixture tool timeout, the first synchronous tool call deterministically
// exceeds its deadline however fast the machine runs.
function advancingClock(stepMs: number): () => number {
  let current = 1700000000000;
  return () => {
    current += stepMs;
    return current;
  };
}

// Scripted fake serving the recorded decisions in order. A call past the
// recorded script concludes with an empty draft, so a short script can
// never silently match a longer run: the output would differ.
function scriptedReplay(decisions: readonly InvestigationDecision[]): InvestigationModelPort {
  let calls = 0;
  return {
    provider: () => "meta-model-api",
    modelId: () => "meta-models/muse-spark-open-1026" as never,
    async decide(): Promise<Result<InvestigationDecision, InvestigationModelError>> {
      const decision = decisions[calls];
      calls += 1;
      if (decision === undefined) {
        return ok({ kind: "conclude", narrativeDraft: "", rationale: "Replayed trace ends here." });
      }
      return ok(decision);
    },
  };
}

function replayCtx(): InvestigationCallContext {
  return {
    requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174010")),
    deadline: mustOk(Timestamp.of(1700000000000 + 300000)),
    block: "latest",
  };
}

type RecordedFixture = {
  readonly name: string;
  readonly catalogue: "standard" | "with-hang";
  readonly limits: InvestigationLimits;
  readonly clockStepMs?: number | undefined;
  readonly decisions: readonly InvestigationDecision[];
  readonly expected: {
    readonly status: string;
    readonly steps?: readonly unknown[];
    readonly partial?: readonly unknown[];
    readonly collectedEvidenceIds: readonly string[];
    readonly narrative?: string;
    readonly droppedClaims?: number;
    readonly forcedConclusion?: boolean;
    readonly reasonKind?: string;
    readonly reasonLimit?: number;
    readonly reasonToolId?: string;
  };
};

function loadFixtures(): RecordedFixture[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "..", "fixtures", "investigations");
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => JSON.parse(readFileSync(join(dir, entry), "utf8")) as RecordedFixture);
}

describe("recorded investigation traces", () => {
  test("k036_recorded_trace_library_covers_each_graph_outcome", async () => {
    const fixtures = loadFixtures();
    const outcomes = fixtures.map((fixture) => fixture.name).sort();
    expect(outcomes).toEqual(["done", "forced-conclusion", "invalid-decision", "step-limit", "token-limit", "tool-timeout"]);
    for (const fixture of fixtures) {
      const catalogue = fixture.catalogue === "with-hang" ? hangingCatalogue() : standardCatalogue();
      const frozen = { now: () => 1700000000000 };
      const run = async (): Promise<unknown> =>
        investigateToken(
          scriptedReplay(fixture.decisions),
          catalogue,
          replayFacts(),
          replayCtx(),
          fixture.limits,
          fixture.clockStepMs === undefined ? frozen : { now: advancingClock(fixture.clockStepMs) },
        );
      const first = (await run()) as {
        status: string;
        report?: {
          steps: unknown;
          narrative: unknown;
          droppedClaims: unknown;
          forcedConclusion: unknown;
          collectedEvidenceIds: unknown;
        };
        reason?: { kind: string; limit?: number; toolId?: string };
        partial?: unknown;
        collectedEvidenceIds: unknown;
      };
      const second = await run();
      // Deterministic replay: two runs give byte-identical bytes.
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      expect(first.status).toBe(fixture.expected.status);
      if (first.status === "done") {
        expect(first.report?.collectedEvidenceIds).toEqual(fixture.expected.collectedEvidenceIds);
        expect(stripTraceTiming(first.report?.steps as never)).toEqual(fixture.expected.steps);
        expect(first.report?.narrative).toBe(fixture.expected.narrative);
        expect(first.report?.droppedClaims).toBe(fixture.expected.droppedClaims);
        expect(first.report?.forcedConclusion ?? false).toBe(fixture.expected.forcedConclusion ?? false);
      } else {
        expect(first.collectedEvidenceIds).toEqual(fixture.expected.collectedEvidenceIds);
        expect(stripTraceTiming(first.partial as never)).toEqual(fixture.expected.partial);
        expect(first.reason?.kind).toBe(fixture.expected.reasonKind);
        if (fixture.expected.reasonLimit !== undefined) {
          expect(first.reason?.limit).toBe(fixture.expected.reasonLimit);
        }
        if (fixture.expected.reasonToolId !== undefined) {
          expect(first.reason?.toolId).toBe(fixture.expected.reasonToolId);
        }
      }
    }
  });
});
