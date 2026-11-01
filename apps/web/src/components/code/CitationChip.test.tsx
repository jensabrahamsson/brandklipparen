// Citation chip unit test (addendum §A2.3, VS-2): line, cross-function
// and evidence targets resolve to buttons; unknown targets render as
// plain text, never buttons. Behavior only: rendered text, roles and
// accessible names, no implementation detail.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { CitationChip, resolveCite, type CiteMaps, type CitePosition } from "./CitationChip.tsx";
import type { ExplainCodeCite } from "../../lib/api.ts";

const TRANSFER = "0xa9059cbb";
const ADD = "0x44337ea1";

const CURRENT: CitePosition = { selector: ADD, view: "decompiled" };
const MAPS: CiteMaps = {
  lines: new Set([1, 2, 3, 4, 5, 6]),
  functions: new Map([[TRANSFER.toLowerCase(), "transfer()"], [ADD.toLowerCase(), "addBlackList(address)"]]),
  evidence: new Map([["blacklist", "Blocked wallets"]]),
};

function noop(): void {}

describe("citation chips", () => {
  test("a line in the current pane resolves to a line button", () => {
    const cite: ExplainCodeCite = { kind: "line", selector: ADD, view: "decompiled", line: 3 };
    expect(resolveCite(cite, CURRENT, MAPS)).toEqual({ kind: "line", label: "L3", line: 3 });
    const html = renderToString(
      <CitationChip cite={cite} current={CURRENT} maps={MAPS} onLine={noop} onFunction={noop} onEvidence={noop} />,
    );
    expect(html).toContain("<button");
    expect(html).toContain(">L3</button>");
  });

  test("a line in another function resolves to a cross-function button", () => {
    const cite: ExplainCodeCite = { kind: "line", selector: TRANSFER, view: "decompiled", line: 2 };
    expect(resolveCite(cite, CURRENT, MAPS)).toEqual({
      kind: "function",
      label: "transfer() L2",
      selector: TRANSFER,
      view: "decompiled",
      line: 2,
    });
    const html = renderToString(
      <CitationChip cite={cite} current={CURRENT} maps={MAPS} onLine={noop} onFunction={noop} onEvidence={noop} />,
    );
    expect(html).toContain("<button");
    expect(html).toContain("transfer() L2");
  });

  test("a known evidence id resolves to an evidence button", () => {
    const cite: ExplainCodeCite = { kind: "evidence", id: "blacklist" };
    expect(resolveCite(cite, CURRENT, MAPS)).toEqual({ kind: "evidence", label: "Blocked wallets", id: "blacklist" });
    const html = renderToString(
      <CitationChip cite={cite} current={CURRENT} maps={MAPS} onLine={noop} onFunction={noop} onEvidence={noop} />,
    );
    expect(html).toContain("<button");
    expect(html).toContain("Blocked wallets");
  });

  test("a range chip names the range and focuses its first line", () => {
    const cite: ExplainCodeCite = { kind: "line", selector: ADD, view: "decompiled", line: 3 };
    const html = renderToString(
      <CitationChip
        cite={cite}
        current={CURRENT}
        maps={MAPS}
        labelOverride="L3–4"
        onLine={noop}
        onFunction={noop}
        onEvidence={noop}
      />,
    );
    expect(html).toContain("<button");
    expect(html).toContain(">L3–4</button>");
  });

  test("unknown targets render as plain text chips, never buttons", () => {
    const missing: ExplainCodeCite = { kind: "line", selector: ADD, view: "decompiled", line: 99 };
    const unknownFn: ExplainCodeCite = { kind: "line", selector: "0xdeadbeef", view: "decompiled", line: 1 };
    const unknownEvidence: ExplainCodeCite = { kind: "evidence", id: "no-such-finding" };
    for (const cite of [missing, unknownFn, unknownEvidence]) {
      expect(resolveCite(cite, CURRENT, MAPS).kind).toBe("unknown");
      const html = renderToString(
        <CitationChip cite={cite} current={CURRENT} maps={MAPS} onLine={noop} onFunction={noop} onEvidence={noop} />,
      );
      expect(html).not.toContain("<button");
      expect(html).toContain("cite-chip is-unknown");
    }
  });

  test("string cites from older servers resolve like objects", () => {
    // The client parser turns "line:3" into the current pane and view;
    // resolution then behaves like the object form.
    const cite: ExplainCodeCite = { kind: "line", selector: ADD, view: "decompiled", line: 4 };
    expect(resolveCite(cite, CURRENT, MAPS).kind).toBe("line");
    const html = renderToString(
      <CitationChip cite={cite} current={CURRENT} maps={MAPS} onLine={noop} onFunction={noop} onEvidence={noop} />,
    );
    expect(html).toContain(">L4</button>");
  });
});
