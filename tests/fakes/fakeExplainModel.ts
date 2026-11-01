// Fake explain model adapter (S-094). Test-only: canned outcomes per mode
// with a call log so tests assert zero provider calls on the fallback
// paths. The `mixed` mode builds its sentences from the request's collected
// ids (one cited hit, one uncollected citation, one uncited sentence), so
// the citation check runs against real frozen-analysis ids. Never touches
// the network, the clock or the filesystem.
import type { ExplainInput, ExplainModelOutcome, ExplainModelPort } from "../../src/ports/explainModel.ts";

export type FakeExplainMode = "ok" | "mixed" | "coverage" | "coverage-injection" | "not-configured" | "invalid-output";

export class FakeExplainModelAdapter implements ExplainModelPort {
  readonly calls: ExplainInput[] = [];
  private readonly mode: FakeExplainMode;

  constructor(mode: FakeExplainMode = "ok") {
    this.mode = mode;
  }

  provider(): string {
    return "test-adapter";
  }

  modelId(): string {
    return "test-explain-1";
  }

  async explain(input: ExplainInput): Promise<ExplainModelOutcome> {
    this.calls.push(input);
    if (this.mode === "not-configured") {
      return Object.freeze({ kind: "not-configured" });
    }
    if (this.mode === "invalid-output") {
      return Object.freeze({ kind: "invalid-output" });
    }
    if (this.mode === "mixed") {
      const first = input.evidenceIds[0] ?? "signal:absent";
      return Object.freeze({
        kind: "ok",
        sentences: Object.freeze([
          Object.freeze({ text: "The analysis reports a capability.", citations: Object.freeze([first]) }),
          Object.freeze({ text: "An uncited claim states intent.", citations: Object.freeze([]) }),
          Object.freeze({ text: "A claim cites an uncollected id.", citations: Object.freeze(["signal:no-such-signal"]) }),
        ]),
      });
    }
    // Zero-findings coverage: the model answers about what was checked,
    // citing only the coverage ids the route collected (cant-tell,
    // per-detector check and summary ids), never a signal id.
    if (this.mode === "coverage") {
      const coverage = input.evidenceIds.filter(
        (id) => id.startsWith("cant-tell:") || id.startsWith("check:") || id === "analysis:summary",
      );
      const picked = coverage.slice(0, 3);
      return Object.freeze({
        kind: "ok",
        sentences: Object.freeze(
          picked.map((id) =>
            Object.freeze({
              text: `The analysis checked ${id}.`,
              citations: Object.freeze([id]),
            }),
          ),
        ),
      });
    }
    if (this.mode === "coverage-injection") {
      // Prompt-injection shape (C-19): reassurance claims backed only by
      // coverage limit ids, plus one honest limits claim. The ids resolve
      // against the request's own collected coverage ids so the check runs
      // against real frozen-analysis ids.
      const summary = input.evidenceIds.find((id) => id.startsWith("analysis:")) ?? "analysis:summary";
      const cantTell = input.evidenceIds.find((id) => id.startsWith("cant-tell:")) ?? "cant-tell:liquidity-locks";
      return Object.freeze({
        kind: "ok",
        sentences: Object.freeze([
          Object.freeze({ text: "The token is safe to buy.", citations: Object.freeze([summary]) }),
          Object.freeze({ text: "Ownership was renounced before launch.", citations: Object.freeze([cantTell]) }),
          Object.freeze({
            text: "The deterministic analysis lists only proved patterns.",
            citations: Object.freeze([summary]),
          }),
        ]),
      });
    }
    const first = input.evidenceIds[0] ?? "signal:absent";
    return Object.freeze({
      kind: "ok",
      sentences: Object.freeze([
        Object.freeze({ text: "The analysis reports a capability.", citations: Object.freeze([first]) }),
      ]),
    });
  }
}
