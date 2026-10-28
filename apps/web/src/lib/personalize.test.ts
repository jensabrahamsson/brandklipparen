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
  applyAiSectionOrder,
  parseAiPersonalizeSpec,
  parsePersonalizeEnvelope,
  parseStoredAiPersonalize,
  readStoredAiPersonalize,
  requiredFlooredSections,
} from "./personalize.ts";
import type { PersonalizeContext } from "./personalize.ts";

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
    const manyPlugins = Array.from({ length: 17 }, (_, index) => `dev.brandklipparen.p${index}`);
    expect(parseAiPersonalizeSpec({ ...validSpecBody(), pluginRanking: manyPlugins }, CONTEXT)).toBe(null);
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
    expect(applyAiSectionOrder(["score", "signals", "plugin-findings"], spec, ["summary", "score"])).toEqual([
      "summary",
      "score",
      "signals",
      "plugin-findings",
    ]);
  });

  test("an extended floor never pushes signals above the pinned summary and score", () => {
    const spec = parseAiPersonalizeSpec(validSpecBody(), CONTEXT);
    if (spec === null) {
      throw new Error("expected the spec to parse");
    }
    expect(
      applyAiSectionOrder(
        ["summary", "score", "signals", "plugin-findings"],
        spec,
        ["summary", "score", "signals", "evidence"],
      ),
    ).toEqual(["summary", "score", "signals", "plugin-findings"]);
  });

  test("floored sections follow the envelope: high signals floor signals and evidence", () => {
    expect(requiredFlooredSections([])).toEqual(["summary", "score"]);
    expect(requiredFlooredSections([{ severity: "low", direction: "lowers" }])).toEqual(["summary", "score"]);
    expect(requiredFlooredSections([{ severity: "medium", direction: "raises" }])).toEqual([
      "summary",
      "score",
      "signals",
    ]);
    expect(requiredFlooredSections([{ severity: "high", direction: "raises" }])).toEqual([
      "summary",
      "score",
      "signals",
      "evidence",
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
