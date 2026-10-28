// Plugin parsing for the token page (S-059, K-034). Malformed registry
// or result entries are dropped; hostile payloads pass through as data
// for the inert-text renderer, never as markup.
import { describe, expect, test } from "vitest";
import { toPluginListEntries, toPluginResultViews } from "./plugins.ts";

describe("plugin parsing for the schema-driven panel", () => {
  test("registry entries keep identity, display text and outputSchema", () => {
    const entries = toPluginListEntries([
      {
        id: "dev.brandklipparen.capability",
        version: "1.0.0",
        displayName: "Capability detector",
        description: "Reports raw capability keys.",
        outputSchema: { type: "array" },
        frontmatter: {
          tags: ["owner-powers", "upgradeability"],
          audience: ["holder", "auditor"],
          severity: { min: "low", max: "high" },
        },
      },
      { id: "", displayName: "Nameless" },
      "junk",
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "dev.brandklipparen.capability", displayName: "Capability detector" });
    expect(entries[0]?.outputSchema).toEqual({ type: "array" });
    expect(entries[0]?.frontmatter?.tags).toEqual(["owner-powers", "upgradeability"]);
    expect(entries[0]?.frontmatter?.severity).toEqual({ min: "low", max: "high" });
  });

  test("malformed frontmatter is dropped while the entry stays", () => {
    const entries = toPluginListEntries([
      {
        id: "dev.brandklipparen.capability",
        version: "1.0.0",
        displayName: "Capability detector",
        description: "Reports raw capability keys.",
        frontmatter: { tags: "honeypot", audience: [], severity: { min: "low" } },
      },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.frontmatter).toBeUndefined();
  });

  test("non-list input gives no entries", () => {
    expect(toPluginListEntries(null)).toEqual([]);
    expect(toPluginListEntries({})).toEqual([]);
  });

  test("result findings keep title, payload and evidence", () => {
    const views = toPluginResultViews([
      {
        pluginId: "dev.brandklipparen.capability",
        pluginVersion: "1.0.0",
        outcome: "ok",
        findings: [
          {
            id: "dev.brandklipparen.capability:selfdestruct",
            title: "Contract can self-destruct",
            payload: { capability: "selfdestruct" },
            evidence: [{ selector: "0xff000000", offset: 26 }],
          },
          { id: "bad", title: "No evidence", evidence: [] },
        ],
      },
      { pluginId: "dev.brandklipparen.unknown" },
    ]);
    expect(views).toHaveLength(2);
    expect(views[0]?.findings).toHaveLength(1);
    expect(views[0]?.findings[0]?.payload).toEqual({ capability: "selfdestruct" });
    expect(views[1]?.findings).toEqual([]);
  });

  test("decompiler findings keep ranges, annotations and unresolved counts for the Expert view", () => {
    const views = toPluginResultViews([
      {
        pluginId: "dev.brandklipparen.decompiler",
        pluginVersion: "1.0.0",
        outcome: "ok",
        findings: [
          {
            id: "dev.brandklipparen.decompiler:0xa9059cbb",
            title: "Decompiled function transfer (0xa9059cbb)",
            payload: {
              selector: "0xa9059cbb",
              name: "transfer",
              entryPc: 45,
              startPc: 45,
              endPc: 120,
              annotations: ["token-pattern: guarded-state-update"],
              cause: "no-plain-return",
              unresolvedJumps: 0,
            },
            evidence: [{ selector: "0xa9059cbb", offset: 45 }],
          },
        ],
      },
    ]);
    expect(views).toHaveLength(1);
    expect(views[0]?.findings).toHaveLength(1);
    const payload = views[0]?.findings[0]?.payload as Record<string, unknown>;
    expect(payload["entryPc"]).toBe(45);
    expect(payload["annotations"]).toEqual(["token-pattern: guarded-state-update"]);
    expect(payload["unresolvedJumps"]).toBe(0);
    expect(views[0]?.findings[0]?.evidence).toEqual([{ selector: "0xa9059cbb", offset: 45 }]);
  });

  test("hostile payloads stay data and hostile evidence is contained", () => {
    const views = toPluginResultViews([
      {
        pluginId: "dev.brandklipparen.evil",
        outcome: "ok",
        findings: [
          {
            id: "dev.brandklipparen.evil:x",
            title: "<script>alert(1)</script>",
            payload: { html: "<img src=x onerror=alert(2)>" },
            evidence: [{ selector: "0x12345678", offset: -1 }],
          },
        ],
      },
    ]);
    expect(views[0]?.findings[0]?.title).toBe("<script>alert(1)</script>");
    expect(views[0]?.findings[0]?.payload).toEqual({ html: "<img src=x onerror=alert(2)>" });
    expect(views[0]?.findings[0]?.evidence).toEqual([{ selector: "0x12345678", offset: null }]);
  });
});
