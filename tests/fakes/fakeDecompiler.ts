// Deterministic in-memory fake for DecompilerPort (A-23, K-008, K-501).
// Test-only adapter with no processes, no clock and no randomness: every
// scenario returns the same canned outcome for the same input. The canned
// success output links one function per dispatcher selector found in the
// input bytecode, so the contract suite proves selector linkage without a
// worker process. Call count stays observable, so tests verify the
// deepening ran exactly once per analysis.
import { err, ok } from "../../src/domain/result.ts";
import type { Result } from "../../src/domain/result.ts";
import { CodeSnippet } from "../../src/domain/evidence.ts";
import { extractSelectors } from "../../src/domain/selectors.ts";
import type {
  Bytecode as BytecodeType,
  CodeHash as CodeHashType,
  Selector as SelectorType,
} from "../../src/domain/types.ts";
import type {
  DecompiledContract,
  DecompiledFunction,
  DecompilerError,
  DecompilerPort,
} from "../../src/ports/decompiler.ts";
import type { DecompilerContractScenario } from "../contract/decompiler.contract.ts";

export type FakeDecompilerOptions = {
  readonly scenario?: DecompilerContractScenario | undefined;
};

// Placeholder snippet text and output cap for tests only (K-210): the
// values carry no learned meaning and never leave the test layer.
const PLACEHOLDER_SNIPPET_TEXT = "Placeholder decompiled snippet for tests only.";
const PLACEHOLDER_OUTPUT_LIMIT_BYTES = 1024;

export class FakeDecompilerAdapter implements DecompilerPort {
  private scenario: DecompilerContractScenario;
  private calls = 0;

  constructor(options: FakeDecompilerOptions = {}) {
    this.scenario = options.scenario ?? "success";
  }

  setScenario(scenario: DecompilerContractScenario): void {
    this.scenario = scenario;
  }

  get callCount(): number {
    return this.calls;
  }

  reset(): void {
    this.calls = 0;
  }

  async decompile(
    bytecode: BytecodeType,
    codeHash: CodeHashType,
  ): Promise<Result<DecompiledContract, DecompilerError>> {
    this.calls += 1;
    switch (this.scenario) {
      case "timeout":
        return err({ kind: "timeout", message: "fake decompiler timed out" });
      case "resource-limit":
        return err({ kind: "resource-limit", message: "fake decompiler hit its resource limit" });
      case "process-error":
        return err({ kind: "process-error", message: "fake decompiler worker failed" });
      case "invalid-output":
        return err({ kind: "invalid-output", message: "fake decompiler output failed validation" });
      case "output-too-large":
        return err({
          kind: "output-too-large",
          message: "fake decompiler output exceeded its size limit",
          limitBytes: PLACEHOLDER_OUTPUT_LIMIT_BYTES,
        });
      case "success":
        return ok(this.canned(bytecode, codeHash));
    }
  }

  private canned(bytecode: BytecodeType, codeHash: CodeHashType): DecompiledContract {
    const functions: DecompiledFunction[] = [];
    const entries = extractSelectors(bytecode);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry === undefined) {
        continue;
      }
      const created = snippetFor(entry.selector, index);
      if (created !== null) {
        functions.push(Object.freeze({ selector: entry.selector, snippet: created }));
      }
    }
    return Object.freeze({ codeHash, functions: Object.freeze(functions) });
  }
}

function snippetFor(selector: SelectorType, line: number) {
  const created = CodeSnippet.create({ text: PLACEHOLDER_SNIPPET_TEXT, line, selector });
  if (!created.ok) {
    return null;
  }
  return created.value;
}
