// extdecomp worker adapter behind DecompilerPort (S-011, K-008, K-501,
// A-27, M-01, M-02). Each decompilation spawns one dedicated child process
// and is bounded by a hard timeout, an input size guard and an output size
// guard from the operational configuration (I-08, I-11); a pathological
// input occupies solely its own worker, so parallel analyses continue.
// The worker receives the bytecode hex as its sole input flow on argv and
// returns one JSON document on stdout under the output limit. The child
// starts with an empty environment, so no process secret can leak into the
// worker; outbound networking and filesystem restrictions for the real
// binary live in the platform sandbox per I-11 (M-01). The real extdecomp
// binary is not installed here and is never downloaded by this code: the
// binary path arrives from the configuration, and the suite runs the
// adapter against the fake worker script under tests/fixtures.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import { CodeSnippet } from "../../domain/evidence.ts";
import { DEFAULT_MAX_BYTECODE_BYTES, Selector } from "../../domain/types.ts";
import type {
  Bytecode as BytecodeType,
  CodeHash as CodeHashType,
} from "../../domain/types.ts";
import type { ConfigError } from "../../ports/config.ts";
import type {
  CallContext,
  DecompiledContract,
  DecompiledFunction,
  DecompilerError,
  DecompilerLimits,
  DecompilerPort,
} from "../../ports/decompiler.ts";

// Placeholder operational limits for tests and offline use (A-17, I-11).
// Production passes the versioned values from the validated configuration
// through createextdecompAdapterFromConfig; the adapter never invents its own.
export const DEFAULT_extdecomp_TIMEOUT_MS = 60000;
export const DEFAULT_extdecomp_MAX_OUTPUT_BYTES = 1048576;
export const DEFAULT_extdecomp_MAX_MEMORY_MB = 512;

export function resolveextdecompTimeoutMs(value: number | undefined): number {
  return value ?? DEFAULT_extdecomp_TIMEOUT_MS;
}

export function resolveextdecompMaxOutputBytes(value: number | undefined): number {
  return value ?? DEFAULT_extdecomp_MAX_OUTPUT_BYTES;
}

export function resolveextdecompMaxMemoryMb(value: number | undefined): number {
  return value ?? DEFAULT_extdecomp_MAX_MEMORY_MB;
}

export function resolveextdecompMaxBytesIn(value: number | undefined): number {
  return value ?? DEFAULT_MAX_BYTECODE_BYTES;
}

export type extdecompAdapterOptions = {
  readonly binaryPath: string;
  readonly binaryArgs?: readonly string[] | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly maxBytesIn?: number | undefined;
  readonly maxMemoryMb?: number | undefined;
  readonly maxConcurrency?: number | undefined;
};

const extdecomp_BINARY_VARIABLE = "BRANDKLIPPAREN_extdecomp_BINARY_PATH";

// The subset of the validated configuration the adapter reads. The binary
// path selects the decompiler executable (the pinned extdecomp binary in the
// demo per I-05, the fake worker script in tests); every other value bounds
// the run per A-17.
export type extdecompAdapterConfig = {
  readonly extdecompBinaryPath: string | undefined;
  readonly extdecompDeadlineMs: number | undefined;
  readonly extdecompMaxOutputBytes: number | undefined;
  readonly extdecompMaxMemoryMb: number | undefined;
};

export function createextdecompAdapterFromConfig(
  config: extdecompAdapterConfig,
): Result<extdecompAdapter, ConfigError> {
  const binaryPath = config.extdecompBinaryPath;
  if (binaryPath === undefined || binaryPath.length === 0) {
    return err({ kind: "missing-variable", variable: extdecomp_BINARY_VARIABLE });
  }
  return ok(
    new extdecompAdapter({
      binaryPath,
      timeoutMs: config.extdecompDeadlineMs,
      maxOutputBytes: config.extdecompMaxOutputBytes,
      maxMemoryMb: config.extdecompMaxMemoryMb,
    }),
  );
}

function bytesToHex(bytes: Uint8Array): string {
  const digits = "0123456789abcdef";
  let out = "";
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    out += (digits[(byte >> 4) & 15] ?? "0") + (digits[byte & 15] ?? "0");
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return true;
}

function invalidOutput(reason: string): DecompilerError {
  return { kind: "invalid-output", message: `decompiler output ${reason}` };
}

export class extdecompAdapter implements DecompilerPort {
  private readonly binaryPath: string;
  private readonly binaryArgs: readonly string[];
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly maxBytesIn: number;
  private readonly maxMemoryMb: number;
  private readonly maxConcurrency: number;

  constructor(options: extdecompAdapterOptions) {
    this.binaryPath = options.binaryPath;
    this.binaryArgs = options.binaryArgs ?? [];
    this.timeoutMs = resolveextdecompTimeoutMs(options.timeoutMs);
    this.maxOutputBytes = resolveextdecompMaxOutputBytes(options.maxOutputBytes);
    this.maxBytesIn = resolveextdecompMaxBytesIn(options.maxBytesIn);
    this.maxMemoryMb = resolveextdecompMaxMemoryMb(options.maxMemoryMb);
    this.maxConcurrency = options.maxConcurrency ?? 1;
  }

  limits(): DecompilerLimits {
    return {
      deadlineMs: this.timeoutMs,
      maxBytesIn: this.maxBytesIn,
      maxBytesOut: this.maxOutputBytes,
      maxConcurrency: this.maxConcurrency,
      retryBudget: 0,
    };
  }

  decompile(
    bytecode: BytecodeType,
    codeHash: CodeHashType,
    ctx: CallContext,
  ): Promise<Result<DecompiledContract, DecompilerError>> {
    if (bytecode.length > this.maxBytesIn) {
      return Promise.resolve(
        err({
          kind: "resource-limit",
          message: `bytecode holds ${bytecode.length} bytes, above the input limit of ${this.maxBytesIn}`,
        }),
      );
    }
    const remaining = (ctx.deadline as number) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      return Promise.resolve(
        err({ kind: "timeout", message: "decompilation deadline already passed" }),
      );
    }
    return this.runWorker(bytecode, codeHash, Math.min(this.timeoutMs, Math.floor(remaining)));
  }

  private runWorker(
    bytecode: BytecodeType,
    codeHash: CodeHashType,
    timeoutMs: number,
  ): Promise<Result<DecompiledContract, DecompilerError>> {
    return new Promise((resolve) => {
      const hex = `0x${bytesToHex(bytecode)}`;
      let child: ChildProcess;
      try {
        child = spawn(this.binaryPath, [...this.binaryArgs, hex], {
          stdio: ["ignore", "pipe", "ignore"],
          shell: false,
          env: {},
        });
      } catch {
        resolve(err({ kind: "process-error", message: "decompiler worker failed to start" }));
        return;
      }
      let settled = false;
      const finish = (result: Result<DecompiledContract, DecompilerError>): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(result);
        }
      };
      const finishTimeout = (): void => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The child already exited; the close handler reports the outcome.
        }
        finish(err({ kind: "timeout", message: `decompilation timed out after ${timeoutMs} ms` }));
      };
      const timer = setTimeout(finishTimeout, timeoutMs);
      const chunks: Buffer[] = [];
      let received = 0;
      child.stdout?.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > this.maxOutputBytes) {
          try {
            child.kill("SIGKILL");
          } catch {
            // The child already exited; the close handler stays silent
            // because settled is already true after finish below.
          }
          finish(
            err({
              kind: "output-too-large",
              message: `decompiled output exceeded the limit of ${this.maxOutputBytes} bytes`,
              limitBytes: this.maxOutputBytes,
            }),
          );
          return;
        }
        chunks.push(chunk);
      });
      child.on("error", () => {
        finish(err({ kind: "process-error", message: "decompiler worker failed to start" }));
      });
      child.on("close", (code) => {
        if (settled) {
          return;
        }
        if (code !== 0) {
          finish(
            err({ kind: "process-error", message: `decompiler worker exited with code ${code}` }),
          );
          return;
        }
        finish(this.parseOutput(Buffer.concat(chunks), codeHash));
      });
    });
  }

  // Strict boundary check at the port boundary (A-16): exactly one object
  // with exactly the functions array, and each function carries exactly a
  // valid selector plus a well-formed snippet. Hostile or distorted output
  // is turned away with invalid-output before it reaches the core (M-02).
  private parseOutput(
    raw: Buffer,
    codeHash: CodeHashType,
  ): Result<DecompiledContract, DecompilerError> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8")) as unknown;
    } catch {
      return err(invalidOutput("is not valid JSON"));
    }
    if (!isRecord(parsed)) {
      return err(invalidOutput("holds no object"));
    }
    const topKeys = Object.keys(parsed);
    if (topKeys.length !== 1 || topKeys[0] !== "functions" || !Array.isArray(parsed["functions"])) {
      return err(invalidOutput("holds no functions array"));
    }
    const functions: DecompiledFunction[] = [];
    for (const entry of parsed["functions"]) {
      if (!isRecord(entry)) {
        return err(invalidOutput("holds a function that is no object"));
      }
      const entryKeys = Object.keys(entry).sort();
      if (entryKeys.length !== 2 || entryKeys[0] !== "selector" || entryKeys[1] !== "snippet") {
        return err(invalidOutput("holds a function without exactly selector and snippet"));
      }
      const selector =
        typeof entry["selector"] === "string" ? Selector.parse(entry["selector"]) : null;
      if (selector === null || !selector.ok) {
        return err(invalidOutput("holds no valid selector"));
      }
      const snippetRaw = entry["snippet"];
      if (!isRecord(snippetRaw)) {
        return err(invalidOutput("holds a snippet that is no object"));
      }
      const snippetKeys = Object.keys(snippetRaw).sort();
      if (
        snippetKeys.length !== 2 ||
        snippetKeys[0] !== "line" ||
        snippetKeys[1] !== "text" ||
        typeof snippetRaw["text"] !== "string" ||
        snippetRaw["text"].length === 0
      ) {
        return err(invalidOutput("holds a snippet without text and line"));
      }
      const line = snippetRaw["line"];
      if (typeof line !== "number" || !Number.isInteger(line) || line < 0) {
        return err(invalidOutput("holds a snippet without a valid line"));
      }
      const snippet = CodeSnippet.create({
        text: snippetRaw["text"],
        line,
        selector: selector.value,
      });
      if (!snippet.ok) {
        return err(invalidOutput("holds a snippet the core turns away"));
      }
      functions.push(Object.freeze({ selector: selector.value, snippet: snippet.value }));
    }
    return ok(Object.freeze({ codeHash, functions: Object.freeze(functions) }));
  }
}
