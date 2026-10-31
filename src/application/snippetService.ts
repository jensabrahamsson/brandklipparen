// Snippet deepening per selector (S-095, K-008, K-010). Pure application
// helper over the local decompiler pipeline: given frozen bytecode and a
// dispatcher selector, it quotes the pipeline's rendered source block for
// that selector as numbered lines. The fast-path dispatcher scan
// (`extractSelectors`) gates unknown selectors before the heavier
// decompilation runs, so an unknown selector never spends a pipeline call.
// Malformed selectors fail the same way. Quoted lines are sliced from the
// pipeline's own emission text, so emitter changes stay in sync by
// construction. Scores and evidence are untouched: this helper reads
// bytecode and returns display text only.
import { decompilePreferV2 } from "../domain/decompileV2.ts";
import type { DecompiledContract } from "../domain/evmSsa.ts";
import { extractSelectors } from "../domain/selectors.ts";
import type { Bytecode as BytecodeType } from "../domain/types.ts";

export type SnippetLine = {
  readonly selector: string;
  readonly lineNumber: number;
  readonly text: string;
};

export type Snippet = {
  readonly selector: string;
  readonly entryPc: number;
  readonly lines: readonly SnippetLine[];
};

export type SnippetError = "invalid-selector" | "unknown-selector" | "selector-not-decompiled";

export type SnippetDecompile = (bytecode: BytecodeType) => DecompiledContract;

export function snippetForSelector(
  bytecode: BytecodeType,
  selector: string,
  decompile: SnippetDecompile = decompilePreferV2,
): { ok: true; value: Snippet } | { ok: false; error: SnippetError } {
  if (!/^0x[0-9a-fA-F]{8}$/.test(selector)) {
    return { ok: false, error: "invalid-selector" };
  }
  const wanted = selector.toLowerCase();
  const known = extractSelectors(bytecode).some((entry) => entry.selector.toLowerCase() === wanted);
  if (!known) {
    return { ok: false, error: "unknown-selector" };
  }
  const decompiled = decompile(bytecode);
  const fn = decompiled.functions.find((entry) => entry.selector.toLowerCase() === wanted);
  if (fn === undefined) {
    return { ok: false, error: "selector-not-decompiled" };
  }
  const lines = decompiled.text.split("\n");
  const header = `/* selector ${fn.selector} */`;
  const start = lines.findIndex((line) => line.includes(header));
  if (start === -1) {
    return { ok: false, error: "selector-not-decompiled" };
  }
  let end = start;
  while (end < lines.length && lines[end] !== "}") {
    end += 1;
  }
  if (end >= lines.length) {
    return { ok: false, error: "selector-not-decompiled" };
  }
  const quoted: SnippetLine[] = [];
  for (const [index, text] of lines.slice(start, end + 1).entries()) {
    quoted.push(Object.freeze({ selector: fn.selector, lineNumber: index + 1, text }));
  }
  return {
    ok: true,
    value: Object.freeze({ selector: fn.selector, entryPc: fn.entryPc, lines: Object.freeze(quoted) }),
  };
}
