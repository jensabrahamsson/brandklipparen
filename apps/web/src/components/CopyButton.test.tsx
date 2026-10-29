// Shared copy button (S-134): a real button with an accessible copy
// name and exactly one polite live region per copy. Clipboard writes
// are exercised in Playwright (real browser); these unit checks cover
// the static contract through server rendering.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { CopyButton } from "./CopyButton.tsx";

const ADDRESS = "0x5ab1e0000000000000000000000000000000a001";

describe("copy button", () => {
  test("renders a real button with the accessible copy name", () => {
    const html = renderToString(<CopyButton value={ADDRESS} label="Copy contract address" />);
    expect(html).toContain("<button");
    expect(html).toContain('aria-label="Copy contract address"');
    expect(html).toContain(">Copy</button>");
  });

  test("announces through exactly one polite live region", () => {
    const html = renderToString(<CopyButton value={ADDRESS} label="Copy contract address" />);
    expect(html).toContain('aria-live="polite"');
    expect(html.match(/aria-live="polite"/g)).toHaveLength(1);
  });

  test("never nests a button inside another button", () => {
    const html = renderToString(
      <span>
        <CopyButton value={ADDRESS} label="Copy contract address" />
      </span>,
    );
    expect(html.match(/<button/g)).toHaveLength(1);
  });
});
