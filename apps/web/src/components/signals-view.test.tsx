import { describe, expect, test, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { ExplanationList } from "./ExplanationList.tsx";
import { SignalList } from "./SignalList.tsx";
import type { Signal } from "../types.ts";
import { toChecksumAddress } from "../lib/checksumAddress.ts";

vi.mock("./CopyButton.tsx", async () => {
  const React = await import("react");
  return {
    CopyButton: ({ value, label }: { readonly value: string; readonly label: string }) =>
      React.createElement("button", { type: "button", "aria-label": label, "data-copy-value": value }, "Copy"),
  };
});

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

function openAll(): {
  open: Set<string>;
  onToggle: (key: string) => void;
  templateLine: (index: number) => string | undefined;
} {
  return {
    open: new Set(["0-capability-honeypot"]),
    onToggle: () => undefined,
    templateLine: (index: number) =>
      index === 0 ? "The owner can stop you from selling." : undefined,
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
        signals={SIGNALS}
        templateVersion="1.0.0"
        expert
        onSignalLink={() => undefined}
      />,
    );
    expect(html).toContain("Template explanation · v1.0.0");
    expect(html).toContain("The owner can stop you from selling.");
    expect(html).toContain("Launch mechanics were fair at deployment.");
    expect(html).toContain("Owner can change this");
    expect(html).not.toContain("Owner can turn this on later");
    expect(html).toContain("Applies now");
    expect(html).not.toContain("owner-blacklist");
    expect(html).toContain("Owner can block transfers");
  });

  test("s131_simple_mode_explanation_hides_template_version", () => {
    const html = renderToString(
      <ExplanationList
        claims={[
          { text: "The owner can stop you from selling.", signalLinks: ["owner-blacklist"], temporality: { kind: "can-change" } },
        ]}
        signals={SIGNALS}
        templateVersion="1.0.0"
        expert={false}
        onSignalLink={() => undefined}
      />,
    );
    expect(html).toContain("The owner can stop you from selling.");
    expect(html).not.toContain("v1.0.0");
  });

  test("p1_can_change_unknown_renders_neutral_chip", () => {
    const html = renderToString(
      <ExplanationList
        claims={[
          {
            text: "The owner can create new tokens. This raises the rug-pull risk (severity high).",
            signalLinks: [],
            temporality: { kind: "can-change-unknown" },
          },
        ]}
        signals={[]}
        templateVersion="1.1.0"
        expert={false}
        onSignalLink={() => undefined}
      />,
    );
    expect(html).toContain("Possible in code · no controlling account found");
    expect(html).not.toContain("Owner can turn this on later");
    expect(html).not.toContain("claim-account-full");
  });

  test("s134_account_chip_shows_full_address_with_copy", () => {
    const account = "0x5ab1e0000000000000000000000000000000a001";
    const checksummed = "0x5ab1E0000000000000000000000000000000a001";
    expect(toChecksumAddress(account)).toBe(checksummed);
    const html = renderToString(
      <ExplanationList
        claims={[
          {
            text: `The owner can stop you from selling. Can change: account ${account} can activate this later.`,
            signalLinks: [],
            temporality: { kind: "can-change" },
          },
        ]}
        signals={[]}
        templateVersion="1.0.0"
        expert={false}
        onSignalLink={() => undefined}
      />,
    );
    expect(html).toContain(checksummed);
    expect(html).toContain("claim-account-full");
    expect(html).toContain(`data-testid="claim-account-full">${checksummed}<`);
    expect(html).not.toContain(`>${account}<`);
    expect(html).toContain('aria-label="Copy account address"');
    expect(html).toContain(`data-copy-value="${checksummed}"`);
    expect(html).toContain("can change this");
    expect(html).not.toContain("Owner can turn this on later");
  });
});

describe("expanded signal evidence (design review P0-5)", () => {
  test("design_review_snippet_slot_is_honest_while_pending", () => {
    const { open, onToggle, templateLine } = openAll();
    const html = renderToString(
      <SignalList signals={SIGNALS} target="0xabc" codeHash="0xhash" deepening="pending" expert={false} open={open} onToggle={onToggle} templateLine={templateLine} />,
    );
    expect(html).toContain("Snippet arrives with deepening");
    expect(html).not.toContain("function ");
  });

  test("design_review_snippet_slot_names_contract_gap_when_unavailable", () => {
    const { open, onToggle, templateLine } = openAll();
    const html = renderToString(
      <SignalList signals={SIGNALS} target="0xabc" codeHash="0xhash" deepening="unavailable" expert open={open} onToggle={onToggle} templateLine={templateLine} />,
    );
    expect(html).toContain("contract gap");
  });

  test("s131_simple_mode_snippet_slot_stays_plain", () => {
    const { open, onToggle, templateLine } = openAll();
    const html = renderToString(
      <SignalList signals={SIGNALS} target="0xabc" codeHash="0xhash" deepening="unavailable" expert={false} open={open} onToggle={onToggle} templateLine={templateLine} />,
    );
    expect(html).toContain("No decompiled snippet is available");
    expect(html).not.toContain("contract gap");
    expect(html).not.toContain("REST");
  });

  test("design_review_copy_and_bytecode_slots", () => {
    const { open, onToggle, templateLine } = openAll();
    const html = renderToString(
      <SignalList signals={SIGNALS} target="0xabc" codeHash="0xhash" deepening="pending" expert={false} open={open} onToggle={onToggle} templateLine={templateLine} />,
    );
    expect(html).toContain("Copy evidence");
    expect(html).toContain("Open in bytecode");
    expect(html).toContain("no bytecode pane");
  });

  test("design_review_per_signal_template_line", () => {
    const { open, onToggle, templateLine } = openAll();
    const html = renderToString(
      <SignalList signals={SIGNALS} target="0xabc" codeHash="0xhash" deepening="pending" expert={false} open={open} onToggle={onToggle} templateLine={templateLine} />,
    ).replace(/<!-- -->/g, "");
    expect(html).toContain("Template: The owner can stop you from selling.");
  });
});
