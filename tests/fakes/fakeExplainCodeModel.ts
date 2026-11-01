// Fake explain-code model adapter (VS-B3). Test-only: canned outcomes
// per mode with a call log so tests assert zero provider calls on the
// fallback paths. The `mixed` mode builds its entries from the request's
// frozen lines and collected ids (one clean note, one note citing an
// unknown line, one note citing uncollected evidence, one uncited note,
// one meta-statement), so the line and citation check runs against real
// frozen code. Never touches the network, the clock or the filesystem.
import type {
  ExplainCodeInput,
  ExplainCodeModelOutcome,
  ExplainCodeModelPort,
} from "../../src/ports/explainCodeModel.ts";

export type FakeExplainCodeMode = "ok" | "mixed" | "not-configured" | "invalid-output";

export class FakeExplainCodeModelAdapter implements ExplainCodeModelPort {
  readonly calls: ExplainCodeInput[] = [];
  private readonly mode: FakeExplainCodeMode;

  constructor(mode: FakeExplainCodeMode = "ok") {
    this.mode = mode;
  }

  provider(): string {
    return "test-adapter";
  }

  modelId(): string {
    return "test-explain-code-1";
  }

  async explainCode(input: ExplainCodeInput): Promise<ExplainCodeModelOutcome> {
    this.calls.push(input);
    if (this.mode === "not-configured") {
      return Object.freeze({ kind: "not-configured" });
    }
    if (this.mode === "invalid-output") {
      return Object.freeze({ kind: "invalid-output" });
    }
    const first = input.evidenceIds[0] ?? "signal:absent";
    if (this.mode === "mixed") {
      return Object.freeze({
        kind: "ok",
        summary: Object.freeze([
          Object.freeze({ text: "This function moves tokens.", cites: Object.freeze(["line:2", first]) }),
          Object.freeze({ text: "A summary cites uncollected evidence.", cites: Object.freeze(["signal:no-such-signal"]) }),
          Object.freeze({ text: "Grounded in the frozen evidence list.", cites: Object.freeze(["line:1"]) }),
        ]),
        notes: Object.freeze([
          Object.freeze({ lines: Object.freeze([2]), text: "The transfer happens here.", cites: Object.freeze(["line:2"]) }),
          Object.freeze({ lines: Object.freeze([9999]), text: "A note cites a line that is not there.", cites: Object.freeze(["line:9999"]) }),
          Object.freeze({ lines: Object.freeze([1]), text: "A note cites uncollected evidence.", cites: Object.freeze(["signal:no-such-signal"]) }),
        ]),
      });
    }
    // The ok mode cites sent lines only, so the route tests stay
    // deterministic whatever the frozen analysis reports for the selector.
    return Object.freeze({
      kind: "ok",
      summary: Object.freeze([
        Object.freeze({ text: "This function moves tokens.", cites: Object.freeze(["line:2"]) }),
      ]),
      notes: Object.freeze([
        Object.freeze({ lines: Object.freeze([2, 3]), text: "The transfer happens here.", cites: Object.freeze(["line:2"]) }),
      ]),
    });
  }
}
