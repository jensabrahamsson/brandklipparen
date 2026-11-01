// Scan status behavior (UI v2 §5.6 M-8): the pending line keeps its
// text in the accessibility tree and only decorates with a cursor and
// lamps while motion is allowed; under reduced motion it is static
// text. Behavior only: rendered text, no implementation detail.
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { ScanStatus } from "./ScanStatus.tsx";

function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({ matches: matches && query.includes("reduce"), media: query }),
  });
}

describe("scan status", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("shows the waiting text with cursor and lamps while motion is allowed", () => {
    stubMatchMedia(false);
    const html = renderToString(createElement(ScanStatus, { text: "Scanning…" }));
    expect(html).toContain("Scanning…");
    expect(html).toContain('role="status"');
    expect(html).toContain("scan-lamps");
  });

  test("renders static text only under reduced motion", () => {
    stubMatchMedia(true);
    const html = renderToString(createElement(ScanStatus, { text: "Loading…" }));
    expect(html).toContain("Loading…");
    expect(html).not.toContain("scan-lamps");
    expect(html).not.toContain("cursor");
  });
});
