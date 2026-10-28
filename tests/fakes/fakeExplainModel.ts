// Fake explain model adapter (S-094). Test-only: canned outcomes per mode
// with a call log so tests assert zero provider calls on the fallback
// paths. The `mixed` mode builds its sentences from the request's collected
// ids (one cited hit, one uncollected citation, one uncited sentence), so
// the citation check runs against real frozen-analysis ids. Never touches
// the network, the clock or the filesystem.
import type { ExplainInput, ExplainModelOutcome, ExplainModelPort } from "../../src/ports/explainModel.ts";

export type FakeExplainMode = "ok" | "mixed" | "not-configured" | "invalid-output";

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
    const first = input.evidenceIds[0] ?? "signal:absent";
    return Object.freeze({
      kind: "ok",
      sentences: Object.freeze([
        Object.freeze({ text: "The analysis reports a capability.", citations: Object.freeze([first]) }),
      ]),
    });
  }
}
