// PluginAuditModelPort: advisory AI review of one plugin (S-054, K-516,
// P-14). The port is owned by the core: the input is a closed frozen value
// (plugin id, version, file list with per-file quoted content, prompt
// version), and the output is structured advisory findings validated by
// `parsePluginAuditReport` before any human sees them. The port never
// shares prompt text, input shapes, output schemas or caching keys with
// the assessment ports; only the Meta transport layer is shared.
// Findings are display values no code maps to risk, direction or weight:
// the report carries no field the registry, scoring or analysis path
// reads (P-13, K-307). Key handling stays server-side (K-505, K-513).
import { err, ok } from "../domain/result.ts";
import type { Result } from "../domain/result.ts";
import type {
  ModelId as ModelIdType,
  PromptVersion as PromptVersionType,
  RequestId as RequestIdType,
  Timestamp as TimestampType,
  BlockNumber as BlockNumberType,
} from "../domain/types.ts";

export type PluginAuditProvider = "meta-model-api";

// One quoted source file in the audit input (P-14, M-24): path plus
// content quoted through `UntrustedText.quote` under the per-file cap.
// The file list holds the plugin directory's source, manifest and
// `PLUGIN.md` only: no repo-wide files, no configuration values, no
// secrets.
export type PluginAuditFile = {
  readonly path: string;
  readonly sha256: string;
  readonly quotedContent: string;
};

// Closed, frozen audit input: plugin id, version, the exact file list
// with quoted content, and the prompt version. Nothing else enters.
export type PluginAuditInput = {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly files: readonly PluginAuditFile[];
  readonly promptVersion: PromptVersionType;
};

export const PluginAuditInput = {
  create(input: {
    readonly pluginId: string;
    readonly pluginVersion: string;
    readonly files: readonly PluginAuditFile[];
    readonly promptVersion: PromptVersionType;
  }): Result<PluginAuditInput, { kind: "invalid-audit-input"; message: string }> {
    if (input.pluginId.length === 0 || input.pluginId.length > 128) {
      return err({ kind: "invalid-audit-input", message: "plugin id must be a short label" });
    }
    if (input.pluginVersion.length === 0 || input.pluginVersion.length > 32) {
      return err({ kind: "invalid-audit-input", message: "plugin version must be a short label" });
    }
    if (input.files.length === 0 || input.files.length > 16) {
      return err({ kind: "invalid-audit-input", message: "file list must hold 1 to 16 files" });
    }
    return ok(
      Object.freeze({
        pluginId: input.pluginId,
        pluginVersion: input.pluginVersion,
        files: Object.freeze(input.files.slice()),
        promptVersion: input.promptVersion,
      }),
    );
  },
};

// Structured advisory finding (P-14): severity, location, category,
// rationale as text only, and confidence. The closed enums keep a model
// that follows an embedded instruction inside the validated shape.
export type PluginAuditSeverity = "info" | "low" | "medium" | "high";

export type PluginAuditCategory =
  | "forbidden-capability"
  | "injection-surface"
  | "determinism"
  | "evidence-integrity"
  | "docs-drift"
  | "other";

export type PluginAuditFinding = {
  readonly severity: PluginAuditSeverity;
  readonly location: string;
  readonly category: PluginAuditCategory;
  readonly rationale: string;
  readonly confidence: number;
  readonly quotedEvidence: string;
};

export type PluginAuditReport = {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly promptVersion: PromptVersionType;
  readonly provider: PluginAuditProvider;
  readonly modelId: ModelIdType;
  readonly findings: readonly PluginAuditFinding[];
};

// Error union per A-15, mirroring AssessmentModelError branch names plus
// `not-configured` for the keyless run (P-13, P-14).
export type PluginAuditModelError =
  | { kind: "timeout"; message: string }
  | { kind: "rate-limited"; message: string }
  | { kind: "invalid-output"; message: string }
  | { kind: "output-too-large"; message: string; limitChars: number }
  | { kind: "provider-mismatch"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "not-configured"; message: string };

export type PluginAuditCallContext = {
  readonly requestId: RequestIdType;
  readonly deadline: TimestampType;
  readonly block: BlockNumberType | "latest";
};

export interface PluginAuditModelPort {
  review(
    input: PluginAuditInput,
    ctx: PluginAuditCallContext,
  ): Promise<Result<PluginAuditReport, PluginAuditModelError>>;
  provider(): PluginAuditProvider;
  modelId(): ModelIdType;
}
