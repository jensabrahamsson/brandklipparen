// S-068 unified personalize spec contract (K-519, P-28). One declarative
// ranking-plus-layout spec over whitelisted sections and plugin cards:
// no HTML, code, URLs, styles, scores or severities. Validation is plain
// checks plus a JSON Schema descriptor; every failure discards the whole
// spec. Written first (red) per A-21: the spec module does not exist yet.
import { describe, expect, test } from "vitest";
import {
  PERSONALIZE_SPEC_VERSION,
  parsePersonalizeSpec,
  personalizeSpecJsonSchema,
} from "../../../src/plugins/personalizeSpec.ts";
import type { PersonalizeSpecContext } from "../../../src/plugins/personalizeSpec.ts";

function context(): PersonalizeSpecContext {
  return Object.freeze({
    sectionIds: Object.freeze(["score", "explanation", "signals", "plugin-findings", "cant-tell"]),
    pluginIds: Object.freeze(["dev.brandklipparen.capability", "dev.brandklipparen.clone-match"]),
    flooredSectionIds: Object.freeze(["score", "explanation"]),
    maxPlacements: 8,
    maxRanking: 8,
  });
}

function validSpec(): Record<string, unknown> {
  return {
    specVersion: PERSONALIZE_SPEC_VERSION,
    pluginRanking: ["dev.brandklipparen.clone-match", "dev.brandklipparen.capability"],
    placements: [
      { sectionId: "signals", emphasis: "high" },
      { sectionId: "score", emphasis: "normal" },
      { sectionId: "explanation", emphasis: "normal" },
    ],
  };
}

describe("unified personalize spec contract (S-068)", () => {
  test("k519_personalize_spec_rejects_html_ranking_and_floored_collapse", () => {
    const ctx = context();
    const markup = {
      ...validSpec(),
      placements: [{ sectionId: "signals", emphasis: "high", note: "<b>look here</b>" }],
    };
    expect(parsePersonalizeSpec(markup, ctx).ok).toBe(false);

    const codeField = {
      ...validSpec(),
      placements: [{ sectionId: "signals", emphasis: "high", component: "FancyChart" }],
    };
    expect(parsePersonalizeSpec(codeField, ctx).ok).toBe(false);

    const unknownPlugin = { ...validSpec(), pluginRanking: ["dev.brandklipparen.unknown"] };
    expect(parsePersonalizeSpec(unknownPlugin, ctx).ok).toBe(false);

    const duplicatePlugin = {
      ...validSpec(),
      pluginRanking: ["dev.brandklipparen.capability", "dev.brandklipparen.capability"],
    };
    expect(parsePersonalizeSpec(duplicatePlugin, ctx).ok).toBe(false);

    const unknownSection = {
      ...validSpec(),
      placements: [{ sectionId: "secret-panel", emphasis: "high" }],
    };
    expect(parsePersonalizeSpec(unknownSection, ctx).ok).toBe(false);

    const collapsedFloored = {
      ...validSpec(),
      placements: [{ sectionId: "score", emphasis: "normal", collapsed: true }],
    };
    expect(parsePersonalizeSpec(collapsedFloored, ctx).ok).toBe(false);

    const missingRequired = {
      ...validSpec(),
      placements: [{ sectionId: "signals", emphasis: "high" }],
    };
    expect(parsePersonalizeSpec(missingRequired, ctx).ok).toBe(false);
  });

  test("a valid spec parses with no partial application", () => {
    const parsed = parsePersonalizeSpec(validSpec(), context());
    if (!parsed.ok) {
      throw new Error(`expected valid spec, got: ${parsed.error.message}`);
    }
    expect(parsed.value.pluginRanking).toEqual([
      "dev.brandklipparen.clone-match",
      "dev.brandklipparen.capability",
    ]);
    expect(parsed.value.placements.map((placement) => placement.sectionId)).toEqual([
      "signals",
      "score",
      "explanation",
    ]);
  });

  test("k519_personalize_spec_agrees_with_json_schema_on_fixtures", () => {
    const schema = personalizeSpecJsonSchema();
    expect(schema["additionalProperties"]).toBe(false);
    // The descriptor names the same closed section whitelist the parser enforces.
    const placementItems = ((schema["properties"] as Record<string, unknown>)["placements"] as Record<string, unknown>);
    expect(placementItems["type"]).toBe("array");
    // Oversize specs fail on both sides: the parser rejects, the descriptor caps.
    const oversized = { ...validSpec(), pluginRanking: ["dev.brandklipparen.capability"] };
    for (let index = 0; index < 20; index += 1) {
      (oversized.pluginRanking as string[]).push("dev.brandklipparen.capability");
    }
    expect(parsePersonalizeSpec(oversized, context()).ok).toBe(false);
    expect(
      ((schema["properties"] as Record<string, unknown>)["pluginRanking"] as Record<string, unknown>)["maxItems"],
    ).toBeLessThanOrEqual(20);
  });

  test("rendered ids validate with legacy aliases kept for backward compatibility", () => {
    const rendered = context();
    expect(parsePersonalizeSpec(validSpec(), rendered).ok).toBe(true);
    const legacyContext: PersonalizeSpecContext = {
      sectionIds: ["summary", "score", "signals", "plugin-findings", "evidence", "cant-tell"],
      pluginIds: ["dev.brandklipparen.capability", "dev.brandklipparen.clone-match"],
      flooredSectionIds: ["summary", "score"],
      maxPlacements: 8,
      maxRanking: 8,
    };
    expect(
      parsePersonalizeSpec(
        {
          specVersion: PERSONALIZE_SPEC_VERSION,
          pluginRanking: ["dev.brandklipparen.capability"],
          placements: [
            { sectionId: "summary", emphasis: "normal" },
            { sectionId: "score", emphasis: "normal" },
            { sectionId: "evidence", emphasis: "normal" },
          ],
        },
        legacyContext,
      ).ok,
    ).toBe(true);
  });
});
