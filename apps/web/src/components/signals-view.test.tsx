import { describe, expect, test, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { ExplanationList } from "./ExplanationList.tsx";
import { SignalRows } from "./SignalList.tsx";
import type { Signal } from "../types.ts";
import { toChecksumAddress } from "../lib/checksumAddress.ts";

vi.mock("./CopyButton.tsx", async () => {
  const React = await import("react");
  return {
    CopyButton: ({ value, label }: { readonly value: string; readonly label: string }) =>
      React.createElement("button", { type: "button", "aria-label": label, "data-copy-value": value }, "Copy"),
  };
});

vi.mock("./plugins/EvidenceRow.tsx", async () => {
  const React = await import("react");
  return {
    EvidenceRow: ({ displayName, selector }: { readonly displayName: string; readonly selector: string }) =>
      React.createElement("li", { className: "evidence-row" }, `${displayName} ${selector}`),
  };
});

const ADDRESS = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

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

const NAMES = new Map([
  ["0x44337ea1", { signature: "approve(address,uint256)", name: "approve" }],
]);

describe("merged score card (R2-6, D-5)", () => {
  test("r26_single_card_merges_claim_and_signal_with_severity_rail", () => {
    const html = renderToString(
      <ExplanationList
        claims={[
          {
            text: "The owner can stop you from selling. This raises the honeypot risk (severity medium).",
            signalLinks: ["owner-blacklist"],
            temporality: { kind: "can-change" },
          },
        ]}
        signals={SIGNALS}
        templateVersion="1.0.0"
        expert={false}
        address={ADDRESS}
        codeHash="0xabc"
        apiKey=""
        names={NAMES}
      />,
    );
    expect(html).toContain('aria-label="Why this score"');
    expect(html).toContain("Owner can block transfers");
    expect(html).toContain("The owner can stop you from selling.");
    // The sentence never repeats the severity note: the tag owns it.
    expect(html).not.toContain("(severity");
    // The tag names the risk and the strength; the rail keeps the colour.
    expect(html).toContain("Honeypot · strong");
    expect(html).toContain("why-row sev-high");
    // No prototype strings and no raw backticks anywhere on the card.
    expect(html).not.toContain("Template");
    expect(html).not.toContain("deepening");
    expect(html).not.toContain("Open in bytecode");
    expect(html).not.toContain("`");
    // Evidence copy is Expert-only, so Simple mode shows no copy control.
    expect(html).not.toContain("Copy evidence");
  });

  test("r26_inline_code_renders_without_backticks", () => {
    const html = renderToString(
      <SignalRows
        signals={SIGNALS}
        claims={[
          {
            text: "Transfers call `approve(address,uint256)` first. This raises the honeypot risk (severity high).",
            signalLinks: [],
            temporality: { kind: "applies-now" },
          },
        ]}
        expert={false}
        address={ADDRESS}
        codeHash="0xabc"
        apiKey=""
        names={NAMES}
      />,
    );
    expect(html).not.toContain("`");
    expect(html).toContain('<code class="inline-code">approve(address,uint256)</code>');
  });

  test("r26_evidence_disclosure_names_functions_with_places", () => {
    const html = renderToString(
      <SignalRows
        signals={SIGNALS}
        claims={[
          {
            text: "The owner can stop you from selling. This raises the honeypot risk (severity high).",
            signalLinks: [],
            temporality: { kind: "applies-now" },
          },
        ]}
        expert={false}
        address={ADDRESS}
        codeHash="0xabc"
        apiKey=""
        names={NAMES}
      />,
    );
    expect(html).toMatch(/Evidence ·.*?1.*?place/s);
    expect(html).toContain("approve(address,uint256)");
    // One Explain trigger on the card, none on the rows.
    const card = renderToString(
      <ExplanationList
        claims={[
          {
            text: "The owner can stop you from selling.",
            signalLinks: [],
            temporality: { kind: "applies-now" },
          },
        ]}
        signals={SIGNALS}
        templateVersion="1.0.0"
        expert={false}
        address={ADDRESS}
        codeHash="0xabc"
        apiKey=""
        names={NAMES}
      />,
    );
    expect(card.match(/explain-trigger/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  test("r26_empty_state_is_one_line_without_repeating_extended", () => {
    const html = renderToString(
      <ExplanationList
        claims={[]}
        signals={[]}
        templateVersion="1.0.0"
        expert={false}
        address={ADDRESS}
        codeHash="0xabc"
        apiKey=""
        names={NAMES}
      />,
    );
    expect(html).toContain('aria-label="Why this score"');
    expect(html).toContain("Nothing raised the score.");
    expect(html).not.toContain("Extended analysis");
    expect(html).not.toContain("extended analysis");
    expect(html).not.toContain("plugins/blacklist");
    expect(html).not.toContain("Template");
    expect(html).not.toContain("No signals");
  });

  test("score1_floor_label_shows_in_why_this_score", () => {
    const html = renderToString(
      <ExplanationList
        claims={[
          {
            text: "The owner can stop you from selling.",
            signalLinks: ["owner-blacklist"],
            temporality: { kind: "can-change" },
          },
        ]}
        signals={SIGNALS}
        templateVersion="1.1.0"
        expert={false}
        address={ADDRESS}
        codeHash="0xabc"
        apiKey=""
        names={NAMES}
        scoreFloorLabel="floor: owner can block holders (blacklist, pause)"
      />,
    );
    expect(html).toContain('aria-label="Why this score"');
    expect(html).toContain("floor: owner can block holders (blacklist, pause)");
    const plain = renderToString(
      <ExplanationList
        claims={[]}
        signals={[]}
        templateVersion="1.1.0"
        expert={false}
        address={ADDRESS}
        codeHash="0xabc"
        apiKey=""
        names={NAMES}
        scoreFloorLabel="floor: owner can block holders (pause)"
      />,
    );
    expect(plain).toContain("floor: owner can block holders (pause)");
  });

  test("r26_signal_without_claim_falls_back_to_plain_reason", () => {
    const html = renderToString(
      <SignalRows
        signals={SIGNALS}
        claims={[]}
        expert={false}
        address={ADDRESS}
        codeHash="0xabc"
        apiKey=""
        names={NAMES}
      />,
    );
    expect(html).toContain("The owner can stop you from selling.");
    expect(html).toContain("why-row sev-high");
  });
});

describe("merged card keeps readable claims (S-120, S-131, P-1)", () => {
  test("design_review_renders_all_claims_with_scored_label", () => {
    const html = renderToString(
      <ExplanationList
        claims={[
          { text: "The owner can stop you from selling.", signalLinks: ["owner-blacklist"], temporality: { kind: "can-change" } },
          { text: "Launch mechanics were fair at deployment.", signalLinks: [], temporality: { kind: "applies-now" } },
        ]}
        signals={SIGNALS}
        templateVersion="1.0.0"
        expert
        address={ADDRESS}
        codeHash="0xabc"
        apiKey=""
        names={NAMES}
      />,
    );
    expect(html).toContain("Scored patterns · v1.0.0");
    expect(html).toContain("The owner can stop you from selling.");
    expect(html).toContain("Launch mechanics were fair at deployment.");
    expect(html).toContain("Owner can change it");
    expect(html).not.toContain("Owner can turn this on later");
    expect(html).toContain("Active");
    // The signal id may travel in the Expert copy payload attribute, but
    // it never renders as visible copy.
    expect(html).not.toContain(">owner-blacklist<");
    expect(html).toContain("Owner can block transfers");
  });

  test("s131_simple_mode_card_hides_template_version", () => {
    const html = renderToString(
      <ExplanationList
        claims={[
          { text: "The owner can stop you from selling.", signalLinks: ["owner-blacklist"], temporality: { kind: "can-change" } },
        ]}
        signals={SIGNALS}
        templateVersion="1.0.0"
        expert={false}
        address={ADDRESS}
        codeHash="0xabc"
        apiKey=""
        names={NAMES}
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
        address={ADDRESS}
        codeHash="0xabc"
        apiKey=""
        names={NAMES}
      />,
    );
    expect(html).toContain("Owner not read");
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
        address={ADDRESS}
        codeHash="0xabc"
        apiKey=""
        names={NAMES}
      />,
    );
    expect(html).toContain("claim-account-full");
    expect(html).toContain("addr-chunk");
    expect(html.replace(/<[^>]+>/g, "")).toContain(checksummed.replace("0x", "0x"));
    expect(html).not.toContain(`>${account}<`);
    expect(html).toContain('aria-label="Copy account address"');
    expect(html).toContain(`data-copy-value="${checksummed}"`);
    expect(html).toContain("can change it");
    expect(html).not.toContain("Owner can turn this on later");
  });
});

describe("why this score rows (R3 D-11)", () => {
  const HEX_SIGNAL: Signal = {
    kind: "capability",
    id: `0x${"cd".repeat(32)}`,
    risk: "bot-pump",
    direction: "raises",
    severity: "low",
    evidence: [{ selector: "0xabcdef01", offset: 7 }],
  };

  test("r3_d11_plain_titles_tags_chevron_and_no_simple_copy", () => {
    const html = renderToString(
      <SignalRows
        signals={SIGNALS}
        claims={[
          {
            text: "The owner can stop you from selling. This raises the honeypot risk (severity medium).",
            signalLinks: ["owner-blacklist"],
            temporality: { kind: "can-change" },
          },
        ]}
        expert={false}
        address={ADDRESS}
        codeHash="0xabc"
        apiKey=""
        names={NAMES}
      />,
    );
    // No title carries a "pattern (" suffix and no sentence repeats a
    // severity note.
    expect(html).not.toMatch(/pattern \(/);
    expect(html).not.toContain("(severity");
    // The tag names the risk and the strength, outlined below High band.
    expect(html).toContain("Honeypot · strong");
    expect(html).toContain("sev high ghost");
    // The evidence disclosure shows a chevron glyph.
    expect(html).toContain("<svg");
    // Simple mode has no evidence copy.
    expect(html).not.toContain("Copy evidence");
  });

  test("r3_d11_body_omitted_when_it_repeats_the_title", () => {
    const html = renderToString(
      <SignalRows
        signals={[HEX_SIGNAL]}
        claims={[]}
        expert={false}
        address={ADDRESS}
        codeHash="0xabc"
        apiKey=""
        names={NAMES}
      />,
    );
    expect(html).toContain("Bot-pump risk");
    expect(html).not.toContain("claim-text");
  });

  test("score6_floor_leads_why_this_score_before_the_pattern_line", () => {
    const html = renderToString(
      <ExplanationList
        claims={[]}
        signals={[]}
        templateVersion="1.1.0"
        expert={false}
        address={ADDRESS}
        codeHash="0xabc"
        apiKey=""
        names={NAMES}
        scoreFloor={{
          rule: "owner-can-block-holders",
          minimum: 60,
          label: "floor: owner can block holders (blacklist)",
          facts: ["blacklist"],
        }}
      />,
    );
    expect(html).toContain('aria-label="Why this score"');
    const lead = "Owner can block holders (blacklist). Sets score floor: 60.";
    expect(html).toContain(lead);
    expect(html).toContain("Nothing raised the score.");
    // The floor leads: the pattern-model line follows it.
    expect(html.indexOf(lead)).toBeLessThan(html.indexOf("Nothing raised the score."));
  });

  test("score6_floor_leads_above_scored_patterns", () => {
    const html = renderToString(
      <ExplanationList
        claims={[
          {
            text: "The owner can stop you from selling.",
            signalLinks: ["owner-blacklist"],
            temporality: { kind: "can-change" },
          },
        ]}
        signals={SIGNALS}
        templateVersion="1.1.0"
        expert={false}
        address={ADDRESS}
        codeHash="0xabc"
        apiKey=""
        names={NAMES}
        scoreFloor={{
          rule: "owner-can-block-holders",
          minimum: 60,
          label: "floor: owner can block holders (blacklist)",
          facts: ["blacklist"],
        }}
      />,
    );
    const lead = "Owner can block holders (blacklist). Sets score floor: 60.";
    expect(html).toContain(lead);
    expect(html.indexOf(lead)).toBeLessThan(html.indexOf("1 scored pattern"));
  });

  test("score6_renounced_names_getter_address_and_block", () => {
    const html = renderToString(
      <ExplanationList
        claims={[]}
        signals={[]}
        templateVersion="1.1.0"
        expert={false}
        address={ADDRESS}
        codeHash="0xabc"
        apiKey=""
        names={NAMES}
        ownerState={{
          status: "renounced",
          getter: "owner()",
          address: "0x0000000000000000000000000000000000000000",
          block: 24000000,
          reason: "the owner getter returns the zero or dead address",
        }}
      />,
    );
    expect(html).toContain("Owner powers may exist in code, but the owner is renounced");
    expect(html).toContain("owner()");
    expect(html).toContain("0x0000000000000000000000000000000000000000");
    expect(html).toContain("24000000");
    expect(html).toContain('aria-label="Copy owner address"');
  });

  test("r3_d11_high_band_keeps_filled_tags_and_expert_copies", () => {
    const html = renderToString(
      <SignalRows
        signals={SIGNALS}
        claims={[]}
        expert
        bandHigh
        address={ADDRESS}
        codeHash="0xabc"
        apiKey=""
        names={NAMES}
      />,
    );
    expect(html).not.toContain("ghost");
    expect(html).toContain('aria-label="Copy evidence JSON"');
  });
});
