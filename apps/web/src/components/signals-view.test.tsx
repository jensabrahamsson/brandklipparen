import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { ExplanationList } from "./ExplanationList.tsx";
import { SignalList } from "./SignalList.tsx";
import type { Signal } from "../types.ts";

const SIGNALS: readonly Signal[] = [
  {
    kind: "capability",
    id: "owner-blacklist",
    risk: "honeypot",
    direction: "raises",
    severity: "high",
    evidence: [{ selector: "0x44337ea1", offset: 2623 }],
  },
];

function openAll(): { open: Set<string>; onToggle: (id: string) => void; templateLine: (id: string) => string | undefined } {
  return {
    open: new Set(["owner-blacklist"]),
    onToggle: () => undefined,
    templateLine: (id: string) => (id === "owner-blacklist" ? "The owner can stop you from selling." : undefined),
  };
}

describe("template explanation (design review P0-4)", () => {
  test("design_review_renders_all_claims_with_version_label", () => {
    const html = renderToString(
      <ExplanationList
        claims={[
          { text: "The owner can stop you from selling.", signalLinks: ["owner-blacklist"], temporality: { kind: "can-change" } },
          { text: "Launch mechanics were fair at deployment.", signalLinks: [], temporality: { kind: "applies-now" } },
        ]}
        templateVersion="1.0.0"
        onSignalLink={() => undefined}
      />,
    );
    expect(html).toContain("Template explanation · v1.0.0");
    expect(html).toContain("The owner can stop you from selling.");
    expect(html).toContain("Launch mechanics were fair at deployment.");
    expect(html).toContain("can change");
    expect(html).toContain("applies now");
    expect(html).toContain("owner-blacklist");
  });
});

describe("expanded signal evidence (design review P0-5)", () => {
  test("design_review_snippet_slot_is_honest_while_pending", () => {
    const { open, onToggle, templateLine } = openAll();
    const html = renderToString(
      <SignalList signals={SIGNALS} target="0xabc" codeHash="0xhash" deepening="pending" open={open} onToggle={onToggle} templateLine={templateLine} />,
    );
    expect(html).toContain("Snippet arrives with deepening");
    expect(html).not.toContain("function ");
  });

  test("design_review_snippet_slot_names_contract_gap_when_unavailable", () => {
    const { open, onToggle, templateLine } = openAll();
    const html = renderToString(
      <SignalList signals={SIGNALS} target="0xabc" codeHash="0xhash" deepening="unavailable" open={open} onToggle={onToggle} templateLine={templateLine} />,
    );
    expect(html).toContain("contract gap");
  });

  test("design_review_copy_and_bytecode_slots", () => {
    const { open, onToggle, templateLine } = openAll();
    const html = renderToString(
      <SignalList signals={SIGNALS} target="0xabc" codeHash="0xhash" deepening="pending" open={open} onToggle={onToggle} templateLine={templateLine} />,
    );
    expect(html).toContain("Copy evidence");
    expect(html).toContain("Open in bytecode");
    expect(html).toContain("no bytecode pane");
  });

  test("design_review_per_signal_template_line", () => {
    const { open, onToggle, templateLine } = openAll();
    const html = renderToString(
      <SignalList signals={SIGNALS} target="0xabc" codeHash="0xhash" deepening="pending" open={open} onToggle={onToggle} templateLine={templateLine} />,
    ).replace(/<!-- -->/g, "");
    expect(html).toContain("Template: The owner can stop you from selling.");
  });
});
