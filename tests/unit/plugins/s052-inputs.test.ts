// S-109 docs-versus-code checks (K-516): the `## Inputs` section of a
// plugin doc must name exactly the inputs its manifest declares. A doc
// naming an undeclared input, or missing a declared one, fails the
// deterministic validator with a named error. Written to pin the
// S-109 cross-check: the validator implements it, and the S-109 doc
// corrections keep every real doc green under it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { validatePluginDocs } from "../../../src/plugins/docs.ts";
import { capabilityDetectorPlugin } from "../../../src/plugins/detectors/capability/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const CAPABILITY_DOC = readFileSync(
  join(repoRoot, "src", "plugins", "detectors", "capability", "PLUGIN.md"),
  "utf8",
);

describe("plugin docs input cross-check (S-109)", () => {
  test("s052_inputs_match_manifest_inputs", () => {
    const manifest = capabilityDetectorPlugin.manifest;
    if (manifest.kind !== "detector") {
      throw new Error("capability entry must be a detector");
    }
    expect(manifest.inputs).toEqual(["bytecode"]);

    // The shipped doc names exactly the declared inputs.
    const clean = validatePluginDocs(manifest, CAPABILITY_DOC);
    expect(clean.ok).toBe(true);

    // An extra backticked input the manifest never declares is rejected.
    const extra = validatePluginDocs(
      manifest,
      CAPABILITY_DOC.replace("`bytecode` (with its code hash)", "`bytecode` (with its code hash) and `decompilerCause`"),
    );
    if (extra.ok) {
      throw new Error("expected an undeclared input to fail validation");
    }
    expect(extra.error.kind).toBe("undeclared-input");

    // A declared input missing from the section is rejected.
    const missing = validatePluginDocs(
      manifest,
      CAPABILITY_DOC.replace("`bytecode` (with its code hash)", "bytecode (with its code hash)"),
    );
    if (missing.ok) {
      throw new Error("expected a missing declared input to fail validation");
    }
    expect(missing.error.kind).toBe("missing-declared-input");
  });
});
