// Boundary guard for K-106/A-06/A-32: the domain core holds no I/O types.
// Fails CI when src/domain reaches the clock, randomness, network,
// environment access or node: modules. Complements the ESLint rule and
// dependency-cruiser in the same gate.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const domainRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "domain");

function domainFiles(directory: string): string[] {
  return readdirSync(directory)
    .map((entry) => join(directory, entry))
    .flatMap((path) => (statSync(path).isDirectory() ? domainFiles(path) : [path]))
    .filter((path) => path.endsWith(".ts"));
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

describe("domain purity boundary", () => {
  test("k106_core_has_no_io_types", () => {
    const files = domainFiles(domainRoot);
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const [pattern, label] of FORBIDDEN) {
        if (pattern.test(content)) {
          violations.push(`${file}: forbidden ${label}`);
        }
      }
      for (const match of content.matchAll(/from\s+["']([^"']+)["']/g)) {
        const specifier = match[1] ?? "";
        if (!specifier.startsWith(".")) {
          violations.push(`${file}: non-relative import ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
