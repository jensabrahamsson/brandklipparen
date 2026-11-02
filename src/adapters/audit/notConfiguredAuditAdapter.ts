// Not-configured audit adapter for the Meta Model API provider (P-13).
// Bound when no Meta audit adapter is configured: every call answers
// `not-configured` with zero sends and the deterministic result stands.
import { err } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import type { ModelId as ModelIdType } from "../../domain/types.ts";
import type {
  PluginAuditModelError,
  PluginAuditModelPort,
  PluginAuditReport,
} from "../../ports/pluginAuditModel.ts";

export const META_AUDIT_MODEL_ID = "muse-spark-1.3";

export class NotConfiguredAuditAdapter implements PluginAuditModelPort {
  private readonly modelIdValue: ModelIdType | undefined;

  constructor(modelId?: ModelIdType | undefined) {
    this.modelIdValue = modelId;
  }

  provider(): "meta-model-api" {
    return "meta-model-api";
  }

  modelId(): ModelIdType {
    return (this.modelIdValue ?? META_AUDIT_MODEL_ID) as ModelIdType;
  }

  async review(): Promise<Result<PluginAuditReport, PluginAuditModelError>> {
    return err({ kind: "not-configured", message: "plugin audit is not configured: set the Meta key" });
  }
}
