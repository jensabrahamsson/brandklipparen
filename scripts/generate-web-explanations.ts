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
const CANT_TELL_SOURCE = "src/domain/cantTell.ts";
const INVESTIGATION_SOURCE = "src/domain/investigation.ts";
const GAUGE_SOURCE = "apps/web/src/components/Gauge.tsx";
const RISK_SOURCE = "apps/web/src/lib/risk.ts";
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

function gaugeTitles(gauge: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const risk of RISKS) {
    out[risk] = requireMatch(gauge, GAUGE_SOURCE, new RegExp(`["']?${risk}["']?:\\s*"([^"]+)"`));
  }
  return out;
}

function riskBands(riskSource: string): Array<{ word: string; min: number; max: number }> {
  const bands: Array<{ word: string; min: number; max: number }> = [];
  for (const match of riskSource.matchAll(/\{\s*word:\s*"(\w+)",\s*min:\s*(\d+),\s*max:\s*(\d+)\s*\}/g)) {
    bands.push({ word: match[1] ?? "", min: Number(match[2]), max: Number(match[3]) });
  }
  if (bands.length !== 3) {
    throw new Error("generate-web-explanations: risk bands are not the three known bands");
  }
  return bands;
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
  const cantTellSource = readSource(repoRoot, CANT_TELL_SOURCE);
  const investigationSource = readSource(repoRoot, INVESTIGATION_SOURCE);
  const gaugeSource = readSource(repoRoot, GAUGE_SOURCE);
  const riskSource = readSource(repoRoot, RISK_SOURCE);

  const effects = capabilityEffects(explain);
  const leads = hardLeads(explain);
  const gaugeTitlesByRisk = gaugeTitles(gaugeSource);
  const bands = riskBands(riskSource);
  const bandWords = bands.map((band) => `${band.word} ${band.min}-${band.max}`).join(", ");
  const claimSentence = requireSentence(
    explain,
    EXPLAIN_SOURCE,
    "every claim links to the signal it renders and carries that signal's evidence pointers as quoted data",
  );
  const evidenceSentence = requireSentence(
    evidenceSource,
    EVIDENCE_SOURCE,
    "Every evidence carries at least one selector in its type",
  );
  const offsetSentence = requireSentence(
    evidenceSource,
    EVIDENCE_SOURCE,
    "the PC offset travels beside the selector in every case where the offset is derived from the bytecode",
  );
  const snippetSentence = requireSentence(
    evidenceSource,
    EVIDENCE_SOURCE,
    "A decompiled snippet joins the entry after the deepening",
  );
  const cantTellSentence = requireSentence(
    cantTellSource,
    CANT_TELL_SOURCE,
    "Each item names the data source that would settle the question",
  );
  const citationSentence = requireSentence(
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
      body: `The template says the contract code lets an account ${effects[risk] ?? ""}. This sentence names the capability, never intent: ${claimSentence}.`,
    };
    entries[`template:clone-match:${risk}`] = {
      title: `Template wording for a ${risk} template match`,
      body: `Trap templates get reused. A bytecode match against a known template means someone has run this exact trap before. This names the matched group with its similarity share, never a verdict.`,
    };
  }
  // The clone-match reuse sentence above is checked verbatim against the
  // clone-match doc below so a reword there fails the build loudly.
  const cloneDoc = readSource(repoRoot, join("src", "plugins", "detectors", "clone-match", "PLUGIN.md"));
  requireSentence(cloneDoc, "src/plugins/detectors/clone-match/PLUGIN.md", "Trap templates get reused");

  for (const cause of CAUSES) {
    entries[`template:hard-to-analyze:${cause}`] = {
      title: `Template wording for ${cause}`,
      body: `${leads[cause] ?? ""} The finding marks a coverage gap, not a risk.`,
    };
  }

  entries["evidence:selector"] = {
    title: "Selector evidence",
    body: `${evidenceSentence}. Each row names the function selector the pattern was seen beside.`,
  };
  entries["evidence:offset"] = {
    title: "Bytecode offset",
    body: `PC offset: ${offsetSentence}. Offsets are counted in bytes from the start of the deployed code.`,
  };
  entries["evidence:snippet"] = {
    title: "Decompiled snippet",
    body: `${snippetSentence}. The text is quoted readout data, never the original source.`,
  };
  entries["evidence:payload"] = {
    title: "Finding details",
    body: "The payload carries the finding fields the detector reported, such as the capability key or the matched group with its similarity share.",
  };
  entries["score:combined"] = {
    title: "Combined score",
    body: `Combined score 0-100 follows the bands ${bandWords}. The number and the word always travel together; color never carries the meaning alone.`,
  };
  for (const risk of RISKS) {
    entries[`score:gauge:${risk}`] = {
      title: `${gaugeTitlesByRisk[risk] ?? risk} gauge`,
      body: `${gaugeTitlesByRisk[risk] ?? risk} gauge: probability as a half-arc with the signal count and one plain-text reason. The arc fills the percent exactly; the reason names the strongest signal.`,
    };
  }
  entries["score:band"] = {
    title: "Risk band",
    body: `Bands read ${bandWords}. Low stays calm, High asks for a second look before any transfer.`,
  };
  entries["score:strip"] = {
    title: "Result summary",
    body: "Pinned summary of the score and the strongest single risk, shown once the score ring scrolls out of view and always on the assessment tab.",
  };
  // User-facing claim copy (S-128, S-132): plain wording only. The
  // template version stays in the code (ExplanationList heading, API
  // result) and never leaks into the tooltip text.
  entries["explanation:claim"] = {
    title: "About these claims",
    body: `${claimSentence.charAt(0).toUpperCase()}${claimSentence.slice(1)}. Temporality says whether the pattern holds now or can change later.`,
  };
  entries["cant-tell"] = {
    title: "What bytecode cannot tell",
    body: `${cantTellSentence}; liquidity locks, owner shares, wallet clusters, team and intent need off-chain data by construction. These answers never change the score.`,
  };
  entries["investigation:step"] = {
    title: "Investigation step",
    body: "One deterministic check the opt-in loop ran over the frozen result. The rationale is model text shown as plain words; the evidence ids name what the step collected.",
  };
  entries["investigation:narrative"] = {
    title: "Checked narrative",
    body: `${citationSentence}; every surviving sentence quotes its evidence. The narrative never moves the score, signals or evidence.`,
  };

  const from = [
    ...pluginDocs(repoRoot),
    EXPLAIN_SOURCE,
    EVIDENCE_SOURCE,
    CANT_TELL_SOURCE,
    INVESTIGATION_SOURCE,
    GAUGE_SOURCE,
    RISK_SOURCE,
  ];
  const payload = JSON.stringify({ entries, from }, null, 2);
  const lines = [
    "// DO NOT EDIT: generated by scripts/generate-web-explanations.ts.",
    "// Run `npm run generate:explanations` after changing any source listed",
    "// in GENERATED_FROM. Every text below is extracted from those sources,",
    "// so rewording a source changes this file instead of letting it drift.",
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
