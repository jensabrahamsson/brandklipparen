// Plugin exposure behind the application service (S-104, K-027, P-09).
// Driving adapters (REST, MCP, web UI) reach plugin data exclusively
// through this application module, never by importing `src/plugins`
// directly: the dependency gate forbids interfaces-to-plugins imports, so
// every exposure helper the routes and tools need is re-exported here.
// The registry itself still owns the data; this module only fixes the
// direction of the dependency.
export {
  exposeManifest,
  exposeRegistry,
  pluginWeightsOf,
  serializePluginDocs,
  serializePluginList,
  weightOfMapping,
} from "../plugins/exposure.ts";
export type {
  ExposedPlugin,
  ExposedPluginCapabilities,
  ExposedPluginFrontmatter,
  ExposedPluginLimits,
  PluginDocsMap,
  PluginWeightMapping,
} from "../plugins/exposure.ts";
export { serializeStoredAuditReport } from "../plugins/auditReport.ts";
export type { StoredAuditReportMap } from "../plugins/auditReport.ts";
export { sectionBodyOf } from "../plugins/docs.ts";
export { pluginResultToCanonical } from "../plugins/detector.ts";
export type { PluginRegistry } from "../plugins/registry.ts";
