// Explain fallback unit tests (round-3 review D-5): when every model
// sentence fails the evidence check the panel renders the user-facing
// fallback built from the deterministic template claims with a quiet
// retry, never the developer message. With no claims at all the verdict
// sentence stands, never a colon followed by nothing. Behavior based:
// rendered text, roles and accessible names only.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { ExplainFallback, ExplainSentences } from "./ExplainPanel.tsx";
import type { Signal } from "../types.ts";

const VERDICT = "Low risk. No owner power found in the code we could read. That is not the same as safe.";

const CLAIMS = [
  { text: "No owner powers were found in the bytecode.", signalLinks: [], temporality: { kind: "can-change-unknown" } },
  { text: "Liquidity locks cannot be told from bytecode.", signalLinks: [], temporality: { kind: "can-change-unknown" } },
] as const;

describe("explain fallback", () => {
  test("all_dropped_renders_template_claims_with_retry", () => {
    const html = renderToString(
      <ExplainFallback verdict={VERDICT} claims={[...CLAIMS]} onRetry={() => undefined} />,
    );
    expect(html).toContain("Muse&#x27;s answer cited no evidence. Here&#x27;s the analysis instead:");
    expect(html).toContain("No owner powers were found in the bytecode.");
    expect(html).toContain("Liquidity locks cannot be told from bytecode.");
    expect(html.indexOf("No owner powers were found")).toBeLessThan(
      html.indexOf("Liquidity locks cannot be told"),
    );
    expect(html).toContain('type="button"');
    expect(html).toContain("Try again");
    expect(html).not.toContain("Every model sentence failed the evidence check.");
  });

  test("all_dropped_without_claims_renders_the_verdict_with_retry", () => {
    const html = renderToString(
      <ExplainFallback verdict={VERDICT} claims={[]} onRetry={() => undefined} />,
    );
    expect(html).toContain(VERDICT);
    expect(html).toContain("Try again");
    expect(html).not.toContain("<li>");
    expect(html).not.toContain("<ul");
  });

  test("ask1_realistic_chat_answer_renders_evidence_chips", () => {
    const signals: readonly Signal[] = [
      {
        kind: "capability",
        id: "owner-blacklist",
        risk: "honeypot",
        direction: "raises",
        severity: "high",
        evidence: [{ selector: "0x44337ea1", offset: 2623 }],
      },
      {
        kind: "capability",
        id: "pausable",
        risk: "honeypot",
        direction: "raises",
        severity: "high",
        evidence: [{ selector: "0x8456cb59", offset: 120 }],
      },
    ];
    // The checked answer text the chat service returns for the question
    // "Can the owner stop me selling?": plain model text plus one
    // [E:<id>] marker per validated citation.
    const html = renderToString(
      <ExplainSentences
        narrative={[
          "Yes. The owner can stop you selling by blocking your wallet or pausing transfers. [E:signal:owner-blacklist] [E:signal:pausable]",
        ]}
        droppedClaims={0}
        signals={signals}
        address="0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
        allIds={["signal:owner-blacklist", "signal:pausable"]}
        onSignalLink={() => undefined}
      />,
    );
    expect(html).toContain("Yes. The owner can stop you selling");
    expect(html).toContain('data-evidence="signal:owner-blacklist"');
    expect(html).toContain('data-evidence="signal:pausable"');
    expect(html).toContain("Blacklist");
    expect(html).toContain("Pause");
    expect(html).toContain("Evidence: Blacklist. Open the Why this score row.");
    expect(html).not.toContain("[E:signal:");
  });

  test("dropped_line_sits_inside_a_details_disclosure", () => {
    const html = renderToString(
      <ExplainSentences
        narrative={["The owner can pause transfers."]}
        droppedClaims={1}
        signals={[]}
        address="0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
        allIds={[]}
        onSignalLink={() => undefined}
      />,
    );
    expect(html).toContain("<details");
    expect(html).toContain("<summary>Details</summary>");
    expect(html).toContain("1 sentence removed: it cited no evidence.");
    expect(html.indexOf("<details")).toBeLessThan(html.indexOf("1 sentence removed"));
  });

  test("all_dropped_without_claims_names_the_honest_limit_beside_a_bare_verdict", () => {
    const html = renderToString(
      <ExplainFallback verdict="Low risk. The owner controls pause." claims={[]} onRetry={() => undefined} />,
    );
    expect(html).toContain("Low risk. The owner controls pause.");
    expect(html).toContain("No owner power found in the code we could read. That is not the same as safe.");
  });
});
