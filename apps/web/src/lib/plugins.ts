// Plugin list and result parsing for the token page (S-059, K-034).
// Pure: the registry list arrives from `GET /v1/plugins` and the findings
// from the assessed envelope's `pluginResults`; both are untrusted JSON
// and stay data. Malformed entries are dropped, never thrown over.
import type { PluginFindingView, PluginListEntry, PluginResultView } from "../components/PluginsPanel.tsx";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortString(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    return null;
  }
  return value;
}

function evidenceOf(value: unknown): PluginFindingView["evidence"] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: { readonly selector: string; readonly offset: number | null }[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const selector = shortString(entry["selector"]);
    if (selector === null) {
      continue;
    }
    const offset = entry["offset"];
    out.push({
      selector,
      offset: typeof offset === "number" && Number.isInteger(offset) && offset >= 0 ? offset : null,
    });
  }
  return out;
}

// Registry list entries for the panel: identity and display text plus the
// optional `outputSchema` the schema-driven renderer reads. Entries
// without an id or display name are dropped.
export function toPluginListEntries(raw: unknown): PluginListEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: PluginListEntry[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = shortString(entry["id"]);
    const displayName = shortString(entry["displayName"]);
    if (id === null || displayName === null) {
      continue;
    }
    const version = shortString(entry["version"]) ?? "0.0.0";
    const description = shortString(entry["description"]) ?? "";
    const outputSchema = isRecord(entry["outputSchema"]) ? entry["outputSchema"] : undefined;
    const frontmatter = frontmatterOf(entry["frontmatter"]);
    const base = { id, version, displayName, description };
    out.push({
      ...base,
      ...(outputSchema === undefined ? {} : { outputSchema }),
      ...(frontmatter === undefined ? {} : { frontmatter }),
    });
  }
  return out;
}

function stringListOf(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  if (!value.every((entry) => typeof entry === "string" && entry.length > 0)) {
    return null;
  }
  return Object.freeze([...(value as readonly string[])]);
}

// Validated frontmatter shape for the matcher: tags plus the severity
// range. Anything else is dropped, so the matcher never reads raw prose.
function frontmatterOf(value: unknown): PluginListEntry["frontmatter"] {
  if (!isRecord(value)) {
    return undefined;
  }
  const tags = stringListOf(value["tags"]);
  const audience = stringListOf(value["audience"]);
  const severity = value["severity"];
  if (tags === null || audience === null || !isRecord(severity)) {
    return undefined;
  }
  const min = severity["min"];
  const max = severity["max"];
  if (typeof min !== "string" || typeof max !== "string") {
    return undefined;
  }
  return { tags, audience, severity: { min, max } };
}

// Analysis findings for the panel: titles and evidence plus the raw
// payload, which the SchemaValue library renders as inert text. A finding
// without an id, title or evidence entry is dropped; the payload passes
// through untouched and never reaches a markup sink.
export function toPluginResultViews(raw: unknown): PluginResultView[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: PluginResultView[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      continue;
    }
    const pluginId = shortString(entry["pluginId"]);
    if (pluginId === null) {
      continue;
    }
    const findings: PluginFindingView[] = [];
    if (Array.isArray(entry["findings"])) {
      for (const finding of entry["findings"]) {
        if (!isRecord(finding)) {
          continue;
        }
        const id = shortString(finding["id"]);
        const title = shortString(finding["title"]);
        if (id === null || title === null) {
          continue;
        }
        const evidence = evidenceOf(finding["evidence"]);
        if (evidence.length === 0) {
          continue;
        }
        const payload = finding["payload"];
        findings.push(payload === undefined ? { id, title, evidence } : { id, title, payload, evidence });
      }
    }
    out.push({
      pluginId,
      pluginVersion: shortString(entry["pluginVersion"]) ?? "0.0.0",
      outcome: shortString(entry["outcome"]) ?? "unknown",
      findings,
    });
  }
  return out;
}
