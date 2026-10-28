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
  "score:band",
  "score:strip",
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
  "dev.brandklipparen.assessment.meta-model-api",
  "dev.brandklipparen.assessment.hosted-open-weights",
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
  body: "This item carries no dedicated explanation yet. The score, signals and evidence beside it are unchanged.",
});

export function explanationFor(key: string): ExplanationEntry {
  const entry = (EXPLANATIONS as Readonly<Record<string, ExplanationEntry | undefined>>)[key];
  if (entry === undefined || entry.title.length === 0 || entry.body.length === 0) {
    return FALLBACK;
  }
  return entry;
}
