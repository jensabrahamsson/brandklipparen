// Boundary guard for K-027/A-04/A-06: the application layer reaches the
// outside world solely through ports. Fails CI when src/application or
// src/ports touches the clock, randomness, network, environment access,
// node: modules, or concrete adapters, interfaces or composition modules.
// Complements the ESLint rule and dependency-cruiser in the same gate.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src");

function layerFiles(layer: string): string[] {
  const root = join(srcRoot, layer);
  const walk = (directory: string): string[] =>
    readdirSync(directory)
      .map((entry) => join(directory, entry))
      .flatMap((path) => (statSync(path).isDirectory() ? walk(path) : [path]))
      .filter((path) => path.endsWith(".ts"));
  return walk(root);
}

const FORBIDDEN: ReadonlyArray<readonly [RegExp, string]> = [
  [/from\s+["']node:/, "node: module import"],
  [/\bDate\b/, "Date (system clock)"],
  [/Math\.random/, "Math.random (unseeded randomness)"],
  [/randomUUID|getRandomValues/, "crypto randomness"],
  [/crypto\.subtle/, "subtle crypto (platform API)"],
  // The mandated DecompilerPort branch name "process-error" (A-15) is not
  // environment access, so the lookahead permits exactly that literal while
  // process.env, process.exit and every other process use stays forbidden.
  [/\bprocess\b(?!-error)/, "process (environment access)"],
  [/\bfetch\s*\(/, "fetch (network)"],
  [/XMLHttpRequest|WebSocket/, "browser network globals"],
  [/setTimeout|setInterval|setImmediate|queueMicrotask/, "timers"],
  [/performance\.(now|timeOrigin)/, "performance clock"],
  [/\bconsole\b/, "console (I/O logging belongs in adapters)"],
  [/\beval\s*\(/, "eval"],
  [/new\s+Function\s*\(/, "Function constructor"],
  [/require\s*\(/, "require (module loading)"],
];

// Layers the application and ports must never reach: concrete driven and
// driving adapters, the composition root and the web app. The core reaches
// them only through port interfaces injected as parameters.
const FORBIDDEN_TARGETS = ["/adapters/", "/interfaces/", "/composition/", "/apps/"];

function forbiddenTarget(specifier: string, file: string): string | null {
  const resolved = normalize(join(dirname(file), specifier));
  for (const target of FORBIDDEN_TARGETS) {
    if (resolved.includes(target)) {
      return target;
    }
  }
  return null;
}

function checkFiles(files: string[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const [pattern, label] of FORBIDDEN) {
      if (pattern.test(content)) {
        violations.push(`${file}: forbidden ${label}`);
      }
    }
    for (const match of content.matchAll(/(?:import|export)[^"']*?from\s+["']([^"']+)["']/g)) {
      const specifier = match[1] ?? "";
      if (!specifier.startsWith(".")) {
        violations.push(`${file}: non-relative import ${specifier}`);
        continue;
      }
      const target = forbiddenTarget(specifier, file);
      if (target !== null) {
        violations.push(`${file}: forbidden dependency on ${target} via ${specifier}`);
      }
    }
  }
  return violations;
}

describe("application boundary", () => {
  test("k027_application_depends_only_on_ports", () => {
    const files = [...layerFiles("application"), ...layerFiles("ports")];
    expect(files.length).toBeGreaterThan(0);
    expect(checkFiles(files)).toEqual([]);
  });
});
