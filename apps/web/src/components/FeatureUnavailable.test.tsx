// Shared unavailable state (S-123): a neutral grey pill with an outline
// icon, one plain sentence, and a visibly disabled primary button whose
// reason is announced through aria-describedby.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { FeatureUnavailable } from "./FeatureUnavailable.tsx";

describe("feature unavailable", () => {
  test("s123_unavailable_pill_reason_and_disabled_button", () => {
    const html = renderToString(
      <FeatureUnavailable title="Muse assessment" reason="Muse assessment is not configured on this server." actionLabel="Request assessment" />,
    );
    expect(html).toContain("Unavailable");
    expect(html).not.toContain("assessment-dot");
    expect(html).toContain("Muse assessment is not configured on this server.");
    expect(html).toContain("disabled");
    expect(html).toContain('aria-disabled="true"');
    const describedBy = html.match(/aria-describedby="([^"]+)"/)?.[1] ?? "";
    expect(describedBy.length).toBeGreaterThan(0);
    expect(html).toContain(`id="${describedBy}"`);
  });
});
