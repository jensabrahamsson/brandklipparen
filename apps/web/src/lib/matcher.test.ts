// S-067 deterministic priority baseline (K-035, P-25). Pure keyword/tag
// matching over validated frontmatter: frozen priorities plus frozen
// frontmatter give one ordered id list with matched tags, with zero
// network calls. The severity floor (P-26) keeps every high finding
// visible through ordering only. Written first (red) per A-21: the
// matcher does not exist yet.
import { describe, expect, test } from "vitest";
import { applyPersonalizedOrder, matchPriorities } from "./matcher.ts";
import type { PluginFrontmatterView } from "./matcher.ts";

const FRONTMATTER: readonly PluginFrontmatterView[] = [
  { id: "dev.brandklipparen.capability", tags: ["owner-powers", "upgradeability"], severityMax: "high" },
  { id: "dev.brandklipparen.clone-match", tags: ["honeypot"], severityMax: "high" },
  { id: "dev.brandklipparen.example-fee-capability", tags: ["fees"], severityMax: "medium" },
];

describe("k035_priorities_match_frontmatter_tags_deterministically", () => {
  test("owner-stop-selling maps to honeypot and owner-powers matches", () => {
    const first = matchPriorities("I want to know if the owner can stop me selling", FRONTMATTER);
    const second = matchPriorities("I want to know if the owner can stop me selling", FRONTMATTER);
    expect(second).toEqual(first);
    expect(first.orderedIds).toContain("dev.brandklipparen.capability");
    expect(first.orderedIds).toContain("dev.brandklipparen.clone-match");
    expect(first.orderedIds).not.toContain("dev.brandklipparen.example-fee-capability");
    expect(first.matchedTags.get("dev.brandklipparen.capability")).toContain("owner-powers");
    expect(first.matchedTags.get("dev.brandklipparen.clone-match")).toContain("honeypot");
  });

  test("fee worries match the fee plugin only", () => {
    const matched = matchPriorities("Can fees change on every buy?", FRONTMATTER);
    expect(matched.orderedIds).toEqual(["dev.brandklipparen.example-fee-capability"]);
    expect(matched.matchedTags.get("dev.brandklipparen.example-fee-capability")).toEqual(["fees"]);
  });

  test("empty or unmatched priorities give the standard order", () => {
    expect(matchPriorities("", FRONTMATTER).orderedIds).toEqual([]);
    expect(matchPriorities("   ", FRONTMATTER).orderedIds).toEqual([]);
    expect(matchPriorities("What a nice day for a walk", FRONTMATTER).orderedIds).toEqual([]);
  });

  test("ties break by severity max, then id, deterministically", () => {
    const plugins: readonly PluginFrontmatterView[] = [
      { id: "dev.example.b", tags: ["fees"], severityMax: "low" },
      { id: "dev.example.a", tags: ["fees"], severityMax: "high" },
    ];
    const matched = matchPriorities("fees", plugins);
    expect(matched.orderedIds).toEqual(["dev.example.a", "dev.example.b"]);
  });
});

describe("k519_priorities_never_sent_without_ai_opt_in", () => {
  test("baseline matching makes zero network calls", () => {
    const calls: string[] = [];
    const globalScope = globalThis as Record<string, unknown>;
    const previousFetch = globalScope["fetch"];
    globalScope["fetch"] = (...args: unknown[]): Promise<never> => {
      calls.push(String(args[0]));
      throw new Error("network is forbidden in the deterministic baseline");
    };
    try {
      matchPriorities("I want to know if the owner can stop me selling", FRONTMATTER);
    } finally {
      globalScope["fetch"] = previousFetch;
    }
    expect(calls).toEqual([]);
  });
});

describe("k519_personalization_leaves_scores_evidence_and_text_unchanged", () => {
  test("ordering only reorders: members stay identical", () => {
    const sections = [
      { id: "score", body: "84 High" },
      { id: "signals", body: "signal text" },
      { id: "plugin-findings", body: "finding text" },
    ];
    const ordered = applyPersonalizedOrder(sections, ["plugin-findings"], ["score"]);
    expect(ordered.map((section) => section.id)).toEqual(["score", "plugin-findings", "signals"]);
    expect(ordered.map((section) => section.body)).toEqual(["84 High", "finding text", "signal text"]);
  });

  test("unknown ids in the order are ignored and floored sections clamp first", () => {
    const sections = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const ordered = applyPersonalizedOrder(sections, ["c", "unknown-id"], ["a"]);
    expect(ordered.map((section) => section.id)).toEqual(["a", "c", "b"]);
  });
});
