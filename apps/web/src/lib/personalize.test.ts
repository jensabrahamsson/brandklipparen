// S-070 experimental AI layout toggle (K-519, P-27). The visitor's own
// words may leave the device only through one explicit per-request POST
// to the mapping provider. The toggle is off by default, states what the
// first call sends before it fires, and any invalid or missing model
// output falls back to the deterministic baseline with scores, evidence
// and text unchanged. Written first (red) per A-21: the AI personalize
// state module does not exist yet.
import { describe, expect, test } from "vitest";
import {
  AI_PERSONALIZE_KEY,
  PERSONALIZE_SECTIONS,
  aiOrderNotice,
  applyAiSectionOrder,
  describeAiOrderChange,
  normalizeAiSectionId,
  parseAiPersonalizeSpec,
  parsePersonalizeEnvelope,
  parseStoredAiPersonalize,
  personalizeProviderLabel,
  personalizeProviderName,
  readStoredAiPersonalize,
  requiredFlooredSections,
} from "./personalize.ts";
import type { PersonalizeContext } from "./personalize.ts";
import { SECTION_ORDER_STANDARD } from "./layout.ts";
import fixture from "./__fixtures__/personalize-response.meta.json";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get length() {
      return store.size;
    },
    clear: () => {
      store.clear();
    },
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

describe("k519_ai_personalize_toggle_off_by_default_and_labelled", () => {
  test("missing or crafted storage stays off", () => {
    expect(readStoredAiPersonalize(memoryStorage())).toBe(false);
    expect(readStoredAiPersonalize(null)).toBe(false);
    expect(parseStoredAiPersonalize(null)).toBe(false);
    expect(parseStoredAiPersonalize("on")).toBe(true);
    expect(parseStoredAiPersonalize("off")).toBe(false);
    expect(parseStoredAiPersonalize("ON")).toBe(false);
    expect(parseStoredAiPersonalize("<script>alert(1)</script>")).toBe(false);
    expect(parseStoredAiPersonalize("{\"ai\":true}")).toBe(false);
  });

  test("the versioned key round-trips the explicit opt-in only", () => {
    expect(AI_PERSONALIZE_KEY).toBe("brandklipparen-ai-personalize:v1");
    expect(readStoredAiPersonalize(memoryStorage({ [AI_PERSONALIZE_KEY]: "on" }))).toBe(true);
  });
});

const CONTEXT: PersonalizeContext = {
  sectionIds: ["summary", "score", "signals", "plugin-findings", "evidence", "cant-tell", "expert-detail"],
  pluginIds: ["dev.brandklipparen.capability", "dev.brandklipparen.clone-match"],
  flooredSectionIds: ["summary", "score"],
};

function validSpecBody(): Record<string, unknown> {
  return {
    specVersion: 1,
    pluginRanking: ["dev.brandklipparen.clone-match", "dev.brandklipparen.capability"],
    placements: [
      { sectionId: "signals", emphasis: "high" },
      { sectionId: "summary", emphasis: "normal" },
      { sectionId: "score", emphasis: "normal" },
    ],
  };
}

describe("the experimental AI layout label names the configured provider honestly", () => {
  test("a configured provider names its provider and model id", () => {
    expect(
      personalizeProviderLabel({ provider: "meta-model-api", modelId: "test-model-1" }),
    ).toBe("Uses meta-model-api · test-model-1.");
    expect(personalizeProviderName({ provider: "meta-model-api", modelId: "test-model-1" })).toBe(
      "meta-model-api · test-model-1",
    );
  });

  test("a meta-model-api provider names its own provider and model id", () => {
    expect(personalizeProviderLabel({ provider: "meta-model-api", modelId: "test-meta-1" })).toBe(
      "Uses meta-model-api · test-meta-1.",
    );
    expect(personalizeProviderName({ provider: "meta-model-api", modelId: "test-meta-1" })).toBe(
      "meta-model-api · test-meta-1",
    );
  });

  test("an unconfigured server says so", () => {
    expect(personalizeProviderLabel(null)).toBe("Not set up on this server.");
    expect(personalizeProviderName(null)).toBe("the mapping provider");
  });
});

describe("AI spec validation falls back to the deterministic baseline", () => {
  test("a valid spec parses with ranking and placements", () => {
    const spec = parseAiPersonalizeSpec(validSpecBody(), CONTEXT);
    expect(spec?.pluginRanking).toEqual(["dev.brandklipparen.clone-match", "dev.brandklipparen.capability"]);
    expect(spec?.placements.map((placement) => placement.sectionId)).toEqual(["signals", "summary", "score"]);
  });

  test("markup, unknown ids and floored collapse fall back to null", () => {
    expect(parseAiPersonalizeSpec({ ...validSpecBody(), extra: 1 }, CONTEXT)).toBe(null);
    expect(parseAiPersonalizeSpec({ ...validSpecBody(), pluginRanking: ["dev.unknown"] }, CONTEXT)).toBe(null);
    expect(
      parseAiPersonalizeSpec(
        {
          ...validSpecBody(),
          placements: [{ sectionId: "score", emphasis: "normal", collapsed: true }],
        },
        CONTEXT,
      ),
    ).toBe(null);
    expect(parseAiPersonalizeSpec({ ...validSpecBody(), pluginRanking: [] }, CONTEXT)).not.toBe(null);
  });

  test("the route envelope parses on ok and falls back on any error kind", () => {
    expect(parsePersonalizeEnvelope({ personalize: { kind: "ok", spec: validSpecBody() } }, CONTEXT)).not.toBe(null);
    expect(parsePersonalizeEnvelope({ personalize: { kind: "error", error: "invalid-output" } }, CONTEXT)).toBe(null);
    expect(parsePersonalizeEnvelope({ personalize: { kind: "error", error: "not-configured" } }, CONTEXT)).toBe(null);
    expect(parsePersonalizeEnvelope(null, CONTEXT)).toBe(null);
  });

describe("zod AI spec validation against the component whitelist", () => {
  test("unknown top-level and placement fields fall back to null", () => {
    expect(parseAiPersonalizeSpec({ ...validSpecBody(), style: "dark" }, CONTEXT)).toBe(null);
    expect(parseAiPersonalizeSpec({ ...validSpecBody(), code: "x" }, CONTEXT)).toBe(null);
    expect(
      parseAiPersonalizeSpec(
        {
          ...validSpecBody(),
          placements: [{ sectionId: "signals", emphasis: "high", href: "https://example.invalid" }],
        },
        CONTEXT,
      ),
    ).toBe(null);
  });

  test("wrong shapes fall back to null", () => {
    expect(parseAiPersonalizeSpec({ ...validSpecBody(), specVersion: "1" }, CONTEXT)).toBe(null);
    expect(parseAiPersonalizeSpec({ ...validSpecBody(), specVersion: 2 }, CONTEXT)).toBe(null);
    expect(
      parseAiPersonalizeSpec({ ...validSpecBody(), pluginRanking: ["dev.brandklipparen.capability", 42] }, CONTEXT),
    ).toBe(null);
    expect(parseAiPersonalizeSpec({ ...validSpecBody(), pluginRanking: [""] }, CONTEXT)).toBe(null);
    expect(
      parseAiPersonalizeSpec(
        { ...validSpecBody(), placements: [{ sectionId: "signals", emphasis: "urgent" }] },
        CONTEXT,
      ),
    ).toBe(null);
    expect(
      parseAiPersonalizeSpec(
        { ...validSpecBody(), placements: [{ sectionId: "signals", emphasis: "high", collapsed: "yes" }] },
        CONTEXT,
      ),
    ).toBe(null);
    expect(parseAiPersonalizeSpec({ ...validSpecBody(), placements: "signals" }, CONTEXT)).toBe(null);
    expect(parseAiPersonalizeSpec(null, CONTEXT)).toBe(null);
    expect(parseAiPersonalizeSpec([], CONTEXT)).toBe(null);
  });

  test("unknown or duplicate components fall back to null", () => {
    expect(
      parseAiPersonalizeSpec(
        { ...validSpecBody(), pluginRanking: ["dev.brandklipparen.no-such-plugin"] },
        CONTEXT,
      ),
    ).toBe(null);
    expect(
      parseAiPersonalizeSpec(
        {
          ...validSpecBody(),
          pluginRanking: ["dev.brandklipparen.capability", "dev.brandklipparen.capability"],
        },
        CONTEXT,
      ),
    ).toBe(null);
    expect(
      parseAiPersonalizeSpec(
        { ...validSpecBody(), placements: [{ sectionId: "no-such-section", emphasis: "high" }] },
        CONTEXT,
      ),
    ).toBe(null);
    expect(
      parseAiPersonalizeSpec(
        {
          ...validSpecBody(),
          placements: [
            { sectionId: "signals", emphasis: "high" },
            { sectionId: "signals", emphasis: "low" },
            { sectionId: "summary", emphasis: "normal" },
            { sectionId: "score", emphasis: "normal" },
          ],
        },
        CONTEXT,
      ),
    ).toBe(null);
  });

  test("oversize specs and missing summary or score fall back to null", () => {
    const manyChecks = Array.from({ length: 17 }, (_, index) => `dev.brandklipparen.p${index}`);
    expect(parseAiPersonalizeSpec({ ...validSpecBody(), pluginRanking: manyChecks }, CONTEXT)).toBe(null);
    const manyPlacements = Array.from({ length: 17 }, () => ({ sectionId: "signals", emphasis: "high" }));
    expect(parseAiPersonalizeSpec({ ...validSpecBody(), placements: manyPlacements }, CONTEXT)).toBe(null);
    expect(
      parseAiPersonalizeSpec(
        { ...validSpecBody(), placements: [{ sectionId: "signals", emphasis: "high" }] },
        CONTEXT,
      ),
    ).toBe(null);
  });

  test("the deterministic fallback stands: null parses to the baseline order", () => {
    expect(parseAiPersonalizeSpec({ ...validSpecBody(), pluginRanking: ["unknown"] }, CONTEXT)).toBe(null);
  });
});

  test("section order applies placements with the floor clamped first", () => {
    const spec = parseAiPersonalizeSpec(validSpecBody(), CONTEXT);
    if (spec === null) {
      throw new Error("expected the spec to parse");
    }
    expect(applyAiSectionOrder(["score", "signals", "plugin-findings"], spec, ["score"])).toEqual([
      "score",
      "signals",
      "plugin-findings",
    ]);
  });

  test("an extended floor never pushes signals above the pinned score", () => {
    const spec = parseAiPersonalizeSpec(validSpecBody(), CONTEXT);
    if (spec === null) {
      throw new Error("expected the spec to parse");
    }
    expect(
      applyAiSectionOrder(
        ["score", "signals", "plugin-findings"],
        spec,
        ["score", "signals", "explanation"],
      ),
    ).toEqual(["score", "signals", "plugin-findings"]);
  });

  test("floored sections follow the envelope: score and explanation always floor", () => {
    expect(requiredFlooredSections([])).toEqual(["score", "explanation"]);
    expect(requiredFlooredSections([{ severity: "low", direction: "lowers" }])).toEqual([
      "score",
      "explanation",
    ]);
    expect(requiredFlooredSections([{ severity: "medium", direction: "raises" }])).toEqual([
      "score",
      "explanation",
      "signals",
    ]);
    expect(requiredFlooredSections([{ severity: "high", direction: "raises" }])).toEqual([
      "score",
      "explanation",
      "signals",
    ]);
  });

  test("a spec collapsing signals is rejected when a high signal is present", () => {
    const floored = requiredFlooredSections([{ severity: "high", direction: "raises" }]);
    const context: PersonalizeContext = { ...CONTEXT, flooredSectionIds: [...floored] };
    expect(
      parseAiPersonalizeSpec(
        {
          ...validSpecBody(),
          placements: [
            { sectionId: "signals", emphasis: "normal", collapsed: true },
            { sectionId: "summary", emphasis: "normal" },
            { sectionId: "score", emphasis: "normal" },
          ],
        },
        context,
      ),
    ).toBe(null);
    expect(parseAiPersonalizeSpec(validSpecBody(), context)).not.toBe(null);
  });
});

describe("legacy model ids normalize to rendered sections (P0-4)", () => {
  test("summary reads as score and evidence reads as explanation", () => {
    expect(normalizeAiSectionId("summary")).toBe("score");
    expect(normalizeAiSectionId("evidence")).toBe("explanation");
    expect(normalizeAiSectionId("score")).toBe("score");
    expect(normalizeAiSectionId("assessment")).toBe(null);
    expect(normalizeAiSectionId("expert-detail")).toBe(null);
    expect(normalizeAiSectionId("no-such-section")).toBe(null);
  });

  test("the offered ids share the rendered source", () => {
    for (const rendered of SECTION_ORDER_STANDARD) {
      expect(PERSONALIZE_SECTIONS).toContain(rendered);
    }
  });

  test("the diff notice names moved sections and keeps the trust suffix", () => {
    const plan = ["score", "signals", "cant-tell", "plugin-findings", "explanation"];
    const applied = ["score", "signals", "plugin-findings", "explanation", "cant-tell"];
    expect(describeAiOrderChange(plan, applied).movedUp).toEqual(["Checks", "Why this score"]);
    expect(describeAiOrderChange(plan, applied).lowered).toEqual(["Can't-tell"]);
    expect(aiOrderNotice(plan, applied)).toContain("Sorted by AI");
    expect(aiOrderNotice(plan, applied)).toContain("Score unchanged.");
  });
});

describe("recorded model response keeps the explanation above cant-tell (P0-4)", () => {
  test("applying the synthetic fixture keeps score first with no empty wrappers", () => {
    const body = fixture as unknown;
    const recorded = (body as { personalize?: { spec?: unknown } }).personalize?.spec as {
      readonly pluginRanking?: readonly string[];
      readonly placements?: readonly { readonly sectionId?: unknown }[];
    };
    const ranking = [...(recorded?.pluginRanking ?? [])];
    const context: PersonalizeContext = {
      sectionIds: [...PERSONALIZE_SECTIONS],
      pluginIds: [...ranking],
      flooredSectionIds: [...requiredFlooredSections([])],
    };
    const spec = parsePersonalizeEnvelope(body, context);
    expect(spec).not.toBe(null);
    if (spec === null) {
      throw new Error("the recorded fixture must parse");
    }
    const applied = applyAiSectionOrder([...SECTION_ORDER_STANDARD], spec, [...requiredFlooredSections([])]);
    expect(applied[0]).toBe("score");
    expect(applied.indexOf("explanation")).toBeLessThan(applied.indexOf("cant-tell"));
    const rendered = new Set(SECTION_ORDER_STANDARD);
    for (const id of applied) {
      expect(rendered.has(id)).toBe(true);
    }
    expect(new Set(applied).size).toBe(applied.length);
  });
});

describe("score and explanation pin above AI order (N-1)", () => {
  function buriedExplanationSpec(): ReturnType<typeof parseAiPersonalizeSpec> {
    const context: PersonalizeContext = {
      sectionIds: [...SECTION_ORDER_STANDARD],
      pluginIds: ["dev.brandklipparen.capability", "dev.brandklipparen.clone-match"],
      flooredSectionIds: [...requiredFlooredSections([])],
    };
    return parseAiPersonalizeSpec(
      {
        specVersion: 1,
        pluginRanking: ["dev.brandklipparen.capability", "dev.brandklipparen.clone-match"],
        placements: [
          { sectionId: "plugin-findings", emphasis: "high" },
          { sectionId: "signals", emphasis: "high" },
          { sectionId: "cant-tell", emphasis: "normal" },
          { sectionId: "score", emphasis: "normal" },
          { sectionId: "explanation", emphasis: "normal" },
        ],
      },
      context,
    );
  }

  test("plugin findings and signals first with explanation last still pin score then explanation without a high signal", () => {
    const spec = buriedExplanationSpec();
    expect(spec).not.toBe(null);
    if (spec === null) {
      throw new Error("expected the buried spec to parse");
    }
    const floored = requiredFlooredSections([]);
    const applied = applyAiSectionOrder([...SECTION_ORDER_STANDARD], spec, [...floored]);
    expect(applied[0]).toBe("score");
    expect(applied[1]).toBe("explanation");
  });

  test("the same buried order pins score then explanation with a high signal", () => {
    const spec = buriedExplanationSpec();
    expect(spec).not.toBe(null);
    if (spec === null) {
      throw new Error("expected the buried spec to parse");
    }
    const floored = requiredFlooredSections([{ severity: "high", direction: "raises" }]);
    const applied = applyAiSectionOrder([...SECTION_ORDER_STANDARD], spec, [...floored]);
    expect(applied[0]).toBe("score");
    expect(applied[1]).toBe("explanation");
    expect(applied.indexOf("signals")).toBeGreaterThan(1);
  });

  test("the synthetic fixture still yields score first and explanation second", () => {
    const body = fixture as unknown;
    const recorded = (body as { personalize?: { spec?: unknown } }).personalize?.spec as {
      readonly pluginRanking?: readonly string[];
    };
    const ranking = [...(recorded?.pluginRanking ?? [])];
    const context: PersonalizeContext = {
      sectionIds: [...PERSONALIZE_SECTIONS],
      pluginIds: [...ranking],
      flooredSectionIds: [...requiredFlooredSections([])],
    };
    const spec = parsePersonalizeEnvelope(body, context);
    expect(spec).not.toBe(null);
    if (spec === null) {
      throw new Error("the recorded fixture must parse");
    }
    const applied = applyAiSectionOrder([...SECTION_ORDER_STANDARD], spec, [...requiredFlooredSections([])]);
    expect(applied[0]).toBe("score");
    expect(applied[1]).toBe("explanation");
  });
});
