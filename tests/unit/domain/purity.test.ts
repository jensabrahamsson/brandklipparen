// Boundary guard for K-106/A-06/A-32: the domain core holds no I/O types.
// Fails CI when src/domain reaches the clock, randomness, network,
// environment access or node: modules. Complements the ESLint rule and
// dependency-cruiser in the same gate.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const domainRoot = join(repoRoot, "src", "domain");

// Deliberate boundary-break probe written briefly inside src/domain by
// a06_deliberately_broken_boundary_fails_ci (tests/unit/ci-gate.test.ts)
// so dependency-cruiser flags it there. The purity scan skips it by exact
// basename: both tests run in parallel workers, so the probe can exist at
// the moment this scan lists the directory. Skipping the exact name keeps
// the a06 proof intact while this guard keeps scanning every real file.
const DELIBERATE_PROBE_BASENAMES: ReadonlySet<string> = new Set(["__a06_probe__.ts"]);

function isDeliberateProbe(file: string): boolean {
  return DELIBERATE_PROBE_BASENAMES.has(basename(file));
}

function domainFiles(directory: string): string[] {
  return readdirSync(directory)
    .map((entry) => join(directory, entry))
    .flatMap((path) => (statSync(path).isDirectory() ? domainFiles(path) : [path]))
    .filter((path) => path.endsWith(".ts"))
    .filter((path) => !isDeliberateProbe(path));
}

const FORBIDDEN: ReadonlyArray<readonly [RegExp, string]> = [
  [/from\s+["']node:/, "node: module import"],
  [/\bDate\b/, "Date (system clock)"],
  [/Math\.random/, "Math.random (unseeded randomness)"],
  [/randomUUID|getRandomValues/, "crypto randomness"],
  [/crypto\.subtle/, "subtle crypto (platform API)"],
  [/\bprocess\b/, "process (environment access)"],
  [/\bfetch\s*\(/, "fetch (network)"],
  [/XMLHttpRequest|WebSocket/, "browser network globals"],
  [/setTimeout|setInterval|setImmediate|queueMicrotask/, "timers"],
  [/performance\.(now|timeOrigin)/, "performance clock"],
  [/\bconsole\b/, "console (I/O logging belongs in adapters)"],
  [/\beval\s*\(/, "eval"],
  [/new\s+Function\s*\(/, "Function constructor"],
  [/require\s*\(/, "require (module loading)"],
];

function scanFiles(files: readonly string[], readFile: (file: string) => string): string[] {
  const violations: string[] = [];
  for (const file of files) {
    if (isDeliberateProbe(file)) {
      continue;
    }
    const display = relative(repoRoot, file);
    const content = readFile(file);
    for (const [pattern, label] of FORBIDDEN) {
      if (pattern.test(content)) {
        violations.push(`${display}: forbidden ${label}`);
      }
    }
    for (const match of content.matchAll(/from\s+["']([^"']+)["']/g)) {
      const specifier = match[1] ?? "";
      if (!specifier.startsWith(".")) {
        violations.push(`${display}: non-relative import ${specifier}`);
      }
    }
  }
  return violations;
}

describe("domain purity boundary", () => {
  test("k106_core_has_no_io_types", () => {
    const files = domainFiles(domainRoot);
    expect(files.length).toBeGreaterThan(0);
    expect(scanFiles(files, (file) => readFileSync(file, "utf8"))).toEqual([]);
  });

  test("k106_purity_scan_ignores_deliberate_a06_probe", () => {
    const probe = join(domainRoot, "__a06_probe__.ts");
    const real = join(domainRoot, "real.ts");
    const contents = new Map([
      [probe, 'import fs from "node:fs";\nexport const probe = fs;\n'],
      [real, 'import fs from "node:fs";\nexport const value = fs;\n'],
    ]);
    const violations = scanFiles([probe, real], (file) => contents.get(file) ?? "");
    expect(violations.some((entry) => entry.includes("__a06_probe__"))).toBe(false);
    expect(violations).toEqual([`${join("src", "domain", "real.ts")}: forbidden node: module import`, `${join("src", "domain", "real.ts")}: non-relative import node:fs`]);
  });
});
