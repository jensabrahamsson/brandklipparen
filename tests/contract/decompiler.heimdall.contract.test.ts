// Contract suite against the extdecomp worker adapter over the fake worker
// (S-011, K-008, K-501). The adapter spawns a real child process running
// the fixture worker script, so isolation, timeout and crash handling are
// exercised for real with recorded outputs and no network access.
// Process-spawning tests carry an explicit timeout well above the default
// 5000 ms: CI runners are slower (cold cache, shared CPU) and process
// startup alone can take seconds there. 30 s keeps the suite green on slow
// runners without hiding a hung child process (the adapter's own shorter
// timeout still bounds every run).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extdecompAdapter } from "../../src/adapters/extdecomp/extdecompAdapter.ts";
import type { DecompilerPort } from "../../src/ports/decompiler.ts";
import type { DecompilerContractScenario } from "./decompiler.contract.ts";
import { runDecompilerPortContract } from "./decompiler.contract.ts";

const workerPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "extdecomp",
  "fake-worker.mjs",
);

function makeAdapter(scenario: DecompilerContractScenario): DecompilerPort {
  const base = {
    binaryPath: process.execPath,
    maxMemoryMb: 512,
  };
  switch (scenario) {
    case "success":
      return new extdecompAdapter({
        ...base,
        binaryArgs: [workerPath, "--mode=success"],
        timeoutMs: 15000,
        maxOutputBytes: 65536,
      });
    case "timeout":
      return new extdecompAdapter({
        ...base,
        binaryArgs: [workerPath, "--mode=hang"],
        timeoutMs: 1000,
        maxOutputBytes: 65536,
      });
    case "resource-limit":
      return new extdecompAdapter({
        ...base,
        binaryArgs: [workerPath, "--mode=success"],
        timeoutMs: 15000,
        maxOutputBytes: 65536,
        maxBytesIn: 2,
      });
    case "process-error":
      return new extdecompAdapter({
        ...base,
        binaryArgs: [workerPath, "--mode=crash"],
        timeoutMs: 15000,
        maxOutputBytes: 65536,
      });
    case "invalid-output":
      return new extdecompAdapter({
        ...base,
        binaryArgs: [workerPath, "--mode=invalid"],
        timeoutMs: 15000,
        maxOutputBytes: 65536,
      });
    case "output-too-large":
      return new extdecompAdapter({
        ...base,
        binaryArgs: [workerPath, "--mode=oversize"],
        timeoutMs: 15000,
        maxOutputBytes: 1024,
      });
  }
}

runDecompilerPortContract("extdecomp worker adapter over the fake worker", makeAdapter, {
  timeoutMs: 30000,
});
