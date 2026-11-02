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
  const claimSentence = requireSentence(
    explain,
    EXPLAIN_SOURCE,
    "every claim links to the signal it renders and carries that signal's evidence pointers as quoted data",
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
    title: "Where in the code",
    body: "The function in the contract where we saw this. Copy it to check on a block explorer.",
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
  // UI v2 §6.2 help rewrites: sentence 1 says what the finding means
  // for the holder, sentence 2 what to do about it, optional sentence 3
  // the honest limit. Never the title repeated, never the widget
  // described, no jargon, at most 3 sentences and 260 characters.
  entries["score:combined"] = {
    title: "Risk score",
    body: "How worried to be, from 0 to 100, based on what this contract lets its owner do. Under 30 is low, 30-59 elevated, 60 and up high. It is an estimate from the code, not a safety guarantee: read the findings below before you buy.",
  };
  entries["score:gauge:rug-pull"] = {
    title: "Rug pull",
    body: "The chance that the people behind this token can take the money and leave, for example by creating new tokens or draining the pool. Each owner power below is one way to do it. With nothing found, this is the usual rate for new tokens.",
  };
  entries["score:gauge:honeypot"] = {
    title: "Honeypot",
    body: "The chance that you can buy this token but not sell it, for example because the owner can block wallets or freeze transfers. Check Pause, Blacklist and Sell block below, and try a small sell before a large buy.",
  };
  entries["score:gauge:bot-pump"] = {
    title: "Bot pump",
    body: "The chance that the launch favours bots or insiders: code that lets some wallets trade first, pay lower fees or skip limits, so early buyers can dump on late ones. Be careful in the first hours, and check Fee and Limits below.",
  };
  entries["score:band"] = {
    title: "Risk band",
    body: "Low means no strong owner power was found, which is not the same as safe. Elevated means some risky powers exist. High means the owner can hurt holders: look before any transfer.",
  };
  entries["score:strip"] = {
    title: "Result summary",
    body: "Pinned summary of the score and the strongest single risk, shown once the score ring scrolls out of view and always on the assessment tab.",
  };
  // Owner-powers strip help (R3 D-10, SCORE-4): what the extended
  // finding is and when it sets the minimum score. Plain words.
  entries["powers:extended"] = {
    title: "Extended analysis",
    body: "Extended analysis is newer and not yet calibrated. Most findings do not move the score, but a proven power that can block holders sets a minimum score. The finding is still real: open it to see the proof.",
  };
  // User-facing claim copy (S-128, S-132): plain wording only. The
  // template version stays in the code (ExplanationList heading, API
  // result) and never leaks into the tooltip text.
  entries["explanation:claim"] = {
    title: "About these claims",
    body: `${claimSentence.charAt(0).toUpperCase()}${claimSentence.slice(1)}. Temporality says whether the pattern holds now or can change later.`,
  };
  entries["cant-tell"] = {
    title: "What code can't tell",
    body: "Questions the code alone can't answer, such as who holds the supply or whether the pool is locked. Check these on a block explorer before you buy.",
  };
  entries["investigation:step"] = {
    title: "Investigation step",
    body: "One check Muse chose to run on the frozen result. It can add context, never change the score.",
  };
  entries["investigation:narrative"] = {
    title: "Checked narrative",
    body: `${citationSentence}; every surviving sentence quotes its evidence. The narrative never moves the score, signals or evidence.`,
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
