// Deterministic plugin audit (S-053, S-055, K-516, K-517, P-13, P-17).
// Pure static checks over one plugin's source, manifest and `PLUGIN.md`:
// no I/O, no clock, no randomness, no network, no model calls. The caller
// reads the files and hands their text in; the audit never touches the
// filesystem, so the same function serves the CLI, the CI job and the
// tests. Findings below are `docs-drift` only in the advisory AI phase;
// the deterministic phase reports named failures and blocks the AI phase
// on any failure. Acceptance is derived, never stored: a plugin is
// accepted exactly when the deterministic phase passes and a human review
// is recorded.
import type { Result } from "../domain/result.ts";
import { validatePluginDocs } from "./docs.ts";
import type { DetectorManifest, JsonSchema, PluginManifest } from "./api.ts";
import type {
  PluginAuditFinding,
  PluginAuditInput,
  PluginAuditModelError,
  PluginAuditModelPort,
  PluginAuditCallContext,
} from "../ports/pluginAuditModel.ts";
import { PluginAuditInput as PluginAuditInputCtor } from "../ports/pluginAuditModel.ts";
import type { PromptVersion as PromptVersionType } from "../domain/types.ts";

// One plugin source file for the static checks: path plus text.
export type AuditSourceFile = {
  readonly path: string;
  readonly text: string;
};

// One branch per check, so a new check forces an explicit branch at every
// exhaustive switch. Each failure names the check, the file and the cause.
export type DeterministicAuditFailure =
  | { kind: "forbidden-import"; file: string; message: string }
  | { kind: "capability-mismatch"; file: string; message: string }
  | { kind: "determinism-violation"; file: string; message: string }
  | { kind: "invalid-limits"; message: string }
  | { kind: "docs-mismatch"; message: string }
  | { kind: "unknown-output-field"; field: string; message: string };

export type DeterministicAuditResult =
  | { readonly passed: true; readonly failures: readonly [] }
  | { readonly passed: false; readonly failures: readonly DeterministicAuditFailure[] };

// Audit report type per ADR P-13: the illegal combinations are
// unrepresentable. A deterministic failure carries `ai: not-run` by
// construction; no stored `accepted` flag exists.
export type PluginAuditReport =
  | {
      readonly deterministic: { kind: "fail"; failures: readonly DeterministicAuditFailure[] };
      readonly ai: { kind: "not-run" };
      readonly humanReview: "recorded" | "missing";
    }
  | {
      readonly deterministic: { kind: "pass" };
      readonly ai:
        | {
            kind: "advisory";
            findings: readonly PluginAuditFinding[];
            provider: string;
            modelId: string;
          }
        | { kind: "not-run" }
        | { kind: "not-configured" }
        | { kind: "invalid-output" };
      readonly humanReview: "recorded" | "missing";
    };

// Acceptance is derived, never stored: deterministic pass plus a recorded
// human review. No AI output registers, unregisters or approves a plugin.
export function isAccepted(report: PluginAuditReport): boolean {
  return report.deterministic.kind === "pass" && report.humanReview === "recorded";
}

// Forbidden module access in detector sources (P-13, M-21, M-22): every
// static import specifier must be relative; dynamic imports of computed
// specifiers, require, eval and the Function constructor are unusable in
// a detector.
const STATIC_IMPORT = /(?:import|export)\s+[^"']*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(/;
const REQUIRE_CALL = /\brequire\s*\(/;
const EVAL_CALL = /\beval\s*\(/;
const FUNCTION_CONSTRUCTOR = /\bnew\s+Function\s*\(/;

function staticSpecifiers(text: string): string[] {
  const found: string[] = [];
  STATIC_IMPORT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STATIC_IMPORT.exec(text)) !== null) {
    const specifier = match[1] ?? match[2];
    if (specifier !== undefined) {
      found.push(specifier);
    }
  }
  return found;
}

// Network or secret capability used in source (P-13): detector manifests
// declare clean capabilities by type, so any such use mismatches the
// manifest and fails the audit.
const NETWORK_USE = /\bfetch\s*\(|\bWebSocket\b|\bXMLHttpRequest\b|node:(net|http|https|dgram)\b/;
const SECRET_USE = /\bprocess\.env\b/;

// Clock, randomness and ambient reads in detector sources (P-13): the
// same style as the `a32_domain_has_no_clock_random_or_network` check,
// applied to the plugin directory.
const CLOCK_USE = /\bDate\b|\bperformance\.(now|timeOrigin)\b/;
const RANDOM_USE = /\bMath\.random\b|\brandomUUID\b|\bgetRandomValues\b|\bcrypto\.subtle\b/;
const AMBIENT_USE = /\bprocess\.(argv|env|exit|cwd)\b/;

function auditSourceFile(file: AuditSourceFile): DeterministicAuditFailure[] {
  const failures: DeterministicAuditFailure[] = [];
  for (const specifier of staticSpecifiers(file.text)) {
    if (!specifier.startsWith(".")) {
      failures.push({
        kind: "forbidden-import",
        file: file.path,
        message: `detector source imports outside relative modules: ${specifier}`,
      });
    }
  }
  if (DYNAMIC_IMPORT.test(file.text)) {
    failures.push({
      kind: "forbidden-import",
      file: file.path,
      message: "detector source uses a dynamic import of a computed specifier",
    });
  }
  if (REQUIRE_CALL.test(file.text) || EVAL_CALL.test(file.text) || FUNCTION_CONSTRUCTOR.test(file.text)) {
    failures.push({
      kind: "forbidden-import",
      file: file.path,
      message: "detector source uses require, eval or the Function constructor",
    });
  }
  const network = NETWORK_USE.exec(file.text)?.[0];
  if (network !== undefined) {
    failures.push({
      kind: "capability-mismatch",
      file: file.path,
      message: `detector source uses a network capability the manifest never declares: ${network}`,
    });
  }
  const secret = SECRET_USE.exec(file.text)?.[0];
  if (secret !== undefined) {
    failures.push({
      kind: "capability-mismatch",
      file: file.path,
      message: `detector source reads secrets the manifest never declares: ${secret}`,
    });
  }
  const clock = CLOCK_USE.exec(file.text)?.[0] ?? RANDOM_USE.exec(file.text)?.[0] ?? AMBIENT_USE.exec(file.text)?.[0];
  if (clock !== undefined) {
    failures.push({
      kind: "determinism-violation",
      file: file.path,
      message: `detector source reads a clock, randomness or ambient value: ${clock}`,
    });
  }
  return failures;
}

function auditLimits(manifest: DetectorManifest): DeterministicAuditFailure[] {
  const limits = manifest.limits;
  const valid =
    Number.isInteger(limits.maxFindings) &&
    limits.maxFindings > 0 &&
    Number.isInteger(limits.maxEvidencePerFinding) &&
    limits.maxEvidencePerFinding > 0 &&
    Number.isInteger(limits.maxOutputBytes) &&
    limits.maxOutputBytes > 0;
  if (!valid) {
    return [{ kind: "invalid-limits", message: "detector manifest limits must be positive integers" }];
  }
  return [];
}

// Backticked identifiers in one markdown section: single words in code
// spans. Dotted paths, namespaced ids and multi-word spans are prose, not
// field claims, and stay out of the check.
function backtickIdentifiers(section: string): string[] {
  const found: string[] = [];
  for (const match of section.matchAll(/`([^`]+)`/g)) {
    const span = (match[1] ?? "").trim();
    if (/^[A-Za-z][A-Za-z0-9]*$/.test(span) && !found.includes(span)) {
      found.push(span);
    }
  }
  return found;
}

function sectionBody(markdown: string, section: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${section}`);
  if (start === -1) {
    return "";
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

// Declared output property names in the manifest outputSchema (P-17):
// collected by walking `properties` through `items` and `properties`.
function schemaPropertyNames(schema: JsonSchema): Set<string> {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      return;
    }
    const record = node as { readonly [keyword: string]: unknown };
    const properties = record["properties"];
    if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
      for (const name of Object.keys(properties)) {
        names.add(name);
        visit((properties as { readonly [key: string]: unknown })[name]);
      }
    }
    const items = record["items"];
    if (items !== undefined) {
      if (Array.isArray(items)) {
        for (const entry of items) {
          visit(entry);
        }
      } else {
        visit(items);
      }
    }
  };
  visit(schema as unknown);
  return names;
}

// Docs-versus-code output-field check (S-055, P-17; section renamed in
// S-065): every backticked field name in `## Evidence format` must be
// declared in the manifest outputSchema. A drifted field is a deterministic
// failure.
export function auditDocsOutputFields(
  markdown: string,
  manifest: DetectorManifest,
): DeterministicAuditFailure[] {
  const declared = schemaPropertyNames(manifest.outputSchema);
  const failures: DeterministicAuditFailure[] = [];
  for (const field of backtickIdentifiers(sectionBody(markdown, "Evidence format"))) {
    if (!declared.has(field)) {
      failures.push({
        kind: "unknown-output-field",
        field,
        message: `PLUGIN.md ## Evidence format names a field the manifest outputSchema never declares: ${field}`,
      });
    }
  }
  return failures;
}

// Deterministic audit over one detector plugin (P-13): static source
// checks, manifest limits, the `PLUGIN.md` validator from S-052
// (presence, sections, documented inputs, version) and the S-055
// output-field check. Returns the failure list; empty means pass.
export function auditDeterministic(
  manifest: DetectorManifest,
  sources: readonly AuditSourceFile[],
  docsMarkdown: string | undefined,
): DeterministicAuditResult {
  const failures: DeterministicAuditFailure[] = [];
  for (const file of sources) {
    failures.push(...auditSourceFile(file));
  }
  failures.push(...auditLimits(manifest));
  const pluginManifest: PluginManifest = manifest;
  const docs = validatePluginDocs(pluginManifest, docsMarkdown);
  if (!docs.ok) {
    failures.push({ kind: "docs-mismatch", message: `PLUGIN.md check failed: ${docs.error.kind}` });
  } else if (docsMarkdown !== undefined) {
    failures.push(...auditDocsOutputFields(docsMarkdown, manifest));
  }
  if (failures.length > 0) {
    return { passed: false, failures: Object.freeze(failures) };
  }
  return { passed: true, failures: [] };
}

// Audit request: manifest, code sources, docs text, the exact AI-phase
// file list (quoted content with hashes, when the operator opts in), and
// the recorded human review state.
export type PluginAuditRequest = {
  readonly manifest: DetectorManifest;
  readonly sources: readonly AuditSourceFile[];
  readonly docsMarkdown: string | undefined;
  readonly auditFiles: readonly { readonly path: string; readonly sha256: string; readonly quotedContent: string }[];
  readonly promptVersion: PromptVersionType;
  readonly humanReview: "recorded" | "missing";
};

export type PluginAuditAdapter = {
  readonly adapter: PluginAuditModelPort;
  readonly ctx: PluginAuditCallContext;
};

// Full audit run (P-13): the deterministic phase first; the AI phase runs
// only after a deterministic pass and only when the operator hands an
// adapter in for that run. A deterministic failure ends the audit with
// `ai: not-run` and zero model calls.
export async function runPluginAudit(
  request: PluginAuditRequest,
  ai?: PluginAuditAdapter | undefined,
): Promise<PluginAuditReport> {
  const deterministic = auditDeterministic(request.manifest, request.sources, request.docsMarkdown);
  if (!deterministic.passed) {
    return {
      deterministic: { kind: "fail", failures: deterministic.failures },
      ai: { kind: "not-run" },
      humanReview: request.humanReview,
    };
  }
  if (ai === undefined) {
    return {
      deterministic: { kind: "pass" },
      ai: { kind: "not-run" },
      humanReview: request.humanReview,
    };
  }
  const built: Result<PluginAuditInput, { kind: string; message: string }> = PluginAuditInputCtor.create({
    pluginId: request.manifest.id as string,
    pluginVersion: request.manifest.version as string,
    files: request.auditFiles.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      quotedContent: file.quotedContent,
    })),
    promptVersion: request.promptVersion,
  });
  if (!built.ok) {
    return {
      deterministic: { kind: "pass" },
      ai: { kind: "invalid-output" },
      humanReview: request.humanReview,
    };
  }
  const reviewed = await ai.adapter.review(built.value, ai.ctx);
  if (!reviewed.ok) {
    const error: PluginAuditModelError = reviewed.error;
    if (error.kind === "not-configured") {
      return {
        deterministic: { kind: "pass" },
        ai: { kind: "not-configured" },
        humanReview: request.humanReview,
      };
    }
    return {
      deterministic: { kind: "pass" },
      ai: { kind: "invalid-output" },
      humanReview: request.humanReview,
    };
  }
  return {
    deterministic: { kind: "pass" },
    ai: {
      kind: "advisory",
      findings: reviewed.value.findings,
      provider: reviewed.value.provider,
      modelId: reviewed.value.modelId as string,
    },
    humanReview: request.humanReview,
  };
}
