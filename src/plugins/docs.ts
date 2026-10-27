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
  | { kind: "missing-section"; section: string; message: string }
  | { kind: "sections-out-of-order"; section: string; message: string }
  | { kind: "undeclared-input"; input: string; message: string }
  | { kind: "missing-declared-input"; input: string; message: string }
  | { kind: "version-mismatch"; message: string };

// Validated docs record (P-16): the registry-adjacent value the REST docs
// route, the MCP docs surface and the web Docs view derive from (S-056).
// The markdown text stays under the size cap, so every surface can carry
// it bounded.
export type ValidatedPluginDocs = {
  readonly pluginId: string;
  readonly version: string;
  readonly sections: readonly string[];
  readonly markdown: string;
};

// Size cap for one plugin doc: large enough for the backfilled first-party
// docs, small enough to bound every response that carries them.
export const PLUGIN_DOCS_MAX_CHARS = 32768;

// Required sections in order (S-052 contract): the finding shapes, the
// declared inputs, the output shape with evidence, and the bounds. Extra
// sections are allowed; the strict frontmatter and the refined headings
// arrive in S-065 without renumbering this contract.
export const REQUIRED_PLUGIN_DOC_SECTIONS: readonly string[] = Object.freeze([
  "What it detects",
  "Inputs",
  "Output",
  "Limits",
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
    const documented = backtickNames(sectionBody(markdown, "Inputs"));
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
      markdown,
    }),
  );
}
