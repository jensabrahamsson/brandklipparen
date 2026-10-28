// extdecomp worker adapter behind DecompilerPort (S-011, K-008, K-501,
// A-27, M-01, M-02; subcommand invocation since S-102). Each decompilation
// spawns one dedicated child process through the `decompile` subcommand
// and is bounded by a hard timeout, an input size guard, an output size
// guard and a concurrency semaphore from the operational configuration
// (I-08, I-11); a pathological input occupies solely its own worker, so
// parallel analyses continue. The worker receives the bytecode hex on argv
// and writes its parsed output files (`abi.json` plus `decompiled.sol`)
// into an adapter-owned output directory the invocation names with
// `--output`. The parsed output file is `abi.json` as a standard ABI
// array (real extdecomp 0.9.1 shape); no `--include-sol` is passed, so no
// `decompiled.sol` is written or read. The child starts with an empty environment, so no process
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
import {
  DEFAULT_MAX_BYTECODE_BYTES,
  Selector,
  keccak256HexOfUtf8,
} from "../../domain/types.ts";
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
        // Local-bytecode-only invocation: the target is always hex from the
        // port input, never an address, ENS name or RPC endpoint. The flags
        // keep the run offline and non-interactive: `--skip-resolving`
        // skips the remote selector lookup, `-d` answers every prompt with
        // the default, `--color never` keeps escape codes out of the files,
        // and `--output` names the adapter-owned output directory. No
        // `--include-sol` is passed: the adapter parses `abi.json` only, so
        // the run skips the per-function symbolic execution and the output
        // stays far inside the output and time limits.
        child = spawn(
          this.binaryPath,
          [
            ...this.binaryArgs,
            "decompile",
            hex,
            "--output",
            outputDir,
            "--skip-resolving",
            "-d",
            "--color",
            "never",
          ],
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
  // `decompile` output directory holds `abi.json` as a standard ABI array
  // (`[{type, name, inputs, outputs, stateMutability}, ...]`), the shape
  // real extdecomp 0.9.1 writes. Each function entry carries a valid
  // selector derived from its name plus a well-formed snippet holding the
  // canonical signature; entries of any other type (events, errors) are
  // skipped. Hostile or distorted output is turned away with
  // invalid-output before it reaches the core (M-02); files past the
  // output limit are turned away as output-too-large without being parsed.
  private parseOutputFiles(
    outputDir: string,
    codeHash: CodeHashType,
  ): Result<DecompiledContract, DecompilerError> {
    const abi = this.readOutputFile(outputDir, "abi.json");
    if (!abi.ok) {
      return err(abi.error);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(abi.value.text) as unknown;
    } catch {
      return err(invalidOutput("abi.json is not valid JSON"));
    }
    if (!Array.isArray(parsed)) {
      return err(invalidOutput("abi.json holds no ABI array"));
    }
    const seen = new Set<string>();
    const functions: DecompiledFunction[] = [];
    for (let index = 0; index < parsed.length; index += 1) {
      const entry = parsed[index] as unknown;
      if (!isRecord(entry) || entry["type"] !== "function") {
        continue;
      }
      const derived = deriveFunctionSelector(entry);
      if (!derived.ok) {
        return err(invalidOutput(derived.reason));
      }
      const key = derived.selector as string;
      if (seen.has(key)) {
        return err(invalidOutput("abi.json repeats a selector"));
      }
      seen.add(key);
      const snippet = CodeSnippet.create({
        text: derived.signature,
        line: index,
        selector: derived.selector,
      });
      if (!snippet.ok) {
        return err(invalidOutput("holds a snippet the core turns away"));
      }
      functions.push(Object.freeze({ selector: derived.selector, snippet: snippet.value }));
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

// Selector derivation for one ABI function entry (real extdecomp 0.9.1
// shape). Entries the resolver left unnamed carry the selector as
// `Unresolved_<8 hex>` and yield it directly; resolved entries name the
// function, so the selector is the first four bytes of keccak256 over the
// canonical signature `name(type,...)` built from the input types (tuple
// inputs expand through their components). The canonical signature also
// becomes the snippet the deepening attaches to evidence.
function deriveFunctionSelector(
  entry: Record<string, unknown>,
): { ok: true; selector: Selector; signature: string } | { ok: false; reason: string } {
  const name = entry["name"];
  if (typeof name !== "string" || name.length === 0) {
    return { ok: false, reason: "abi.json holds a function without a name" };
  }
  const unresolved = /^unresolved_([0-9a-fA-F]{8})$/i.exec(name);
  if (unresolved !== null) {
    const selector = Selector.parse(`0x${(unresolved[1] ?? "").toLowerCase()}`);
    if (!selector.ok) {
      return { ok: false, reason: "abi.json holds no valid selector" };
    }
    return { ok: true, selector: selector.value, signature: `${name}()` };
  }
  if (/^unresolved_/i.test(name)) {
    return { ok: false, reason: "abi.json holds a malformed unresolved name" };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return { ok: false, reason: "abi.json holds a function with an invalid name" };
  }
  const inputs = entry["inputs"];
  if (!Array.isArray(inputs)) {
    return { ok: false, reason: "abi.json holds a function without an inputs array" };
  }
  const types: string[] = [];
  for (const input of inputs) {
    const expanded = expandInputType(input);
    if (expanded === null) {
      return { ok: false, reason: "abi.json holds a function with an invalid input type" };
    }
    types.push(expanded);
  }
  const signature = `${name}(${types.join(",")})`;
  const selector = Selector.parse(keccak256HexOfUtf8(signature).slice(0, 10));
  if (!selector.ok) {
    return { ok: false, reason: "abi.json holds no valid selector" };
  }
  return { ok: true, selector: selector.value, signature };
}

// Canonical type of one ABI input: the declared type, expanded through
// tuple components so nested structs keep their canonical parenthesized
// form. Anything without a usable type string turns the entry away.
function expandInputType(input: unknown): string | null {
  if (!isRecord(input) || typeof input["type"] !== "string" || input["type"].length === 0) {
    return null;
  }
  const type = input["type"];
  if (type !== "tuple") {
    return type;
  }
  const components = input["components"];
  if (!Array.isArray(components)) {
    return null;
  }
  const expanded: string[] = [];
  for (const component of components) {
    const inner = expandInputType(component);
    if (inner === null) {
      return null;
    }
    expanded.push(inner);
  }
  return `(${expanded.join(",")})`;
}
