import { describe, expect, test, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { ExplanationList } from "./ExplanationList.tsx";
import { SignalRows } from "./SignalList.tsx";
import type { Signal } from "../types.ts";
import { toChecksumAddress } from "../lib/checksumAddress.ts";
import type { BoardTile } from "./plugins/PluginBoard.tsx";

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

function extendedTile(slug: string, title: string): BoardTile {
  return {
    pluginId: `dev.brandklipparen.${slug}`,
    slug,
    copy: {
      slug,
      title,
      question: `Can the owner ${slug}?`,
      pictogram: "owner",
      group: "owner",
      foundLine: () => title,
      limits: "Test limit.",
    },
    state: "extended",
    severity: "medium",
    payloads: [],
    evidenceCount: 0,
    orderIndex: 0,
  };
}

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
        extendedTiles={[]}
        allIds={[]}
      />,
    );
    expect(html).toContain('aria-label="Why this score"');
    expect(html).toContain("Owner can block transfers");
    expect(html).toContain("The owner can stop you from selling.");
    // The claim severity follows the signal: one field, one word.
    expect(html).toContain("(severity high)");
    expect(html).not.toContain("(severity medium)");
    // Rail colour comes from the same severity field.
    expect(html).toContain("why-row sev-high");
    // No prototype strings and no raw backticks anywhere on the card.
    expect(html).not.toContain("Template");
    expect(html).not.toContain("deepening");
    expect(html).not.toContain("Open in bytecode");
    expect(html).not.toContain("`");
    // Copy evidence stays; the bytecode shortcut is gone.
    expect(html).toContain("Copy evidence");
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
        extendedTiles={[]}
        allIds={[]}
      />,
    );
    expect(card.match(/explain-trigger/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  test("r26_empty_state_names_extended_findings_with_links", () => {
    const tiles = [extendedTile("blacklist", "Blacklist"), extendedTile("transfer-limits", "Transfer limits")];
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
        extendedTiles={tiles}
        allIds={["dev.brandklipparen.blacklist", "dev.brandklipparen.transfer-limits"]}
      />,
    );
    expect(html).toContain('aria-label="Why this score"');
    expect(html).toMatch(/Extended analysis found.*?2.*?more \(not in score\):/s);
    expect(html).toContain("Blacklist");
    expect(html).toContain("Transfer limits");
    expect(html).toContain("plugins/blacklist");
    expect(html).toContain("plugins/transfer-limits");
    expect(html).not.toContain("Template");
    expect(html).not.toContain("No signals");
  });

  test("r26_empty_state_without_extended_stays_honest", () => {
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
        extendedTiles={[]}
        allIds={[]}
      />,
    );
    expect(html).toContain("No scored pattern found in the code we could read.");
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
        extendedTiles={[]}
        allIds={[]}
      />,
    );
    expect(html).toContain("Scored patterns · v1.0.0");
    expect(html).toContain("The owner can stop you from selling.");
    expect(html).toContain("Launch mechanics were fair at deployment.");
    expect(html).toContain("Owner can change this");
    expect(html).not.toContain("Owner can turn this on later");
    expect(html).toContain("Applies now");
    expect(html).not.toContain("owner-blacklist");
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
        extendedTiles={[]}
        allIds={[]}
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
        extendedTiles={[]}
        allIds={[]}
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
        address={ADDRESS}
        codeHash="0xabc"
        apiKey=""
        names={NAMES}
        extendedTiles={[]}
        allIds={[]}
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
