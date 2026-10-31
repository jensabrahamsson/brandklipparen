// Copy icon-button (UI v2 §4): a real button with a stable accessible
// copy name, a data-state attribute for the idle/copied/failed glyph,
// exactly one polite live region per copy, and a real 44x44 box on
// every width. Clipboard writes are exercised in Playwright (real
// browser); these unit checks cover the static contract through server
// rendering plus the live-region wording and the stylesheet box.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToString } from "react-dom/server";
import { CopyButton, copyStatusText } from "./CopyButton.tsx";

const ADDRESS = "0x5ab1e0000000000000000000000000000000a001";

const cssDir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(cssDir, "..", "styles.css"), "utf8");
const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("copy button", () => {
  test("renders an icon button with the accessible copy name and idle state", () => {
    const html = renderToString(<CopyButton value={ADDRESS} label="Copy contract address" />);
    expect(html).toContain("<button");
    expect(html).toContain('aria-label="Copy contract address"');
    expect(html).toContain('data-state="idle"');
    // An icon, not a text button: decorative SVG, no "Copy" text node.
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain(">Copy</button>");
  });

  test("announces once per copy with a stable button name", () => {
    expect(copyStatusText("Copy contract address", "idle")).toBe("");
    expect(copyStatusText("Copy contract address", "copied")).toBe("Copied contract address.");
    expect(copyStatusText("Copy pair address", "copied")).toBe("Copied pair address.");
    expect(copyStatusText("Copy contract address", "failed")).toBe("Copy failed.");
  });

  test("announces through exactly one polite live region", () => {
    const html = renderToString(<CopyButton value={ADDRESS} label="Copy contract address" />);
    expect(html).toContain('aria-live="polite"');
    expect(html.match(/aria-live="polite"/g)).toHaveLength(1);
  });

  test("live region is screen-reader-only and empty when idle", () => {
    const html = renderToString(<CopyButton value={ADDRESS} label="Copy contract address" />);
    // Visually hidden so it reserves no layout space next to the button.
    expect(html).toContain('class="copy-status sr-only"');
    expect(html).toContain('aria-live="polite"');
    // Empty when idle: one announcement per copy, nothing reserved.
    expect(html).toMatch(/aria-live="polite"[^>]*><\/span>/);
  });

  test("tooltip stays out of the accessible name and hidden when idle", () => {
    const html = renderToString(<CopyButton value={ADDRESS} label="Copy contract address" />);
    // The bubble renders only on hover, keyboard focus or confirmation,
    // so server markup carries no tooltip text inside the button.
    expect(html).not.toContain('role="tooltip"');
  });

  test("box is 44x44 in all states", () => {
    // No jsdom here: pin the real stylesheet rule the button renders
    // with, so every state shares the same fixed box.
    const rule = code.match(/\.copy-btn\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule, ".copy-btn keeps the 44 px box").toMatch(/width:\s*44px/);
    expect(rule).toMatch(/height:\s*44px/);
    expect(rule).toMatch(/min-width:\s*44px/);
    expect(rule).toMatch(/min-height:\s*44px/);
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
