// Internal decompiler adapter behind DecompilerPort (K-008, K-037,
// K-501, K-521). The only DecompilerPort adapter in the product: it runs
// the deterministic in-process ERC-20 pipeline (`decompilePreferV2`,
// decompiler v2 with the v1 evmSsa fallback) synchronously on the port
// input, with no child process, no binary path and no network. The
// engine is total: hostile input yields partial output, never an
// exception. Port-level byte caps bound input and output per A-17;
// anything the engine itself flags as structurally incomplete
// (unresolved jumps, dynamic control flow left labelled) is reported
// as `invalid-output`, so the hard-to-analyze signal now comes solely
// from the internal engine's own limits, never from an external tool
// failing. The `timeout` and `process-error` branches stay typed in
// the error union for port stability (fakes steer them in tests) but
// are unreachable in-process: nothing here reads a clock or spawns.
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import { CodeSnippet } from "../../domain/evidence.ts";
import { decompilePreferV2 } from "../../domain/decompileV2.ts";
import { DEFAULT_MAX_BYTECODE_BYTES, Selector } from "../../domain/types.ts";
import type {
  Bytecode as BytecodeType,
  CodeHash as CodeHashType,
} from "../../domain/types.ts";
import type {
  CallContext,
  DecompiledContract,
  DecompiledFunction,
  DecompilerError,
  DecompilerPort,
} from "../../ports/decompiler.ts";

// Default output cap for the rendered pseudo-Solidity (A-17): the
// engine's own statement and line caps already bound pathological
// input, so this is a backstop on the wire size only.
export const DEFAULT_INTERNAL_MAX_OUTPUT_BYTES = 1048576;

export type InternalDecompilerOptions = {
  readonly maxBytesIn?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
};

// One rendered function block (header plus body plus closing brace)
// sliced from the pipeline's own emission text, so emitter changes
// stay in sync by construction. Both the v2 and the v1 fallback
// render the same `/* selector 0x… */` header the slice searches
// for. Null when the block cannot be found, in which case the caller
// falls back to the bare signature line.
function functionBlockOf(text: string, selector: string): string | null {
  const lines = text.split("\n");
  const header = `/* selector ${selector} */`;
  const start = lines.findIndex((line) => line.includes(header));
  if (start === -1) {
    return null;
  }
  let end = start;
  while (end < lines.length && lines[end] !== "}") {
    end += 1;
  }
  if (end >= lines.length) {
    return null;
  }
  return lines.slice(start, end + 1).join("\n");
}

export class InternalDecompilerAdapter implements DecompilerPort {
  private readonly maxBytesIn: number;
  private readonly maxOutputBytes: number;

  constructor(options: InternalDecompilerOptions = {}) {
    const maxBytesIn = options.maxBytesIn ?? DEFAULT_MAX_BYTECODE_BYTES;
    this.maxBytesIn =
      Number.isSafeInteger(maxBytesIn) && maxBytesIn > 0 ? maxBytesIn : DEFAULT_MAX_BYTECODE_BYTES;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_INTERNAL_MAX_OUTPUT_BYTES;
    this.maxOutputBytes =
      Number.isSafeInteger(maxOutputBytes) && maxOutputBytes > 0
        ? maxOutputBytes
        : DEFAULT_INTERNAL_MAX_OUTPUT_BYTES;
  }

  decompile(
    bytecode: BytecodeType,
    codeHash: CodeHashType,
    ctx: CallContext,
  ): Promise<Result<DecompiledContract, DecompilerError>> {
    // The internal engine runs synchronously in-process: no deadline
    // applies and none is derived from the request context.
    void ctx;
    if (bytecode.length > this.maxBytesIn) {
      return Promise.resolve(
        err({
          kind: "resource-limit",
          message: `bytecode holds ${bytecode.length} bytes, above the input limit of ${this.maxBytesIn}`,
        }),
      );
    }
    let decompiled: ReturnType<typeof decompilePreferV2>;
    try {
      decompiled = decompilePreferV2(bytecode);
    } catch {
      return Promise.resolve(
        err({ kind: "invalid-output", message: "decompiler output failed on hostile input" }),
      );
    }
    const textBytes = Buffer.byteLength(decompiled.text, "utf8");
    if (textBytes > this.maxOutputBytes) {
      return Promise.resolve(
        err({
          kind: "output-too-large",
          message: `decompiled output exceeded the limit of ${this.maxOutputBytes} bytes`,
          limitBytes: this.maxOutputBytes,
        }),
      );
    }
    // Structurally incomplete output (K-521): the engine resolved only
    // what stack-value analysis proves and recorded every other dynamic
    // target as an unresolved jump, so a nonzero count means control
    // flow the pipeline labelled instead of read. The deepening reports
    // that as a failed decompilation rather than quoting a partial
    // map beside unattributed evidence.
    const labelledFlow = decompiled.functions.some((fn) => fn.cause === "unexpected-control-flow");
    if (decompiled.unresolvedJumps.length > 0 || labelledFlow) {
      const count = Math.max(decompiled.unresolvedJumps.length, labelledFlow ? 1 : 0);
      return Promise.resolve(
        err({
          kind: "invalid-output",
          message: `decompiler output leaves ${count} unresolved control-flow region(s), labelled not read`,
        }),
      );
    }
    const functions: DecompiledFunction[] = [];
    for (let index = 0; index < decompiled.functions.length; index += 1) {
      const fn = decompiled.functions[index];
      if (fn === undefined) {
        continue;
      }
      const selector = Selector.parse(fn.selector);
      if (!selector.ok) {
        return Promise.resolve(
          err({ kind: "invalid-output", message: "decompiler output holds no valid selector" }),
        );
      }
      const block = functionBlockOf(decompiled.text, fn.selector);
      const snippet = CodeSnippet.create({
        text: block ?? fn.signature ?? `${fn.name}()`,
        line: index,
        selector: selector.value,
      });
      if (!snippet.ok) {
        return Promise.resolve(
          err({ kind: "invalid-output", message: "decompiler output holds a snippet the core turns away" }),
        );
      }
      functions.push(Object.freeze({ selector: selector.value, snippet: snippet.value }));
    }
    return Promise.resolve(ok(Object.freeze({ codeHash, functions: Object.freeze(functions) })));
  }
}
