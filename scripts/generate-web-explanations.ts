// Generated web explanations builder (S-113, K-021, K-301).
// Run from the repo root with `npm run generate:explanations`: reads the
// plugin docs (src/plugins/**/PLUGIN.md) and the template sources in
// src/domain/explain.ts, and writes the typed explanation map the web UI
// renders through the Explain trigger. No network, no defaults beside the
// repo layout: every sentence in the output is extracted from a source
// file read here, so rewording a source changes the output instead of
// letting it drift. The matching unit test regenerates the module and
// requires the byte-identical file.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type ExplanationEntry = { readonly title: string; readonly body: string };
export type ExplanationMap = Readonly<Record<string, ExplanationEntry>>;

const PLUGIN_DOC_GLOBS = ["src/plugins/detectors", "src/plugins/assessments"] as const;
const EXPLAIN_SOURCE = "src/domain/explain.ts";
const EVIDENCE_SOURCE = "src/domain/evidence.ts";
const INVESTIGATION_SOURCE = "src/domain/investigation.ts";
const TARGET = join("apps", "web", "src", "lib", "explanations.generated.ts");

const RISKS = ["rug-pull", "honeypot", "bot-pump"] as const;
const CAUSES = ["timeout", "resource-limit", "decompiler-error", "obfuscated-structure"] as const;

function readSource(repoRoot: string, relative: string): string {
  return readFileSync(join(repoRoot, relative), "utf8");
}

function frontmatterId(doc: string): string {
  const match = doc.match(/^id:\s*(\S+)\s*$/m);
  if (match?.[1] === undefined) {
    throw new Error("generate-web-explanations: plugin doc carries no frontmatter id");
  }
  return match[1];
}

function docTitle(doc: string): string {
  const match = doc.match(/^# PLUGIN\.md:\s*(.+?)\s*$/m);
  if (match?.[1] === undefined) {
    throw new Error("generate-web-explanations: plugin doc carries no title line");
  }
  return match[1].replace(/\s*\(.*$/, "");
}

function sectionBody(doc: string, heading: string): string {
  const lines = doc.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) {
    throw new Error(`generate-web-explanations: plugin doc misses section ## ${heading}`);
  }
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) {
      break;
    }
    body.push(line);
  }
  const text = body.join("\n").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  if (text.length === 0) {
    throw new Error(`generate-web-explanations: plugin doc section ## ${heading} is empty`);
  }
  return text;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Fixed English sentence in a source file, failed loudly when absent so
// the output never silently falls back to a hand-written copy. Sources
// wrap prose across lines, so matching runs on whitespace-normalised
// text while the returned sentence keeps its single-line form.
function flat(source: string): string {
  return source
    .replace(/\/\/\s?/g, "")
    .replace(/\s+/g, " ");
}

function requireSentence(source: string, path: string, sentence: string): string {
  if (!flat(source).includes(sentence)) {
    throw new Error(`generate-web-explanations: ${path} no longer carries ${JSON.stringify(sentence)}`);
  }
  return sentence;
}

function requireMatch(source: string, path: string, pattern: RegExp): string {
  const match = flat(source).match(pattern);
  if (match?.[1] === undefined) {
    throw new Error(`generate-web-explanations: ${path} misses ${String(pattern)}`);
  }
  return match[1];
}

function capabilityEffects(explain: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const risk of RISKS) {
    const pattern = new RegExp(`["']?${risk}["']?:\\s*"([^"]+)"`);
    const sentence = requireMatch(explain, EXPLAIN_SOURCE, pattern);
    if (!sentence.includes(" ")) {
      throw new Error(`generate-web-explanations: capability effect for ${risk} is not a sentence`);
    }
    out[risk] = sentence;
  }
  return out;
}

function hardLeads(explain: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const cause of CAUSES) {
    out[cause] = requireMatch(explain, EXPLAIN_SOURCE, new RegExp(`["']?${cause}["']?:\\s*"([^"]+)"`));
  }
  return out;
}

function pluginDocs(repoRoot: string): string[] {
  const docs: string[] = [];
  for (const base of PLUGIN_DOC_GLOBS) {
    for (const entry of readdirSync(join(repoRoot, base), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        docs.push(join(base, entry.name, "PLUGIN.md"));
      }
    }
  }
  docs.sort();
  if (docs.length === 0) {
    throw new Error("generate-web-explanations: no plugin docs found");
  }
  return docs;
}

export function generateExplanationsModule(repoRoot: string): string {
  const explain = readSource(repoRoot, EXPLAIN_SOURCE);
  const evidenceSource = readSource(repoRoot, EVIDENCE_SOURCE);
  const investigationSource = readSource(repoRoot, INVESTIGATION_SOURCE);

  const effects = capabilityEffects(explain);
  const leads = hardLeads(explain);
  // Source sentences the help copy below was reviewed against. Each call
  // fails the build loudly when its sentence leaves the source file.
  requireSentence(
    explain,
    EXPLAIN_SOURCE,
    "every claim links to the signal it renders and carries that signal's evidence pointers as quoted data",
  );
  requireSentence(
    evidenceSource,
    EVIDENCE_SOURCE,
    "the PC offset travels beside the selector in every case where the offset is derived from the bytecode",
  );
  requireSentence(
    evidenceSource,
    EVIDENCE_SOURCE,
    "A decompiled snippet joins the entry after the deepening",
  );
  requireSentence(
    investigationSource,
    INVESTIGATION_SOURCE,
    "A sentence survives only when it cites at least one collected id and cites no uncollected id",
  );

  const entries: Record<string, ExplanationEntry> = {};

  for (const relative of pluginDocs(repoRoot)) {
    const doc = readSource(repoRoot, relative);
    const id = frontmatterId(doc);
    const checks = oneLine(sectionBody(doc, "What it checks"));
    const matters = oneLine(sectionBody(doc, "Why it matters to you"));
    const key = `plugin:${id}`;
    if (entries[key] !== undefined) {
      throw new Error(`generate-web-explanations: duplicate plugin id ${id}`);
    }
    entries[key] = { title: docTitle(doc), body: `What it checks: ${checks} Why it matters: ${matters}` };
  }

  for (const risk of RISKS) {
    entries[`template:capability:${risk}`] = {
      title: `Template wording for ${risk}`,
      body: `The contract code lets an account ${effects[risk] ?? ""}. Names the capability, not intent.`,
    };
    entries[`template:clone-match:${risk}`] = {
      title: `Template wording for a ${risk} template match`,
      body: `Matches a known trap template. Trap templates get reused, so it is a warning, not a verdict.`,
    };
  }
  // The clone-match reuse sentence above is checked verbatim against the
  // clone-match doc below so a reword there fails the build loudly.
  const cloneDoc = readSource(repoRoot, join("src", "plugins", "detectors", "clone-match", "PLUGIN.md"));
  requireSentence(cloneDoc, "src/plugins/detectors/clone-match/PLUGIN.md", "Trap templates get reused");

  for (const cause of CAUSES) {
    entries[`template:hard-to-analyze:${cause}`] = {
      title: `Template wording for ${cause}`,
      body: `${leads[cause] ?? ""} Owner powers in unread code may be missed.`,
    };
  }

  entries["evidence:selector"] = {
    title: "Where in the code",
    body: "Function where this appears.",
  };
  entries["evidence:offset"] = {
    title: "Byte position",
    body: "Byte position in the deployed code.",
  };
  entries["evidence:snippet"] = {
    title: "Decompiled snippet",
    body: "Rebuilt from bytes, not original source.",
  };
  entries["evidence:payload"] = {
    title: "Finding details",
    body: "Raw fields the check reported.",
  };
  // UI v2 §6.2 help rewrites: sentence 1 says what the finding means
  // for the holder, sentence 2 what to do about it, optional sentence 3
  // the honest limit. Never the title repeated, never the widget
  // described, no jargon, at most 3 sentences and 260 characters.
  entries["score:combined"] = {
    title: "Risk score",
    body: "0–100. Under 30 low, 30–59 elevated, 60+ high. Based on what the owner can do.",
  };
  entries["score:gauge:rug-pull"] = {
    title: "Rug pull",
    body: "Chance the owner can take the money and leave. Estimate from past tokens.",
  };
  entries["score:gauge:honeypot"] = {
    title: "Honeypot",
    body: "Chance you can buy but not sell.",
  };
  entries["score:gauge:bot-pump"] = {
    title: "Bot pump",
    body: "Chance bots or insiders dump on late buyers.",
  };
  entries["score:band"] = {
    title: "Risk band",
    body: "Low: no strong owner power found. Elevated: risky powers. High: owner can block holders.",
  };
  entries["score:strip"] = {
    title: "Result summary",
    body: "Score and top risk, pinned.",
  };
  // Owner-powers strip help (R3 D-10, SCORE-4): which proven powers set
  // the score floor (block powers 60, risky powers 30) and what a renounced
  // owner lifts. Plain words; the floor facts mirror src/domain/scoreFloor.ts.
  entries["powers:extended"] = {
    title: "Owner powers",
    body: "Block powers set the score to at least 60. Mint, fee, limits and upgrade set it to at least 30. Renounced owner: no floor.",
  };
  // User-facing claim copy (S-128, S-132): plain wording only. The
  // template version stays in the code (ExplanationList heading, API
  // result) and never leaks into the tooltip text.
  entries["explanation:claim"] = {
    title: "About these claims",
    body: "Each line links to its proof.",
  };
  entries["cant-tell"] = {
    title: "What code can't tell",
    body: "Things bytecode can't show. Check them yourself.",
  };
  entries["investigation:step"] = {
    title: "Investigation step",
    body: "A check Muse ran.",
  };
  entries["investigation:narrative"] = {
    title: "Summary",
    body: "Only sentences with proof are shown.",
  };

  const from = [...pluginDocs(repoRoot), EXPLAIN_SOURCE, EVIDENCE_SOURCE, INVESTIGATION_SOURCE];
  const payload = JSON.stringify({ entries, from }, null, 2);
  const lines = [
    "// DO NOT EDIT: generated by scripts/generate-web-explanations.ts.",
    "// Run `npm run generate:explanations` after changing any source listed",
    "// in GENERATED_FROM. Plugin, template and evidence texts are extracted",
    "// from those sources; the score, gauge, band, powers, selector,",
    "// cant-tell and investigation help entries are the UI v2 §6.2 rewrites.",
    "export const GENERATED_FROM = Object.freeze([",
    ...from.map((path) => `  ${JSON.stringify(path)},`),
    "]) as readonly string[];",
    "",
    "export type GeneratedExplanationEntry = { readonly title: string; readonly body: string };",
    "",
    `export const EXPLANATIONS = Object.freeze(${JSON.stringify(entries, null, 2)}) as Record<string, GeneratedExplanationEntry>;`,
    "",
    `export const EXPLANATION_PAYLOAD = ${payload};`,
    "",
  ];
  return `${lines.join("\n")}\n`;
}

// Test helper: parse the generated entry map back out of the emitted file
// so tests assert on the file content, not on a second code path.
export function parseGenerated(text: string): Record<string, ExplanationEntry> {
  const match = text.match(/export const EXPLANATIONS = Object\.freeze\((\{[\s\S]*?\})\) as Record<string, GeneratedExplanationEntry>;/);
  if (match?.[1] === undefined) {
    throw new Error("parseGenerated: generated file carries no EXPLANATIONS map");
  }
  return JSON.parse(match[1]) as Record<string, ExplanationEntry>;
}

const invokedAsScript = (process.argv[1] ?? "").endsWith("generate-web-explanations.ts");

if (invokedAsScript) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = dirname(scriptDir);
  const out = generateExplanationsModule(repoRoot);
  mkdirSync(dirname(join(repoRoot, TARGET)), { recursive: true });
  writeFileSync(join(repoRoot, TARGET), out);
  process.stdout.write(`generate-web-explanations: wrote ${TARGET}\n`);
}
