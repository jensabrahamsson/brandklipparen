// Typed lookup over the generated explanations (S-113, K-021, K-507).
// The texts live in explanations.generated.ts, built from the plugin
// docs and template sources by scripts/generate-web-explanations.ts; this
// module only keys them for the UI and falls back to a non-empty generic
// entry for unknown keys so the UI never renders empty text. Every
// rendered string stays React text, never a markup sink.
import { EXPLANATIONS } from "./explanations.generated.ts";
import type { GeneratedExplanationEntry } from "./explanations.generated.ts";

export type ExplanationEntry = GeneratedExplanationEntry;

// Every explanation key the token page renders: score components,
// evidence kinds, template claims, can't-tell entries and the
// investigate trace. Plugin keys (`plugin:<id>`) and template frame keys
// (`template:<frame>`) come from the generated map beside these.
const UI_KEYS = [
  "score:combined",
  "score:gauge:rug-pull",
  "score:gauge:honeypot",
  "score:gauge:bot-pump",
  "score:gauges",
  "score:band",
  "score:strip",
  "powers:extended",
  "evidence:selector",
  "evidence:offset",
  "evidence:snippet",
  "evidence:payload",
  "explanation:claim",
  "cant-tell",
  "investigation:step",
  "investigation:narrative",
] as const;

const PLUGIN_IDS = [
  "dev.brandklipparen.capability",
  "dev.brandklipparen.clone-match",
  "dev.brandklipparen.decompiler",
  "dev.brandklipparen.hard-to-analyze",
  "dev.brandklipparen.mint",
  "dev.brandklipparen.blacklist",
  "dev.brandklipparen.transfer-fee",
  "dev.brandklipparen.pause",
  "dev.brandklipparen.transfer-limits",
  "dev.brandklipparen.ownership",
  "dev.brandklipparen.transfer-hooks",
  "dev.brandklipparen.sell-block",
  "dev.brandklipparen.proxy-upgrade",
  "dev.brandklipparen.assessment.meta-model-api",
] as const;

const TEMPLATE_KEYS = [
  "template:capability:rug-pull",
  "template:capability:honeypot",
  "template:capability:bot-pump",
  "template:clone-match:rug-pull",
  "template:clone-match:honeypot",
  "template:clone-match:bot-pump",
  "template:hard-to-analyze:timeout",
  "template:hard-to-analyze:resource-limit",
  "template:hard-to-analyze:decompiler-error",
  "template:hard-to-analyze:obfuscated-structure",
] as const;

// The full key registry the UI may request: static UI keys plus one key
// per known plugin and template frame.
export const EXPLANATION_KEYS: readonly string[] = Object.freeze([
  ...UI_KEYS,
  ...PLUGIN_IDS.map((id) => `plugin:${id}`),
  ...TEMPLATE_KEYS,
]);

const FALLBACK: ExplanationEntry = Object.freeze({
  title: "About this item",
  body: "No help for this yet.",
});

// R2-5 (D-17): the hero gauges share one popover on the "Risk breakdown"
// heading instead of one trigger per gauge. The generated map stays the
// single source for the per-gauge keys; this local entry combines their
// help sentences so the heading popover carries the same meaning the
// three removed triggers had.
const LOCAL_ENTRIES: Readonly<Record<string, ExplanationEntry>> = Object.freeze({
  "score:combined": { title: "Risk score", body: "0–100. Under 30 low, 30–59 elevated, 60+ high. Based on what the owner can do." },
  "score:gauge:rug-pull": { title: "Rug pull", body: "Chance the owner can take the money and leave. Estimate from past tokens." },
  "score:gauge:honeypot": { title: "Honeypot", body: "Chance you can buy but not sell." },
  "score:gauge:bot-pump": { title: "Bot pump", body: "Chance bots or insiders dump on late buyers." },
  "score:band": { title: "Risk band", body: "Low: no strong owner power found. Elevated: risky powers. High: owner can block holders." },
  "score:strip": { title: "Result summary", body: "Score and top risk, pinned." },
  "powers:extended": { title: "Owner powers", body: "Block powers set the score to at least 60. Mint, fee, limits and upgrade set it to at least 30. Renounced owner: no floor." },
  "evidence:offset": { title: "Byte position", body: "Byte position in the deployed code." },
  "evidence:snippet": { title: "Decompiled snippet", body: "Rebuilt from bytes, not original source." },
  "evidence:payload": { title: "Finding details", body: "Raw fields the check reported." },
  "explanation:claim": { title: "About these claims", body: "Each line links to its proof." },
  "cant-tell": { title: "What code can't tell", body: "Things bytecode can't show. Check them yourself." },
  "investigation:step": { title: "Investigation step", body: "A check Muse ran." },
  "investigation:narrative": { title: "Summary", body: "Only sentences with proof are shown." },
  "plugin:dev.brandklipparen.assessment.meta-model-api": { title: "Muse assessment", body: "Muse's second opinion. Score unchanged." },
  "plugin:dev.brandklipparen.blacklist": { title: "Blacklist", body: "Owner can block chosen wallets. Sets score to at least 60. Not if renounced." },
  "plugin:dev.brandklipparen.pause": { title: "Pause", body: "Owner can freeze transfers. Sets score to at least 60. Not if renounced." },
  "plugin:dev.brandklipparen.sell-block": { title: "Sell block", body: "Owner can block sells. Sets score to at least 60. Not if renounced." },
  "plugin:dev.brandklipparen.mint": { title: "Mint", body: "Owner can create tokens. Sets score to at least 30. Not if renounced." },
  "plugin:dev.brandklipparen.transfer-fee": { title: "Transfer fee", body: "Owner can change fees. Sets score to at least 30. Not if renounced." },
  "plugin:dev.brandklipparen.transfer-limits": { title: "Transfer limits", body: "Owner can limit transfers or holdings. Sets score to at least 30. Not if renounced." },
  "plugin:dev.brandklipparen.ownership": { title: "Ownership", body: "Checks who can control the token." },
  "plugin:dev.brandklipparen.proxy-upgrade": { title: "Proxy upgrade", body: "Checks whether the code can be swapped." },
  "plugin:dev.brandklipparen.transfer-hooks": { title: "Transfer hooks", body: "Checks whether transfers call another contract." },
  "plugin:dev.brandklipparen.capability": { title: "Capabilities", body: "Checks what the code can do." },
  "plugin:dev.brandklipparen.clone-match": { title: "Clone match", body: "Checks for a known scam template. A match is not proof of a scam." },
  "plugin:dev.brandklipparen.decompiler": { title: "Decompiler", body: "Rebuilds readable code from bytes." },
  "plugin:dev.brandklipparen.hard-to-analyze": { title: "Obfuscated code", body: "Checks whether code could not be fully read. Hidden powers may be missed." },
  "score:gauges": {
    title: "Risk breakdown",
    body: "Rug pull: owner can take the money. Honeypot: you can buy but not sell. Bot pump: bots dump on late buyers. Estimates from past tokens.",
  },
});

export function explanationFor(key: string): ExplanationEntry {
  const local = LOCAL_ENTRIES[key];
  if (local !== undefined) {
    return local;
  }
  const entry = (EXPLANATIONS as Readonly<Record<string, ExplanationEntry | undefined>>)[key];
  if (entry === undefined || entry.title.length === 0 || entry.body.length === 0) {
    return FALLBACK;
  }
  return entry;
}
