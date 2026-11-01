// DecompilerPort: decompilation of bytecode into functions and snippets
// (A-05, K-008, K-501). The port is owned by the core: the application
// calls decompile in the deepening and links each returned function to the
// signals' evidence by selector. The only adapter behind this port is the
// internal engine (`src/adapters/decompiler/`, decompiler v2
// with the v1 fallback); no external binary, worker, or download
// exists on this path. Error branches follow the catalogue in A-15;
// every branch yields the hard-to-analyze signal in the deepening while
// the fast path's response stands.
import type { Result } from "../domain/result.ts";
import type { CodeSnippet } from "../domain/evidence.ts";
import type {
  BlockNumber as BlockNumberType,
  Bytecode as BytecodeType,
  CodeHash as CodeHashType,
  RequestId as RequestIdType,
  Selector as SelectorType,
  Timestamp as TimestampType,
} from "../domain/types.ts";

// Correlation id, absolute deadline and block context per A-05.
export type CallContext = {
  readonly requestId: RequestIdType;
  readonly deadline: TimestampType;
  readonly block: BlockNumberType | "latest";
};

// One decompiled function linked to its dispatcher selector. The snippet
// text is quoted untrusted data at the boundary; the size cap is enforced
// by the internal adapter under its port limits, so the core checks shape
// only through CodeSnippet.create.
export type DecompiledFunction = {
  readonly selector: SelectorType;
  readonly snippet: CodeSnippet;
};

// Decompiled contract beside the code hash it was derived from, so the
// application binds the output to the analysed input (K-102).
export type DecompiledContract = {
  readonly codeHash: CodeHashType;
  readonly functions: readonly DecompiledFunction[];
};

// Error union per A-15. timeout covers a run exceeding its time limit,
// resource-limit covers input, memory or size excess, process-error
// covers a failed run, invalid-output covers output that fails the
// boundary check (K-008, K-511) — including engine output the internal
// adapter turns away for unresolved control flow — and output-too-large
// covers output past the size limit. The internal adapter reaches the
// cap and structural branches only; timeout and process-error stay
// typed for port stability and are steered by fakes in tests.
export type DecompilerError =
  | { kind: "timeout"; message: string }
  | { kind: "resource-limit"; message: string }
  | { kind: "process-error"; message: string }
  | { kind: "invalid-output"; message: string }
  | { kind: "output-too-large"; message: string; limitBytes: number };

// Per-port limits per A-17. Values come from the operational configuration
// (I-08, I-11); the port only names the fields.
export type DecompilerLimits = {
  readonly deadlineMs: number;
  readonly maxBytesIn: number;
  readonly maxBytesOut: number;
  readonly maxConcurrency: number;
  readonly retryBudget: number;
};

export interface DecompilerPort {
  decompile(
    bytecode: BytecodeType,
    codeHash: CodeHashType,
    ctx: CallContext,
  ): Promise<Result<DecompiledContract, DecompilerError>>;
}
