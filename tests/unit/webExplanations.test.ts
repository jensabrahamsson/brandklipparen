// Coverage for the generated web explanations (S-113, K-021, K-301).
// Written first per A-21 (red): scripts/generate-web-explanations.ts and
// apps/web/src/lib/explanations.generated.ts do not exist yet. The test
// pins derivation, not hand copy: regenerating from the plugin docs and
// template sources must give the byte-identical file, every plugin id,
// template catalogue id and UI key must carry a non-empty explanation,
// and known source sentences must appear verbatim in the output.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const GENERATED = join(repoRoot, "apps", "web", "src", "lib", "explanations.generated.ts");

// UI keys the token page renders explanations for: score components,
// evidence kinds, template claims, can't-tell entries and the
// investigate trace. The web lookup module must serve every one.
const UI_KEYS = [
  "score:combined",
  "score:gauge:rug-pull",
  "score:gauge:honeypot",
  "score:gauge:bot-pump",
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

// Template catalogue ids from src/domain/explain.ts: one capability frame
// per risk, one clone-match frame per risk, one hard-to-analyze frame per
// cause.
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

function generatedText(): string {
  return readFileSync(GENERATED, "utf8");
}

describe("generated web explanations (S-113)", () => {
  test("s113_regeneration_is_byte_identical", async () => {
    const { generateExplanationsModule } = await import("../../scripts/generate-web-explanations.ts");
    expect(generateExplanationsModule(repoRoot)).toBe(generatedText());
  });

  test("s113_every_plugin_has_a_non_empty_explanation", async () => {
    const module = await import("../../scripts/generate-web-explanations.ts");
    const parsed = module.parseGenerated(generatedText());
    for (const id of PLUGIN_IDS) {
      const entry = parsed[`plugin:${id}`];
      expect(entry, `missing plugin:${id}`).toBeDefined();
      expect(entry?.title.length ?? 0).toBeGreaterThan(0);
      expect(entry?.body.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("s113_every_template_frame_has_a_non_empty_explanation", async () => {
    const module = await import("../../scripts/generate-web-explanations.ts");
    const parsed = module.parseGenerated(generatedText());
    for (const key of TEMPLATE_KEYS) {
      const entry = parsed[key];
      expect(entry, `missing ${key}`).toBeDefined();
      expect(entry?.title.length ?? 0).toBeGreaterThan(0);
      expect(entry?.body.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("s113_every_ui_key_has_a_non_empty_explanation", async () => {
    const module = await import("../../scripts/generate-web-explanations.ts");
    const parsed = module.parseGenerated(generatedText());
    for (const key of UI_KEYS) {
      const entry = parsed[key];
      expect(entry, `missing ${key}`).toBeDefined();
      expect(entry?.title.length ?? 0).toBeGreaterThan(0);
      expect(entry?.body.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("s113_texts_carry_verbatim_source_sentences", () => {
    const text = generatedText();
    // Sentences taken from the sources the generator reads: the template
    // frames in src/domain/explain.ts and the plugin docs. If a source is
    // reworded, the generator output must change with it instead of
    // drifting silently.
    expect(text).toContain("move funds out of the contract");
    expect(text).toContain("The analysis ran out of time before it could read all of the code.");
    expect(text).toContain("The code structure resists direct reading");
    expect(text).toContain("one occurrence is enough");
    expect(text).toContain("Trap templates get reused");
  });
});
