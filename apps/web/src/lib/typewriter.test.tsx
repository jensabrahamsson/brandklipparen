// Typewriter unit test (UI v2 §5.6 M-4): under reduced motion the full
// text renders at once with no cursor, and the full text always stays
// in the accessibility tree. Behavior only: rendered text, no
// implementation detail.
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderToString } from "react-dom/server";
import type { JSX } from "react";
import { useTypewriter } from "./typewriter.ts";

function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({ matches: matches && query.includes("reduce"), media: query }),
  });
}

function Sentence({ text }: { readonly text: string }): JSX.Element {
  const typewriter = useTypewriter(text);
  return (
    <span>
      <span aria-hidden="true">
        {typewriter.shown}
        {typewriter.done ? null : "▌"}
      </span>
      <span className="sr-only">{text}</span>
    </span>
  );
}

describe("typewriter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("renders the full text at once under reduced motion with no cursor", () => {
    stubMatchMedia(true);
    const html = renderToString(<Sentence text="The owner can stop transfers." />);
    expect(html).toContain("The owner can stop transfers.");
    expect(html).not.toContain("▌");
  });

  test("keeps the full text in the accessibility tree while typing", () => {
    stubMatchMedia(false);
    const html = renderToString(<Sentence text="The owner can stop transfers." />);
    expect(html).toContain('<span class="sr-only">The owner can stop transfers.</span>');
    expect(html).toContain("▌");
  });
});
