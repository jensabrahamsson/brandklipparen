// Fake chat model adapter (S-096). Test-only: canned outcomes per mode
// with a call log so tests assert zero provider calls on the fallback
// paths. The `mixed` mode builds its answers from the request's collected
// ids (one cited hit, one uncollected citation, one uncited answer), so
// the citation check runs against real frozen-analysis ids. Never touches
// the network, the clock or the filesystem.
import type { ChatInput, ChatModelOutcome, ChatModelPort } from "../../src/ports/chatModel.ts";

export type FakeChatMode = "ok" | "mixed" | "not-configured" | "invalid-output";

export class FakeChatModelAdapter implements ChatModelPort {
  readonly calls: ChatInput[] = [];
  private readonly mode: FakeChatMode;

  constructor(mode: FakeChatMode = "ok") {
    this.mode = mode;
  }

  provider(): string {
    return "test-adapter";
  }

  modelId(): string {
    return "test-chat-1";
  }

  async chat(input: ChatInput): Promise<ChatModelOutcome> {
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
        answers: Object.freeze([
          Object.freeze({ text: "The analysis reports a capability.", citations: Object.freeze([first]) }),
          Object.freeze({ text: "An uncited answer states intent.", citations: Object.freeze([]) }),
          Object.freeze({ text: "An answer cites an uncollected id.", citations: Object.freeze(["signal:no-such-signal"]) }),
        ]),
      });
    }
    const first = input.evidenceIds[0] ?? "signal:absent";
    return Object.freeze({
      kind: "ok",
      answers: Object.freeze([
        Object.freeze({ text: "The analysis reports a capability.", citations: Object.freeze([first]) }),
      ]),
    });
  }
}
