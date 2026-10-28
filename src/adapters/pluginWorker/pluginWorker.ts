// Worker isolation for untrusted detector plugins (S-050, K-515, K-501,
// K-101, A-27 pattern). Each run spawns one dedicated child `node`
// process on `detectorRunner.ts` with an empty environment: a pathological
// or runaway detector occupies solely its own worker, so parallel analyses
// continue. The run is bounded by a hard deadline from the operational
// configuration, an input size guard and an output size guard; the
// deadline kill maps to the typed `timeout` outcome and every other
// failure maps to `worker-error`, so the caller can record the registry
// outcome (`timeout` in `PluginOutcome`) with the analysis standing.
// Pure parent side apart from the spawn: no network, no secrets, no
// filesystem reads beyond spawning the runner the caller names.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

// Placeholder operational deadline for tests and offline use (A-17, I-11).
// Production passes the versioned value from the validated configuration;
// the runner never invents its own.
export const DEFAULT_PLUGIN_WORKER_TIMEOUT_MS = 5000;

export function resolvePluginWorkerTimeoutMs(value: number | undefined): number {
  return value ?? DEFAULT_PLUGIN_WORKER_TIMEOUT_MS;
}

export type IsolatedDetectorResult =
  | { readonly kind: "ok"; readonly findingsJson: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "worker-error"; readonly message: string };

export type PluginWorkerOptions = {
  readonly runnerPath: string;
  readonly nodePath?: string | undefined;
  readonly timeoutMs: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
};

type SpawnOutcome = { readonly kind: "worker-error"; readonly message: string };

// One isolated detector run (S-050): input JSON on stdin, one envelope on
// stdout, empty environment, hard deadline. Never throws: every failure
// maps to a typed result.
export function runDetectorInWorker(
  modulePath: string,
  input: unknown,
  options: PluginWorkerOptions,
): Promise<IsolatedDetectorResult> {
  let inputJson: string;
  try {
    inputJson = JSON.stringify(input) ?? "null";
  } catch {
    return Promise.resolve({ kind: "worker-error", message: "detector input is not serializable" });
  }
  if (Buffer.byteLength(inputJson, "utf8") > options.maxInputBytes) {
    return Promise.resolve({ kind: "worker-error", message: "detector input exceeds the input size limit" });
  }
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: IsolatedDetectorResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    let child: ChildProcess;
    try {
      child = spawn(options.nodePath ?? process.execPath, ["--experimental-strip-types", options.runnerPath, modulePath], {
        env: {},
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      settle({ kind: "worker-error", message: "detector worker failed to spawn" });
      return;
    }
    const deadline = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child already exited; the exit handler settles below.
      }
      settle({ kind: "timeout" });
    }, options.timeoutMs);
    let stdout = "";
    let stdoutBytes = 0;
    let outcome: SpawnOutcome | null = null;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxOutputBytes) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone; settle as a worker error below.
        }
        outcome = { kind: "worker-error", message: "detector output exceeds the output size limit" };
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(deadline);
      settle({ kind: "worker-error", message: "detector worker failed to start" });
    });
    child.on("exit", () => {
      clearTimeout(deadline);
      if (settled) {
        return;
      }
      if (outcome !== null) {
        settle(outcome);
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { kind?: unknown; findings?: unknown; message?: unknown };
        if (parsed.kind === "ok" && typeof parsed.findings === "string") {
          settle({ kind: "ok", findingsJson: parsed.findings });
        } else if (parsed.kind === "worker-error") {
          settle({
            kind: "worker-error",
            message: typeof parsed.message === "string" ? parsed.message : "detector worker reported an error",
          });
        } else {
          settle({ kind: "worker-error", message: "detector worker returned an unknown envelope" });
        }
      } catch {
        settle({ kind: "worker-error", message: "detector worker returned no parseable envelope" });
      }
    });
    try {
      child.stdin?.write(inputJson);
      child.stdin?.end();
    } catch {
      clearTimeout(deadline);
      settle({ kind: "worker-error", message: "detector worker input write failed" });
    }
  });
}
