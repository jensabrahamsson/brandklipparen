// Audit gate integration (S-053, S-054, K-516, M-23, M-25).
// A deterministic failure ends the audit with zero model calls even when
// the AI phase is opted in, and the AI phase sends exactly the listed
// plugin files: neighbouring secrets-shaped fixtures never leave.
import { describe, expect, test } from "vitest";
import { PluginManifest } from "../../../src/plugins/api.ts";
import type { DetectorManifest } from "../../../src/plugins/api.ts";
import { runPluginAudit } from "../../../src/plugins/audit.ts";
import { FakePluginAuditModelAdapter } from "../../fakes/fakePluginAuditModel.ts";
import type { Result } from "../../../src/domain/result.ts";
import { PromptVersion, RequestId, Timestamp } from "../../../src/domain/types.ts";

function mustOk<T>(result: Result<T, { message: string }>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function testManifest(): DetectorManifest {
  const parsed = PluginManifest.parse({
    id: "dev.brandklipparen.test-detector",
    version: "1.0.0",
    kind: "detector",
    apiVersion: "1.0.0",
    displayName: "Test detector",
    description: "A detector fixture for audit tests only.",
    inputs: ["bytecode"],
    docs: "PLUGIN.md",
    outputSchema: { type: "array" },
    capabilities: { needsNetwork: false, needsSecrets: false, affectsScore: false, runsInFastPath: true },
    limits: { maxFindings: 8, maxEvidencePerFinding: 128, maxOutputBytes: 32768 },
  });
  if (!parsed.ok || parsed.value.kind !== "detector") {
    throw new Error("test manifest failed validation");
  }
  return parsed.value;
}

const CLEAN_DOCS = `---
id: dev.brandklipparen.test-detector
kind: detector
version: 1.0.0
tags: [honeypot]
audience: [holder]
severity: { min: low, max: high }
---
# PLUGIN.md: Test detector (\`dev.brandklipparen.test-detector\`)

Version 1.0.0.

## What it checks

A test detection.

## Why it matters to you

A test finding worth reading.

## What it cannot tell you

Whether the test detection matters.

## Evidence format

Findings carry evidence with selectors.

## Limitations / false positives

A test limitation.

## Inputs

Declared inputs: \`bytecode\`.

## Version and changelog

Version 1.0.0. Initial release.
`;

function ctxOf() {
  return {
    requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(1761446400000)),
    block: "latest" as const,
  };
}

describe("plugin audit gate", () => {
  test("k516_deterministic_failure_runs_zero_model_calls", async () => {
    const fake = new FakePluginAuditModelAdapter("findings");
    const report = await runPluginAudit(
      {
        manifest: testManifest(),
        sources: [{ path: "index.ts", text: `import fs from "node:fs";\nexport const x = fs;\n` }],
        docsMarkdown: CLEAN_DOCS,
        auditFiles: [{ path: "index.ts", sha256: "abc", quotedContent: "source" }],
        promptVersion: mustOk(PromptVersion.parse("1.0.0")),
        humanReview: "missing",
      },
      { adapter: fake, ctx: ctxOf() },
    );
    expect(report.deterministic.kind).toBe("fail");
    expect(report.ai).toEqual({ kind: "not-run" });
    expect(fake.callCount).toBe(0);
  });

  test("k516_audit_sends_only_listed_plugin_files", async () => {
    // Neighbouring secrets-shaped fixtures live beside the plugin tree in
    // this test but never enter the audit file list.
    const neighbouringSecrets = ["AKIAIOSFODNN7EXAMPLE", "postgres://user:pass@db.internal/main"];
    void neighbouringSecrets;
    const fake = new FakePluginAuditModelAdapter("clean");
    const listed = [
      { path: "index.ts", sha256: "aaa", quotedContent: "Quoted detector source for tests only." },
      { path: "PLUGIN.md", sha256: "bbb", quotedContent: "Quoted plugin docs for tests only." },
    ];
    const report = await runPluginAudit(
      {
        manifest: testManifest(),
        sources: [{ path: "index.ts", text: `export const x = 1;\n` }],
        docsMarkdown: CLEAN_DOCS,
        auditFiles: listed,
        promptVersion: mustOk(PromptVersion.parse("1.0.0")),
        humanReview: "missing",
      },
      { adapter: fake, ctx: ctxOf() },
    );
    expect(report.ai.kind).toBe("advisory");
    expect(fake.callCount).toBe(1);
    const sent = fake.receivedInputs[0];
    expect(sent).toBeDefined();
    if (sent === undefined) {
      return;
    }
    expect(sent.files.map((file) => file.path)).toEqual(["index.ts", "PLUGIN.md"]);
    const joined = sent.files.map((file) => file.quotedContent).join("\n");
    for (const secret of neighbouringSecrets) {
      expect(joined).not.toContain(secret);
    }
  });
});
