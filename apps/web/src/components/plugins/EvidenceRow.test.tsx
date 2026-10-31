// Evidence row unit test (UI v2 §5.3): copy writes `selector@offset
// name` with a stable accessible name, and naming falls back to a plain
// "function 0x…" when the decompiler readout has no name.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { EvidenceRow, evidenceCopyText } from "./EvidenceRow.tsx";
import { syntheticAddress } from "../../lib/syntheticAddresses.ts";

const ADDRESS = syntheticAddress(3);

// Server rendering splits text nodes with comment markers; strip them so
// assertions read the text a visitor gets.
function textOf(html: string): string {
  return html.replace(/<!--.*?-->/g, "");
}

describe("evidence row", () => {
  test("copy writes selector at offset plus the display name", () => {
    expect(evidenceCopyText("0x095ea7b3", 0x2140, "approve(address,uint256)")).toBe(
      "0x095ea7b3@0x2140 approve(address,uint256)",
    );
  });

  test("row names the copy control after the evidence it copies", () => {
    const html = renderToString(
      <EvidenceRow
        address={ADDRESS}
        apiKey=""
        selector="0x095ea7b3"
        offset={0x2140}
        displayName="approve(address,uint256)"
        shortName="approve"
        named={true}
        expert={false}
        index={0}
      />,
    );
    expect(html).toContain("approve(address,uint256)");
    expect(html).toContain('aria-label="Copy evidence approve at 0x2140"');
    expect(textOf(html)).toContain("0x095ea7b3 · approve(address,uint256)");
  });

  test("expert adds the raw program-counter line", () => {
    const html = renderToString(
      <EvidenceRow
        address={ADDRESS}
        apiKey=""
        selector="0x095ea7b3"
        offset={0x2140}
        displayName="function 0x095ea7b3"
        shortName="function 0x095ea7b3"
        named={false}
        expert={true}
        index={0}
      />,
    );
    expect(textOf(html)).toContain("PC 0x2140");
  });

  test("simple mode hides the raw program-counter line", () => {
    const html = renderToString(
      <EvidenceRow
        address={ADDRESS}
        apiKey=""
        selector="0x095ea7b3"
        offset={0x2140}
        displayName="approve(address,uint256)"
        shortName="approve"
        named={true}
        expert={false}
        index={0}
      />,
    );
    expect(textOf(html)).not.toContain("PC 0x2140");
  });

  test("rows sharing a function name get one expand label per offset", () => {
    const html = [0xc8, 0x12c]
      .map((offset) =>
        renderToString(
          <EvidenceRow
            address={ADDRESS}
            apiKey=""
            selector="0x44337ea1"
            offset={offset}
            displayName="addBlackList(address)"
            shortName="addBlackList"
            named={true}
            expert={false}
            index={0}
          />,
        ),
      )
      .join("\n");
    expect(html).toContain('aria-label="Readable code for addBlackList(address) at 0xc8"');
    expect(html).toContain('aria-label="Readable code for addBlackList(address) at 0x12c"');
    expect(html).toContain('aria-expanded="false"');
  });
});
