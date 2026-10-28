// Deterministic `PLUGIN.md` validator (S-052, P-15, P-17, K-032, K-517).
// Pure: no I/O, no clock, no randomness, no network. The caller reads the
// file and hands its text in; a missing file arrives as undefined and gives
// the named `missing-file` failure. Every plugin directory (first-party
// under `src/plugins/`, examples under `examples/plugins/`) carries one
// `PLUGIN.md` beside its manifest, referenced through the manifest `docs`
// field. The validator checks the machine-checkable claims: presence,
// required sections in order, the `## Inputs` names against the manifest
// inputs, and the version line against the manifest version. Semantic drift
// stays advisory review (S-055); strict frontmatter arrives in S-065.
import { err, ok } from "../domain/result.ts";
import type { Result } from "../domain/result.ts";
import type { PluginManifest } from "./api.ts";

// One branch per check, so a new check forces an explicit branch at every
// exhaustive switch. Each failure names the file-level cause, and the
// section or manifest field it disagrees with.
export type PluginDocsError =
  | { kind: "missing-file"; message: string }
  | { kind: "empty-docs"; message: string }
  | { kind: "docs-too-large"; message: string }
  | { kind: "missing-frontmatter"; message: string }
  | { kind: "invalid-frontmatter"; message: string }
  | { kind: "missing-frontmatter-field"; field: string; message: string }
  | { kind: "frontmatter-mismatch"; field: string; message: string }
  | { kind: "unknown-tag"; tag: string; message: string }
  | { kind: "unknown-audience"; value: string; message: string }
  | { kind: "topics-mismatch"; message: string }
  | { kind: "invalid-severity-range"; message: string }
  | { kind: "raw-html"; message: string }
  | { kind: "missing-section"; section: string; message: string }
  | { kind: "sections-out-of-order"; section: string; message: string }
  | { kind: "undeclared-input"; input: string; message: string }
  | { kind: "missing-declared-input"; input: string; message: string }
  | { kind: "version-mismatch"; message: string };

// Validated frontmatter (S-065, P-15 refined, K-035): the machine-readable
// half of `PLUGIN.md`. The deterministic priority baseline (P-25) reads
// only these tags, never the body text.
export type PluginFrontmatter = {
  readonly id: string;
  readonly kind: "detector" | "assessment";
  readonly version: string;
  readonly tags: readonly string[];
  readonly audience: readonly string[];
  readonly severity: { readonly min: "low" | "medium" | "high"; readonly max: "low" | "medium" | "high" };
};

// Controlled vocabulary for frontmatter `tags` (ADR section 14, P-15):
// adding a tag is an ADR change plus a CI vocabulary update in the same
// change, never a per-plugin invention.
export const PLUGIN_TAG_VOCABULARY: readonly string[] = Object.freeze([
  "owner-powers",
  "honeypot",
  "mint",
  "fees",
  "upgradeability",
  "liquidity",
  "blacklist",
  "pausing",
  "transfer-limits",
  "proxy",
  "supply",
  "external-calls",
]);

// Closed audience set (P-15): `all` stands alone when present.
export const PLUGIN_AUDIENCE_SET: readonly string[] = Object.freeze([
  "holder",
  "trader",
  "developer",
  "auditor",
  "all",
]);

const SEVERITY_RANK: Readonly<Record<string, number>> = Object.freeze({ low: 0, medium: 1, high: 2 });

// Frontmatter field names in the tiny YAML subset the repo parses
// hand-written (ADR P-15): flat scalars, one string list, one flat
// severity mapping. No YAML library is added for three field shapes.
const FRONTMATTER_FIELDS: readonly string[] = Object.freeze([
  "id",
  "kind",
  "version",
  "tags",
  "topics",
  "audience",
  "severity",
]);

// Validated docs record (P-16): the registry-adjacent value the REST docs
// route, the MCP docs surface and the web Docs view derive from (S-056).
// The markdown text stays under the size cap, so every surface can carry
// it bounded. The validated frontmatter travels with the record (S-065),
// so the P-25 matcher reads the typed value, never raw markdown.
export type ValidatedPluginDocs = {
  readonly pluginId: string;
  readonly version: string;
  readonly sections: readonly string[];
  readonly frontmatter: PluginFrontmatter;
  readonly markdown: string;
};

// Size cap for one plugin doc: large enough for the backfilled first-party
// docs, small enough to bound every response that carries them.
export const PLUGIN_DOCS_MAX_CHARS = 32768;

// Required sections in order (S-065 refined contract, supersedes the S-052
// headings): plain-English sections a token holder can act on. `Inputs`
// and `Version and changelog` are retained for the P-17 claim checks.
// Extra sections are still allowed.
export const REQUIRED_PLUGIN_DOC_SECTIONS: readonly string[] = Object.freeze([
  "What it checks",
  "Why it matters to you",
  "What it cannot tell you",
  "Evidence format",
  "Limitations / false positives",
  "Inputs",
  "Version and changelog",
]);

function missingFile(): Result<never, PluginDocsError> {
  return err({ kind: "missing-file", message: "plugin docs file PLUGIN.md is missing" });
}

function sectionHeadings(markdown: string): readonly string[] {
  const out: string[] = [];
  for (const line of markdown.split("\n")) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match !== null) {
      const name = match[1] as string;
      out.push(name);
    }
  }
  return Object.freeze(out);
}

// Section reader for the registry-adjacent value (S-069): the personalize
// service quotes the reader-facing sections per plugin. Returns the raw
// section text or the empty string when the doc misses the section.
export function sectionBodyOf(markdown: string, section: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${section}`);
  if (start === -1) {
    return "";
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

// Raw frontmatter field values in the tiny parsed subset: a scalar, a
// string list, or the flat severity mapping.
type FrontmatterValue = string | readonly string[] | Readonly<Record<string, string>>;

function unquoteScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineList(raw: string): readonly string[] | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return null;
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) {
    return [];
  }
  return Object.freeze(
    inner.split(",").map((entry) => unquoteScalar(entry)),
  );
}

function parseInlineMapping(raw: string): Readonly<Record<string, string>> | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  const inner = trimmed.slice(1, -1).trim();
  const out: Record<string, string> = {};
  if (inner.length === 0) {
    return Object.freeze(out);
  }
  for (const pair of inner.split(",")) {
    const colon = pair.indexOf(":");
    if (colon === -1) {
      return null;
    }
    const key = unquoteScalar(pair.slice(0, colon));
    const value = unquoteScalar(pair.slice(colon + 1));
    if (key.length === 0 || value.length === 0 || key in out) {
      return null;
    }
    out[key] = value;
  }
  return Object.freeze(out);
}

// Hand-written frontmatter parser for the tiny P-15 subset (S-065): the
// block between the leading `---` lines holds flat scalar fields, one
// string list per list field (inline `[a, b]` or dash lines), and one flat
// mapping for `severity` (inline `{ min, max }` or two indented lines).
// Duplicate keys, anchors, nested structures beyond the severity mapping,
// tab indentation, and any other YAML feature are a deterministic failure,
// never a best-effort parse.
function parseFrontmatterFields(
  markdown: string,
): Result<ReadonlyMap<string, FrontmatterValue>, PluginDocsError> {
  const lines = markdown.split("\n");
  if (lines[0]?.trim() !== "---") {
    return err({ kind: "missing-frontmatter", message: "plugin docs file PLUGIN.md misses its frontmatter block" });
  }
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing === -1) {
    return err({ kind: "missing-frontmatter", message: "plugin docs file PLUGIN.md misses its frontmatter block" });
  }
  const fields = new Map<string, FrontmatterValue>();
  let pendingList: string | null = null;
  let pendingSeverity = false;
  const severityParts: Record<string, string> = {};
  const body = lines.slice(1, closing);
  const flushPending = (): void => {
    pendingList = null;
    pendingSeverity = false;
  };
  for (const line of body) {
    if (line.trim().length === 0) {
      continue;
    }
    if (line.includes("\t")) {
      return err({ kind: "invalid-frontmatter", message: "plugin docs frontmatter forbids tab indentation" });
    }
    if (/[&*]/.test(line)) {
      return err({ kind: "invalid-frontmatter", message: "plugin docs frontmatter forbids anchors and aliases" });
    }
    const indent = line.length - line.trimStart().length;
    if (indent > 0) {
      const item = line.trim();
      if (pendingSeverity) {
        const colon = item.indexOf(":");
        if (colon === -1) {
          return err({ kind: "invalid-frontmatter", message: "plugin docs frontmatter severity needs min and max lines" });
        }
        const key = item.slice(0, colon).trim();
        const value = unquoteScalar(item.slice(colon + 1));
        if ((key !== "min" && key !== "max") || value.length === 0 || key in severityParts) {
          return err({ kind: "invalid-frontmatter", message: "plugin docs frontmatter severity needs min and max lines" });
        }
        severityParts[key] = value;
        if ("min" in severityParts && "max" in severityParts) {
          fields.set("severity", Object.freeze({ ...severityParts }));
          flushPending();
        }
        continue;
      }
      if (pendingList !== null && item.startsWith("-")) {
        const value = unquoteScalar(item.slice(1));
        if (value.length === 0) {
          return err({ kind: "invalid-frontmatter", message: "plugin docs frontmatter forbids empty list entries" });
        }
        fields.set(pendingList, Object.freeze([...(fields.get(pendingList) as readonly string[]), value]));
        continue;
      }
      return err({ kind: "invalid-frontmatter", message: "plugin docs frontmatter forbids nested structures" });
    }
    flushPending();
    const colon = line.indexOf(":");
    if (colon === -1) {
      return err({ kind: "invalid-frontmatter", message: "plugin docs frontmatter needs key: value lines" });
    }
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1);
    if (!FRONTMATTER_FIELDS.includes(key)) {
      return err({ kind: "invalid-frontmatter", message: `plugin docs frontmatter forbids the field ${key}` });
    }
    if (fields.has(key)) {
      return err({ kind: "invalid-frontmatter", message: `plugin docs frontmatter repeats the field ${key}` });
    }
    if (rawValue.trim().length === 0) {
      if (key === "severity") {
        pendingSeverity = true;
        continue;
      }
      if (key === "tags" || key === "topics" || key === "audience") {
        pendingList = key;
        fields.set(key, Object.freeze([]));
        continue;
      }
      return err({
        kind: "missing-frontmatter-field",
        field: key,
        message: `plugin docs frontmatter misses a value for ${key}`,
      });
    }
    if (key === "tags" || key === "topics" || key === "audience") {
      const list = parseInlineList(rawValue);
      if (list === null) {
        return err({ kind: "invalid-frontmatter", message: `plugin docs frontmatter field ${key} needs a list` });
      }
      fields.set(key, list);
      continue;
    }
    if (key === "severity") {
      const mapping = parseInlineMapping(rawValue);
      if (mapping === null) {
        return err({ kind: "invalid-frontmatter", message: "plugin docs frontmatter severity needs { min, max }" });
      }
      fields.set(key, mapping);
      continue;
    }
    const scalar = unquoteScalar(rawValue);
    if (scalar.length === 0) {
      return err({
        kind: "missing-frontmatter-field",
        field: key,
        message: `plugin docs frontmatter misses a value for ${key}`,
      });
    }
    fields.set(key, scalar);
  }
  if (pendingSeverity) {
    return err({ kind: "invalid-frontmatter", message: "plugin docs frontmatter severity needs min and max lines" });
  }
  return ok(fields);
}

function missingField(field: string): Result<never, PluginDocsError> {
  return err({
    kind: "missing-frontmatter-field",
    field,
    message: `plugin docs frontmatter misses the required field ${field}`,
  });
}

// Frontmatter validation against the manifest and the closed sets (S-065,
// P-15 refined, K-035): required fields present, `id`/`kind`/`version`
// equal to the manifest, tags inside the vocabulary, the `topics` legacy
// alias equal to `tags` when present, audience inside the closed set with
// `all` standing alone, and the severity range ordered on the domain scale.
function validateFrontmatter(
  manifest: PluginManifest,
  fields: ReadonlyMap<string, FrontmatterValue>,
): Result<PluginFrontmatter, PluginDocsError> {
  for (const field of ["id", "kind", "version", "tags", "audience", "severity"] as const) {
    if (!fields.has(field)) {
      return missingField(field);
    }
  }
  const id = fields.get("id");
  const kind = fields.get("kind");
  const version = fields.get("version");
  if (typeof id !== "string" || id !== (manifest.id as string)) {
    return err({ kind: "frontmatter-mismatch", field: "id", message: "plugin docs frontmatter id must equal the manifest id" });
  }
  if (typeof kind !== "string" || kind !== manifest.kind) {
    return err({
      kind: "frontmatter-mismatch",
      field: "kind",
      message: "plugin docs frontmatter kind must equal the manifest kind",
    });
  }
  if (typeof version !== "string" || version !== (manifest.version as string)) {
    return err({
      kind: "frontmatter-mismatch",
      field: "version",
      message: "plugin docs frontmatter version must equal the manifest version",
    });
  }
  const tags = fields.get("tags");
  if (!Array.isArray(tags) || tags.length < 1 || tags.length > 4 || new Set(tags).size !== tags.length) {
    return err({ kind: "invalid-frontmatter", message: "plugin docs frontmatter tags holds 1 to 4 unique entries" });
  }
  for (const tag of tags as readonly string[]) {
    if (typeof tag !== "string" || !PLUGIN_TAG_VOCABULARY.includes(tag)) {
      return err({ kind: "unknown-tag", tag: String(tag), message: `plugin docs frontmatter tag is outside the vocabulary: ${tag}` });
    }
  }
  const topics = fields.get("topics");
  if (topics !== undefined) {
    if (!Array.isArray(topics) || (topics as readonly string[]).join("\0") !== (tags as readonly string[]).join("\0")) {
      return err({ kind: "topics-mismatch", message: "plugin docs frontmatter topics alias must equal tags exactly" });
    }
  }
  const audience = fields.get("audience");
  if (!Array.isArray(audience) || audience.length < 1 || new Set(audience).size !== audience.length) {
    return err({ kind: "invalid-frontmatter", message: "plugin docs frontmatter audience holds 1 or more unique entries" });
  }
  for (const entry of audience as readonly string[]) {
    if (typeof entry !== "string" || !PLUGIN_AUDIENCE_SET.includes(entry)) {
      return err({ kind: "unknown-audience", value: String(entry), message: `plugin docs frontmatter audience is outside the closed set: ${entry}` });
    }
  }
  if ((audience as readonly string[]).includes("all") && (audience as readonly string[]).length > 1) {
    return err({ kind: "invalid-frontmatter", message: "plugin docs frontmatter audience all stands alone" });
  }
  const severity = fields.get("severity");
  if (severity === null || typeof severity !== "object" || Array.isArray(severity)) {
    return err({ kind: "invalid-severity-range", message: "plugin docs frontmatter severity needs { min, max }" });
  }
  const severityRecord = severity as Readonly<Record<string, string>>;
  const min = severityRecord["min"];
  const max = severityRecord["max"];
  if (
    (min !== "low" && min !== "medium" && min !== "high") ||
    (max !== "low" && max !== "medium" && max !== "high")
  ) {
    return err({ kind: "invalid-severity-range", message: "plugin docs frontmatter severity stays on low, medium, high" });
  }
  if ((SEVERITY_RANK[min] ?? 0) > (SEVERITY_RANK[max] ?? 0)) {
    return err({ kind: "invalid-severity-range", message: "plugin docs frontmatter severity min stays at most max" });
  }
  return ok(
    Object.freeze({
      id: id as string,
      kind: kind as "detector" | "assessment",
      version: version as string,
      tags: Object.freeze([...(tags as readonly string[])]),
      audience: Object.freeze([...(audience as readonly string[])]),
      severity: Object.freeze({ min, max }),
    }),
  );
}

// Raw HTML has no place in plugin docs (P-15, P-16): fenced blocks and
// inline code spans are prose, everything else carrying markup fails.
function hasRawHtml(markdown: string): boolean {
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, "");
  const withoutCode = withoutFences.replace(/`[^`\n]*`/g, "");
  return /<[A-Za-z][^<>]*>|<\/[A-Za-z][^<>]*>|<!--[^-]*-->/.test(withoutCode);
}

function backtickNames(body: string): readonly string[] {
  const names: string[] = [];
  const pattern = /`([^`\n]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    names.push(match[1] as string);
  }
  return Object.freeze(names);
}

// Deterministic docs check for one plugin: the manifest beside its
// `PLUGIN.md` text. Unknown input gives the named typed failure; valid
// input gives the frozen validated record with the section index and the
// capped markdown text.
export function validatePluginDocs(
  manifest: PluginManifest,
  markdown: unknown,
): Result<ValidatedPluginDocs, PluginDocsError> {
  if (markdown === undefined || markdown === null) {
    return missingFile();
  }
  if (typeof markdown !== "string" || markdown.trim().length === 0) {
    return err({ kind: "empty-docs", message: "plugin docs file PLUGIN.md is empty" });
  }
  if (markdown.length > PLUGIN_DOCS_MAX_CHARS) {
    return err({
      kind: "docs-too-large",
      message: "plugin docs file PLUGIN.md exceeds the size cap",
    });
  }
  const parsedFields = parseFrontmatterFields(markdown);
  if (!parsedFields.ok) {
    return err(parsedFields.error);
  }
  const frontmatter = validateFrontmatter(manifest, parsedFields.value);
  if (!frontmatter.ok) {
    return err(frontmatter.error);
  }
  if (hasRawHtml(markdown)) {
    return err({ kind: "raw-html", message: "plugin docs file PLUGIN.md forbids embedded raw HTML" });
  }
  const headings = sectionHeadings(markdown);
  let previousIndex = -1;
  for (const section of REQUIRED_PLUGIN_DOC_SECTIONS) {
    const index = headings.indexOf(section);
    if (index === -1) {
      return err({
        kind: "missing-section",
        section,
        message: `plugin docs file PLUGIN.md misses the required section ## ${section}`,
      });
    }
    if (index <= previousIndex) {
      return err({
        kind: "sections-out-of-order",
        section,
        message: `plugin docs file PLUGIN.md carries ## ${section} out of the required order`,
      });
    }
    previousIndex = index;
  }
  // Declared inputs against the manifest (P-17): the `## Inputs` section
  // names only inputs the manifest declares, and names all of them.
  // Detector inputs use the closed catalogue names; assessment plugins
  // declare no detector inputs and their section stays prose.
  if (manifest.kind === "detector") {
    const declared = new Set<string>(manifest.inputs);
    const documented = backtickNames(sectionBodyOf(markdown, "Inputs"));
    for (const name of documented) {
      if (!declared.has(name)) {
        return err({
          kind: "undeclared-input",
          input: name,
          message: `plugin docs ## Inputs names ${name}, which the manifest does not declare`,
        });
      }
    }
    for (const name of declared) {
      if (!documented.includes(name)) {
        return err({
          kind: "missing-declared-input",
          input: name,
          message: `plugin docs ## Inputs misses the declared input ${name}`,
        });
      }
    }
  }
  const versionMatch = /Version\s*:?\s+(\d+\.\d+\.\d+)/.exec(markdown);
  if (versionMatch === null || (versionMatch[1] as string) !== (manifest.version as string)) {
    return err({
      kind: "version-mismatch",
      message: "plugin docs version line must equal the manifest version",
    });
  }
  return ok(
    Object.freeze({
      pluginId: manifest.id as string,
      version: manifest.version as string,
      sections: Object.freeze([...headings]),
      frontmatter: frontmatter.value,
      markdown,
    }),
  );
}
