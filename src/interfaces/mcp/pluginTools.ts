// Per-plugin MCP tools generated from the registry snapshot (S-048,
// K-031, K-025, K-026, K-508). Each registered detector plugin gets one
// reading tool named `plugin_<sanitized id>`: the tool runs the shared
// analysis and returns solely that plugin's findings, leaving scores and
// evidence unchanged. The tool list is a snapshot at server creation, so
// a name outside the snapshot answers `unknown-tool` without analysis.
// Every tool carries a recorded security review in
// `TOOL_SECURITY_REVIEWS` (K-026).
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import { ASSESS_TOKEN_INPUT_SCHEMA } from "./tools.ts";
import type { ToolDefinition } from "./tools.ts";
import type { PluginRegistry } from "../../application/pluginExposure.ts";

export type PluginToolDefinitionError = {
  readonly kind: "duplicate-plugin-tool";
  readonly message: string;
};

// Tool name for one plugin id: `plugin_` plus the id with runs of
// non-alphanumeric characters replaced by one underscore. The mapping is
// deterministic and reversible for registered ids through the server's
// snapshot map; names outside the snapshot stay unknown tools.
export function pluginToolNameFor(pluginId: string): string {
  const safe = pluginId.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `plugin_${safe}`;
}

// Build one tool definition per registered detector entry. The input
// schema matches assess_token (address plus optional block), so the
// per-plugin tools face the same boundary limits (K-026). Versions follow
// the plugin manifest version.
export function buildPluginToolDefinitions(
  registry: PluginRegistry,
): Result<readonly ToolDefinition[], PluginToolDefinitionError> {
  const definitions: ToolDefinition[] = [];
  const seen = new Set<string>();
  for (const entry of registry.entries) {
    const name = pluginToolNameFor(entry.manifest.id);
    if (seen.has(name)) {
      return err({
        kind: "duplicate-plugin-tool",
        message: `duplicate per-plugin tool name in the registry snapshot: ${name}`,
      });
    }
    seen.add(name);
    definitions.push(
      Object.freeze({
        name,
        description: `Run the ${entry.manifest.displayName} detector and return solely its findings. Same analysis as assess_token, filtered to one plugin. Read-only.`,
        version: entry.manifest.version,
        inputSchema: ASSESS_TOKEN_INPUT_SCHEMA,
      }),
    );
  }
  definitions.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return ok(Object.freeze(definitions));
}

export type PluginToolSecurityReview = {
  readonly reviewer: string;
  readonly date: string;
  readonly scope: string;
  readonly verdict: "approved";
};

// Recorded security review per tool (K-026): every tool the server lists
// carries one entry with reviewer, date, scope and an approved verdict.
// New generated tools add one row here in the same reviewed change.
export const TOOL_SECURITY_REVIEWS: Readonly<Record<string, PluginToolSecurityReview>> = Object.freeze({
  assess_token: Object.freeze({
    reviewer: "plugin-security-review",
    date: "2026-10-28",
    scope: "read-only assessment over the shared service",
    verdict: "approved",
  }),
  request_assessment: Object.freeze({
    reviewer: "plugin-security-review",
    date: "2026-10-28",
    scope: "read-only assessment request over the shared service",
    verdict: "approved",
  }),
  investigate_token: Object.freeze({
    reviewer: "plugin-security-review",
    date: "2026-10-28",
    scope: "read-only investigation over the shared service",
    verdict: "approved",
  }),
  list_plugins: Object.freeze({
    reviewer: "plugin-security-review",
    date: "2026-10-28",
    scope: "read-only registry listing, no analysis",
    verdict: "approved",
  }),
  get_plugin_docs: Object.freeze({
    reviewer: "plugin-security-review",
    date: "2026-10-28",
    scope: "read-only validated docs record, unknown id rejected",
    verdict: "approved",
  }),
  get_plugin_audit: Object.freeze({
    reviewer: "plugin-security-review",
    date: "2026-10-28",
    scope: "read-only stored audit record, unknown id rejected, triggers no audit",
    verdict: "approved",
  }),
  plugin_dev_brandklipparen_capability: Object.freeze({
    reviewer: "plugin-security-review",
    date: "2026-10-28",
    scope: "read-only detector tool over the shared service, findings filtered to one plugin",
    verdict: "approved",
  }),
  plugin_dev_brandklipparen_clone_match: Object.freeze({
    reviewer: "plugin-security-review",
    date: "2026-10-28",
    scope: "read-only detector tool over the shared service, findings filtered to one plugin",
    verdict: "approved",
  }),
  plugin_dev_brandklipparen_hard_to_analyze: Object.freeze({
    reviewer: "plugin-security-review",
    date: "2026-10-28",
    scope: "read-only detector tool over the shared service, findings filtered to one plugin",
    verdict: "approved",
  }),
  plugin_dev_brandklipparen_decompiler: Object.freeze({
    reviewer: "plugin-security-review",
    date: "2026-10-28",
    scope: "read-only detector tool over the shared service, findings filtered to one plugin",
    verdict: "approved",
  }),
  plugin_dev_brandklipparen_mint: Object.freeze({
    reviewer: "plugin-security-review",
    date: "2026-10-28",
    scope: "read-only detector tool over the shared service, findings filtered to one plugin",
    verdict: "approved",
  }),
  plugin_dev_brandklipparen_blacklist: Object.freeze({
    reviewer: "plugin-security-review",
    date: "2026-10-28",
    scope: "read-only detector tool over the shared service, findings filtered to one plugin",
    verdict: "approved",
  }),
  plugin_dev_brandklipparen_transfer_fee: Object.freeze({
    reviewer: "plugin-security-review",
    date: "2026-10-28",
    scope: "read-only detector tool over the shared service, findings filtered to one plugin",
    verdict: "approved",
  }),
  plugin_dev_brandklipparen_pause: Object.freeze({
    reviewer: "plugin-security-review",
    date: "2026-10-28",
    scope: "read-only detector tool over the shared service, findings filtered to one plugin",
    verdict: "approved",
  }),
  plugin_dev_brandklipparen_transfer_limits: Object.freeze({
    reviewer: "plugin-security-review",
    date: "2026-10-28",
    scope: "read-only detector tool over the shared service, findings filtered to one plugin",
    verdict: "approved",
  }),
  plugin_dev_brandklipparen_ownership: Object.freeze({
    reviewer: "plugin-security-review",
    date: "2026-10-28",
    scope: "read-only detector tool over the shared service, findings filtered to one plugin",
    verdict: "approved",
  }),
  plugin_dev_brandklipparen_transfer_hooks: Object.freeze({
    reviewer: "plugin-security-review",
    date: "2026-10-28",
    scope: "read-only detector tool over the shared service, findings filtered to one plugin",
    verdict: "approved",
  }),
  plugin_dev_brandklipparen_sell_block: Object.freeze({
    reviewer: "plugin-security-review",
    date: "2026-10-28",
    scope: "read-only detector tool over the shared service, findings filtered to one plugin",
    verdict: "approved",
  }),
  plugin_dev_brandklipparen_proxy_upgrade: Object.freeze({
    reviewer: "plugin-security-review",
    date: "2026-10-28",
    scope: "read-only detector tool over the shared service, findings filtered to one plugin",
    verdict: "approved",
  }),
});
