// CodeLines unit test (addendum §A1.5-§A1.6): token roles render as
// spans, long hex shortens in display only (title, aria-label and the
// copy output hold the full value), hidden characters render as
// chips, and target/evidence/match classes land on the right lines.
// Behavior only: rendered text, roles and accessible names.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { CodeLines, type CodeLineDatum } from "./CodeLines.tsx";
import { codeCopyText } from "./CodeView.tsx";
import { shortHex } from "../../lib/codeTokens.ts";

const FULL_HEX = `0x${"ab".repeat(32)}`;

const LINES: readonly CodeLineDatum[] = [
  { lineNumber: 1, text: "function pause() {", pcs: [] },
  { lineNumber: 2, text: "  require(msg.sender == owner);", pcs: [0x2140] },
  { lineNumber: 3, text: `  emit ${FULL_HEX}();`, pcs: [0x2150] },
];

function noop(): void {}

function html(overrides: Partial<Parameters<typeof CodeLines>[0]> = {}): string {
  return renderToString(
    <CodeLines
      idPrefix="test"
      lines={LINES}
      functionName="pause"
      targetLine={null}
      evidenceLines={new Set()}
      highlightLines={new Set()}
      gutterLampFor={() => null}
      renamedFrom={null}
      expert={false}
      lineRef={noop}
      onLineFocus={noop}
      onLineHover={noop}
      {...overrides}
    />,
  );
}

describe("code lines", () => {
  test("token roles render as spans with line numbers", () => {
    const out = html();
    expect(out).toContain('class="tk-keyword">function</span>');
    expect(out).toContain('class="tk-builtin">msg.sender</span>');
    expect(out).toContain('class="code-no"');
    expect(out).toContain("Code lines for pause");
  });

  test("long hex shortens in display while title and aria-label hold the full value", () => {
    const out = html();
    expect(out).toContain(`>${shortHex(FULL_HEX)}</span>`);
    expect(out).toContain(`title="${FULL_HEX}"`);
    expect(out).toContain(`aria-label="${FULL_HEX}"`);
    expect(codeCopyText(LINES)).toBe(`function pause() {\n  require(msg.sender == owner);\n  emit ${FULL_HEX}();`);
    const expert = html({ expert: true });
    expect(expert).toContain(FULL_HEX);
    expect(expert).not.toContain(`title="${FULL_HEX}"`);
  });

  test("hidden characters render as visible chips", () => {
    const override = String.fromCodePoint(0x202e);
    const out = html({
      lines: [{ lineNumber: 1, text: `onlyOwner${override}`, pcs: [] }],
    });
    expect(out).toContain("⟨U+202E⟩");
  });

  test("fresh but equal sets and callbacks render identical rows", () => {
    const props = () => ({
      targetLine: 2,
      evidenceLines: new Set([2]),
      highlightLines: new Set([3]),
      gutterLampFor: (lineNumber: number) =>
        lineNumber === 2 ? { label: "Evidence at 0x2140: back to the evidence row", onActivate: noop } : null,
    });
    // New Set and closure identities every render (as typing ticks do)
    // must not change the rendered lines.
    expect(html(props())).toBe(html(props()));
  });

  test("target, evidence and match classes land on the right lines", () => {
    const out = html({
      targetLine: 2,
      evidenceLines: new Set([2]),
      highlightLines: new Set([3]),
      gutterLampFor: (lineNumber) =>
        lineNumber === 2 ? { label: "Evidence at 0x2140: back to the evidence row", onActivate: noop } : null,
    });
    expect(out).toContain('id="test-line-2"');
    expect(out).toContain('class="code-line is-evidence is-target"');
    expect(out).toContain('aria-label="Evidence at 0x2140: back to the evidence row"');
    expect(out).toContain('class="code-line is-match"');
  });
});
