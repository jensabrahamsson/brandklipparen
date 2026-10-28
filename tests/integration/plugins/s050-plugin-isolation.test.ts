// S-050 worker isolation for untrusted detector plugins (K-515, K-501,
// K-101). Each detector runs in its own child process behind a hard
// deadline: a runaway detector is killed at the deadline and records the
// typed `timeout` outcome while parallel analyses continue. Written first
// (red) per A-21: the worker runner does not exist yet. No network; the
// fixtures are local detector modules run with the repo's strip-types
// flag, mirroring the extdecomp fake-worker pattern.
import { describe, expect, test } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolvePluginWorkerTimeoutMs,
  runDetectorInWorker,
} from "../../../src/adapters/pluginWorker/pluginWorker.ts";
import type { PluginWorkerOptions } from "../../../src/adapters/pluginWorker/pluginWorker.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURES = join(repoRoot, "tests", "fixtures", "pluginWorker");

function options(timeoutMs: number): PluginWorkerOptions {
  return Object.freeze({
    runnerPath: join(repoRoot, "src", "adapters", "pluginWorker", "detectorRunner.ts"),
    timeoutMs,
    maxInputBytes: 8192,
    maxOutputBytes: 65536,
  });
}

describe("k501_pathological_input_isolates_to_its_analysis", () => {
  test("a quick detector returns its findings from the worker", async () => {
    const result = await runDetectorInWorker(
      join(FIXTURES, "quickDetector.ts"),
      { marker: "quick" },
      options(5000),
    );
    if (result.kind !== "ok") {
      throw new Error(`expected ok, got ${result.kind}`);
    }
    expect(result.findingsJson).toContain("quick-finding");
  });

  test("a runaway detector records the typed timeout outcome", async () => {
    const started = Date.now();
    const result = await runDetectorInWorker(
      join(FIXTURES, "runawayDetector.ts"),
      { marker: "runaway" },
      options(500),
    );
    const elapsed = Date.now() - started;
    expect(result.kind).toBe("timeout");
    expect(elapsed).toBeLessThan(20000);
  });

  test("parallel analyses continue while one detector runs away", async () => {
    const started = Date.now();
    const [quick, runaway] = await Promise.all([
      runDetectorInWorker(join(FIXTURES, "quickDetector.ts"), { marker: "quick" }, options(5000)),
      runDetectorInWorker(join(FIXTURES, "runawayDetector.ts"), { marker: "runaway" }, options(500)),
    ]);
    const elapsed = Date.now() - started;
    if (quick.kind !== "ok") {
      throw new Error(`expected the quick detector to stay ok, got ${quick.kind}`);
    }
    expect(quick.findingsJson).toContain("quick-finding");
    expect(runaway.kind).toBe("timeout");
    expect(elapsed).toBeLessThan(20000);
  });

  test("an unset timeout resolves to the bounded default", () => {
    expect(resolvePluginWorkerTimeoutMs(undefined)).toBe(5000);
    expect(resolvePluginWorkerTimeoutMs(250)).toBe(250);
  });
});
