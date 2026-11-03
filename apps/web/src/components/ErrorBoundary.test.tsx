// App-level error boundary unit test (D-2): the boundary passes
// healthy children through untouched and derives the error card state
// from a render failure. Behavior based: rendered text only.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { ErrorBoundary } from "./ErrorBoundary.tsx";

describe("app error boundary (D-2)", () => {
  test("healthy_children_render_through", () => {
    const html = renderToString(
      <ErrorBoundary>
        <p>Token content</p>
      </ErrorBoundary>,
    );
    expect(html).toContain("Token content");
    expect(html).not.toContain("This view failed.");
  });

  test("render_failure_derives_error_card_state", () => {
    expect(ErrorBoundary.getDerivedStateFromError()).toEqual({ hasError: true });
  });
});
