// Unit test for the decompiler function list (UI v2 §5.4 W-6):
// the 12-row cap with "Show all", spec ordering, partly-read status
// without the raw cause in Simple mode, Expert raw, and the route
// selector auto-expand. Behavior only: rendered text, roles and order.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { DecompilerList } from "./DecompilerList.tsx";
import { syntheticAddress } from "../../lib/syntheticAddresses.ts";
import type { PluginFindingView } from "../PluginsPanel.tsx";

const ADDRESS = syntheticAddress(3);

function hexOf(index: number): string {
  return `0x${index.toString(16).padStart(8, "0")}`;
}

function finding(selector: string, payload: Record<string, unknown>): PluginFindingView {
  return {
    id: `dev.brandklipparen.decompiler:${selector}`,
    title: `Decompiled function (${selector})`,
    payload,
    evidence: [{ selector, offset: 411 }],
  };
}

function payload(selector: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    selector,
    name: `fn${selector.slice(2)}`,
    signature: `fn${selector.slice(2)}()`,
    entryPc: 411,
    startPc: 411,
    endPc: 3057,
    annotations: [],
    cause: null,
    unresolvedJumps: 0,
    ...overrides,
  };
}

// 32 synthetic payloads: named and unnamed rows, all with invented
// selectors and no real-world names. With `guarded` (the default) the
// first row carries the guarded-state-update annotation, so the list
// opens on the Owner-only segment; without it every row is plain and
// the list opens on All.
function thirtyTwo(guarded = true): PluginFindingView[] {
  const out: PluginFindingView[] = [
    finding(
      "0x0ecb93c0",
      payload("0x0ecb93c0", {
        name: "toggleGate",
        signature: "toggleGate(address)",
        annotations: guarded ? ["token-pattern: guarded-state-update"] : [],
        cause: "unexpected-control-flow",
        unresolvedJumps: 55,
      }),
    ),
  ];
  for (let index = 1; index < 16; index += 1) {
    const selector = hexOf(index);
    out.push(
      finding(
        selector,
        payload(selector, {
          cause: index % 3 === 0 ? "unexpected-control-flow" : null,
          unresolvedJumps: index % 3 === 0 ? 4 : 0,
        }),
      ),
    );
  }
  for (let index = 16; index < 32; index += 1) {
    const selector = hexOf(index);
    out.push(
      finding(
        selector,
        payload(selector, { name: `function_${selector.slice(2)}`, signature: "", cause: null }),
      ),
    );
  }
  return out;
}

// Server rendering splits text nodes with comment markers; strip them so
// assertions read the text a visitor gets.
function textOf(html: string): string {
  return html.replace(/<!--.*?-->/g, "");
}

function listHtml(findings: PluginFindingView[], expert = false, initialSelector?: string): string {
  return renderToString(
    <DecompilerList
      address={ADDRESS}
      apiKey=""
      findings={findings}
      expert={expert}
      initialSelector={initialSelector}
    />,
  );
}

describe("decompiler list", () => {
  test("32 payloads render 12 rows plus Show all 32 functions", () => {
    const html = listHtml(thirtyTwo(false));
    expect(html.match(/data-testid="decompiler-row-/g) ?? []).toHaveLength(12);
    expect(textOf(html)).toContain("Show all 32 functions");
  });

  test("a guarded row opens the list on the Owner-only segment", () => {
    const html = listHtml(thirtyTwo());
    expect(textOf(html)).toContain("1 of 32");
    expect(html).toContain("decompiler-row-0x0ecb93c0");
    expect(html).not.toContain("decompiler-row-0x00000001");
    expect(html).toContain("Owner-only");
  });

  test("unexpected-control-flow maps to partly read with no raw cause in Simple mode", () => {
    const html = listHtml(thirtyTwo());
    expect(html).toContain("partly read");
    expect(html).toContain("Owner-only");
    expect(html).not.toContain("unexpected-control-flow");
  });

  test("Expert raw lists the raw fields including the cause", () => {
    const html = listHtml(thirtyTwo(), true, "0x0ecb93c0");
    expect(html).toContain("unexpected-control-flow");
    expect(html).toContain("Unresolved</dt>");
  });

  test("the route selector starts expanded", () => {
    const html = listHtml(thirtyTwo(), false, "0x0ecb93c0");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('role="region"');
    expect(textOf(html)).toContain("Starts at 0x19b");
  });

  test("filter and segmented control render with a live count", () => {
    const html = listHtml(thirtyTwo(false));
    expect(html).toContain("Filter</label>");
    expect(html).toContain('placeholder="Name or selector"');
    expect(html).toContain('aria-pressed="true"');
    expect(textOf(html)).toContain("32 of 32");
    for (const label of ["All", "Owner-only", "Named"]) {
      expect(html).toContain(label);
    }
  });

  test("unnamed functions render with their selector", () => {
    const selector = hexOf(20);
    const html = listHtml([
      finding(
        "0x0ecb93c0",
        payload("0x0ecb93c0", { name: "toggleGate", signature: "toggleGate(address)" }),
      ),
      finding(selector, payload(selector, { name: `function_${selector.slice(2)}`, signature: "" })),
    ]);
    expect(html.match(/data-testid="decompiler-row-/g) ?? []).toHaveLength(2);
    expect(textOf(html)).toContain(selector);
    expect(textOf(html)).not.toContain(`Unnamed ${selector}`);
  });

  test("c22_deep_link_row_15_rendered_expanded", () => {
    // Row 15 sits past the 12-row cap; a deep link to it renders the
    // full list with that row expanded on the first pass.
    const selector = hexOf(15);
    const html = listHtml(thirtyTwo(false), false, selector);
    expect(html).toContain(`data-testid="decompiler-row-${selector}"`);
    expect(html).toContain('aria-expanded="true"');
    expect(textOf(html)).not.toContain("Show all");
  });

  test("r3_the_status_meaning_is_visible_above_the_list", () => {
    const html = listHtml(thirtyTwo(false));
    expect(textOf(html)).toContain("partly read");
    expect(textOf(html)).toContain("fully read");
    expect(html).toContain("decompiler-legend");
  });

  test("r3_no_plain_return_renders_partly_read_without_a_raw_cause", () => {
    const selector = hexOf(7);
    const html = listHtml([
      finding(
        selector,
        payload(selector, { name: "move", signature: "move(address)", cause: "no-plain-return" }),
      ),
    ]);
    expect(html).toContain("partly read");
    expect(html).not.toContain("no-plain-return");
    expect(html).toContain("is-partly");
    expect(html).not.toContain("is-error");
  });

  test("r3_ownership_evidence_tags_owner_only_without_the_annotation", () => {
    const selector = hexOf(9);
    const html = renderToString(
      <DecompilerList
        address={ADDRESS}
        apiKey=""
        findings={[finding(selector, payload(selector, { annotations: [] }))]}
        expert={false}
        ownerOnlySelectors={new Set([selector])}
      />,
    );
    expect(html).toContain("Owner-only");
    expect(textOf(html)).toContain("1 of 1");
  });
});
