// Explain fallback unit tests (S-094 fix): when every model sentence
// fails the evidence check the panel renders the user-facing fallback
// built from the deterministic template claims with a quiet retry,
// never the developer message. Behavior based: rendered text, roles
// and accessible names only.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { ExplainFallback } from "./ExplainPanel.tsx";

const CLAIMS = [
  { text: "No owner powers were found in the bytecode.", signalLinks: [], temporality: { kind: "can-change-unknown" } },
  { text: "Liquidity locks cannot be told from bytecode.", signalLinks: [], temporality: { kind: "can-change-unknown" } },
] as const;

describe("explain fallback", () => {
  test("all_dropped_renders_template_claims_with_retry", () => {
    const html = renderToString(
      <ExplainFallback claims={[...CLAIMS]} onRetry={() => undefined} />,
    );
    expect(html).toContain("We could not explain this with Muse. Here is what the analysis found:");
    expect(html).toContain("No owner powers were found in the bytecode.");
    expect(html).toContain("Liquidity locks cannot be told from bytecode.");
    expect(html.indexOf("No owner powers were found")).toBeLessThan(
      html.indexOf("Liquidity locks cannot be told"),
    );
    expect(html).toContain('type="button"');
    expect(html).toContain("Try again");
    expect(html).not.toContain("Every model sentence failed the evidence check.");
  });

  test("all_dropped_without_claims_still_offers_retry", () => {
    const html = renderToString(<ExplainFallback claims={[]} onRetry={() => undefined} />);
    expect(html).toContain("We could not explain this with Muse. Here is what the analysis found:");
    expect(html).toContain("Try again");
    expect(html).not.toContain("<li>");
  });
});
