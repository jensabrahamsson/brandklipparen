// extdecomp worker adapter behind DecompilerPort (S-011, K-008, K-501,
// A-27, M-01, M-02; subcommand invocation since S-102). Each decompilation
// spawns one dedicated child process through the `decompile` subcommand
// and is bounded by a hard timeout, an input size guard, an output size
// guard and a concurrency semaphore from the operational configuration
// (I-08, I-11); a pathological input occupies solely its own worker, so
// parallel analyses continue. The worker receives the bytecode hex on argv
// and writes its parsed output files (`abi.json` plus `decompiled.sol`)
// into an adapter-owned output directory the invocation names with
// `--output`. The child starts with an empty environment, so no process
// secret can leak into the worker; outbound networking and filesystem
// restrictions for the real binary live in the platform sandbox per I-11
// (M-01). The real extdecomp binary is not installed here and is never
// downloaded by this code: the binary path arrives from the configuration,
// and the suite runs the adapter against the fake worker script under
// tests/fixtures.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  // Concurrency semaphore state (S-102): at most maxConcurrency workers
  // run at once; further requests wait in FIFO order. The count is only
  // touched on the event loop, so acquire and release stay race-free.
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(options: extdecompAdapterOptions) {
    this.binaryPath = options.binaryPath;
    this.binaryArgs = options.binaryArgs ?? [];
    this.timeoutMs = resolveextdecompTimeoutMs(options.timeoutMs);
    this.maxOutputBytes = resolveextdecompMaxOutputBytes(options.maxOutputBytes);
    this.maxBytesIn = resolveextdecompMaxBytesIn(options.maxBytesIn);
    this.maxMemoryMb = resolveextdecompMaxMemoryMb(options.maxMemoryMb);
    const concurrency = options.maxConcurrency ?? 1;
    this.maxConcurrency =
      Number.isSafeInteger(concurrency) && concurrency > 0 ? concurrency : 1;
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
    // The decompiler runs on its own fixed budget (A-07, K-102): the worker
    // timeout never derives from the request deadline, so a slow RPC or a
    // loaded host cannot turn a deterministic analysis into a timeout.
    void ctx;
    if (bytecode.length > this.maxBytesIn) {
      return Promise.resolve(
        err({
          kind: "resource-limit",
          message: `bytecode holds ${bytecode.length} bytes, above the input limit of ${this.maxBytesIn}`,
        }),
      );
    }
    // One process per request behind the concurrency semaphore (S-102):
    // the slot is held for the whole worker run and released on every
    // path, so excess requests wait instead of spawning.
    return (async (): Promise<Result<DecompiledContract, DecompilerError>> => {
      await this.acquireSlot();
      try {
        return await this.runWorker(bytecode, codeHash, this.timeoutMs);
      } finally {
        this.releaseSlot();
      }
    })();
  }

  private acquireSlot(): Promise<void> {
    if (this.inFlight < this.maxConcurrency) {
      this.inFlight += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    }).then(() => {
      this.inFlight += 1;
    });
  }

  private releaseSlot(): void {
    this.inFlight -= 1;
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
    }
  }

  private removeDir(path: string): void {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Best effort: a leftover temp dir never fails the analysis.
    }
  }

  private runWorker(
    bytecode: BytecodeType,
    codeHash: CodeHashType,
    timeoutMs: number,
  ): Promise<Result<DecompiledContract, DecompilerError>> {
    let outDir: string;
    try {
      outDir = mkdtempSync(join(tmpdir(), "extdecomp-decompile-"));
    } catch {
      return Promise.resolve(
        err({ kind: "process-error", message: "decompiler worker output directory failed" }),
      );
    }
    const outputDir = outDir;
    return new Promise((resolve) => {
      const hex = `0x${bytesToHex(bytecode)}`;
      let child: ChildProcess;
      try {
        child = spawn(
          this.binaryPath,
          [...this.binaryArgs, "decompile", hex, "--output", outputDir],
          {
            stdio: ["ignore", "pipe", "ignore"],
            shell: false,
            env: {},
          },
        );
      } catch {
        this.removeDir(outputDir);
        resolve(err({ kind: "process-error", message: "decompiler worker failed to start" }));
        return;
      }
      let settled = false;
      const finish = (result: Result<DecompiledContract, DecompilerError>): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.removeDir(outputDir);
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
      // Stdout is drained and discarded: progress chatter from the real
      // binary must never block the pipe, and the parsed output comes
      // from the output files, never from stdout.
      child.stdout?.on("data", () => undefined);
      child.stdout?.on("error", () => undefined);
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
        finish(this.parseOutputFiles(outputDir, codeHash));
      });
    });
  }

  // Strict boundary check at the port boundary (A-16, S-102): the
  // `decompile` output directory holds exactly `abi.json` (the function
  // list with one valid selector per entry) beside `decompiled.sol` (one
  // `// function <selector>` section per entry). Each function carries a
  // valid selector plus a well-formed snippet drawn from its section.
  // Hostile or distorted output is turned away with invalid-output before
  // it reaches the core (M-02); files past the output limit are turned
  // away as output-too-large without being parsed.
  private parseOutputFiles(
    outputDir: string,
    codeHash: CodeHashType,
  ): Result<DecompiledContract, DecompilerError> {
    const abi = this.readOutputFile(outputDir, "abi.json");
    if (!abi.ok) {
      return err(abi.error);
    }
    const sol = this.readOutputFile(outputDir, "decompiled.sol");
    if (!sol.ok) {
      return err(sol.error);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(abi.value.text) as unknown;
    } catch {
      return err(invalidOutput("abi.json is not valid JSON"));
    }
    if (!isRecord(parsed) || !Array.isArray(parsed["functions"])) {
      return err(invalidOutput("abi.json holds no functions array"));
    }
    const sections = splitSolSections(sol.value.text);
    const seen = new Set<string>();
    const functions: DecompiledFunction[] = [];
    for (const entry of parsed["functions"]) {
      if (!isRecord(entry) || typeof entry["selector"] !== "string") {
        return err(invalidOutput("abi.json holds a function without a selector"));
      }
      const selector = Selector.parse(entry["selector"]);
      if (!selector.ok) {
        return err(invalidOutput("abi.json holds no valid selector"));
      }
      const key = selector.value as string;
      if (seen.has(key)) {
        return err(invalidOutput("abi.json repeats a selector"));
      }
      seen.add(key);
      const section = sections.get(key.toLowerCase());
      if (section === undefined || section.text.length === 0) {
        return err(invalidOutput("decompiled.sol holds no body for a listed selector"));
      }
      const snippet = CodeSnippet.create({
        text: section.text,
        line: section.line,
        selector: selector.value,
      });
      if (!snippet.ok) {
        return err(invalidOutput("holds a snippet the core turns away"));
      }
      functions.push(Object.freeze({ selector: selector.value, snippet: snippet.value }));
    }
    return ok(Object.freeze({ codeHash, functions: Object.freeze(functions) }));
  }

  private readOutputFile(
    outputDir: string,
    name: string,
  ): Result<{ readonly text: string }, DecompilerError> {
    const path = join(outputDir, name);
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      return err({ kind: "invalid-output", message: `decompiler output misses ${name}` });
    }
    if (size > this.maxOutputBytes) {
      return err({
        kind: "output-too-large",
        message: `decompiled output exceeded the limit of ${this.maxOutputBytes} bytes`,
        limitBytes: this.maxOutputBytes,
      });
    }
    try {
      return ok({ text: readFileSync(path, "utf8") });
    } catch {
      return err({ kind: "invalid-output", message: `decompiler output ${name} is unreadable` });
    }
  }
}

// One `// function <selector>` section per function (S-102): the marker
// line opens the section and every following line up to the next marker
// is the function body. The snippet text is the trimmed body and the
// snippet line is the marker's zero-based line number.
function splitSolSections(
  text: string,
): Map<string, { readonly text: string; readonly line: number }> {
  const bodies = new Map<string, { readonly lines: string[]; readonly line: number }>();
  let current: string | null = null;
  for (const [index, line] of text.split("\n").entries()) {
    const marker = line.match(/^\/\/\s*function\s+(0x[0-9a-fA-F]{8})\s*$/);
    if (marker !== null) {
      current = (marker[1] ?? "").toLowerCase();
      if (!bodies.has(current)) {
        bodies.set(current, { lines: [], line: index });
      }
      continue;
    }
    if (current !== null) {
      bodies.get(current)?.lines.push(line);
    }
  }
  const sections = new Map<string, { readonly text: string; readonly line: number }>();
  for (const [selector, body] of bodies) {
    const bodyText = body.lines.join("\n").trim();
    if (bodyText.length > 0) {
      sections.set(selector, Object.freeze({ text: bodyText, line: body.line }));
    }
  }
  return sections;
}
