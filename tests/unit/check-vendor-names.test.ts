// Vendor-name guard check: the checker flags a synthetic hashed word
// with file and line, and stays green on clean text. The test drives the
// real script on scratch files, so it proves the shipped wiring instead
// of an import. The synthetic word keeps the test free of real vendor
// names, so the guard never flags its own test.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "..", "scripts", "check-vendor-names.mjs");

function runChecker(
  files: string[],
  extraHashes: string,
): { status: number; out: string } {
  try {
    const out = execFileSync("node", [script, ...files], {
      encoding: "utf8",
      env: { ...process.env, EXTRA_VENDOR_HASHES: extraHashes },
    });
    return { status: 0, out };
  } catch (error: unknown) {
    const failed = error as { status?: number; stdout?: unknown };
    return {
      status: typeof failed.status === "number" ? failed.status : 1,
      out: typeof failed.stdout === "string" ? failed.stdout : "",
    };
  }
}

describe("vendor-name guard", () => {
  test("flags a synthetic hashed word with file and line", () => {
    const synthetic = createHash("sha256").update("examplevendor", "utf8").digest("hex");
    const dir = mkdtempSync(join(tmpdir(), "vendor-check-"));
    const flagged = join(dir, "notes.md");
    writeFileSync(flagged, "first line is clean\nan examplevendor draft sits here\n", "utf8");
    const hit = runChecker([flagged], synthetic);
    expect(hit.status).toBe(1);
    expect(hit.out.trim()).toBe(`${flagged}:2`);
  });

  test("stays green on clean text", () => {
    const dir = mkdtempSync(join(tmpdir(), "vendor-check-"));
    const cleanFile = join(dir, "clean.md");
    writeFileSync(cleanFile, "ordinary English continues together\n", "utf8");
    const clean = runChecker([cleanFile], "");
    expect(clean.status).toBe(0);
    expect(clean.out).toBe("");
  });
});
