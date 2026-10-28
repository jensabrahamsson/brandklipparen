// Fake decompiler naming adapter (S-083, D-11). Test-only: canned
// suggested names per selector, a `not-configured` mode proving the
// opt-in gate sends nothing, and an `invalid-output` mode proving the
// consumer discards unparsable model output. Every call is logged so
// tests assert zero provider calls on the fallback paths.
import type {
  DecompilerNamingOutcome,
  DecompilerNamingPort,
} from "../../src/ports/decompilerNaming.ts";

export type FakeNamingMode = "ok" | "not-configured" | "invalid-output";

export class FakeDecompilerNamingAdapter implements DecompilerNamingPort {
  readonly calls: string[][] = [];
  private readonly mode: FakeNamingMode;
  private readonly canned: ReadonlyMap<string, string>;

  constructor(mode: FakeNamingMode = "ok", canned: ReadonlyMap<string, string> = new Map()) {
    this.mode = mode;
    this.canned = canned;
  }

  async suggestNames(selectors: readonly string[]): Promise<DecompilerNamingOutcome> {
    this.calls.push([...selectors]);
    if (this.mode === "not-configured") {
      return Object.freeze({ kind: "not-configured" });
    }
    if (this.mode === "invalid-output") {
      return Object.freeze({ kind: "invalid-output" });
    }
    const names = selectors.map((selector) => ({
      selector,
      suggestedName: this.canned.get(selector) ?? `handle_${selector.slice(2, 6)}`,
    }));
    return Object.freeze({ kind: "ok", names: Object.freeze(names) });
  }
}
