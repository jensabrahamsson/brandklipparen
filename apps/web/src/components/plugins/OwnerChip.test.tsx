// Owner chip unit test (UI v2 §5.2): the proven chip names the kind
// beside the full address with a copy control; the unproven chip is an
// honest dashed "Owner not identified", never an invented address.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { OwnerChip } from "./OwnerChip.tsx";
import { syntheticAddress } from "../../lib/syntheticAddresses.ts";

describe("owner chip", () => {
  test("proven single key shows the kind, the full address and a copy control", () => {
    const html = renderToString(<OwnerChip owner={{ address: syntheticAddress(7), kind: "single-key" }} />);
    expect(html).toContain("Single key (EOA)");
    expect(html).toContain("Controlled by");
    expect(html).toContain('aria-label="Copy owner address"');
  });

  test("renounced states that nobody controls the contract now", () => {
    const html = renderToString(<OwnerChip owner={{ address: null, kind: "renounced" }} />);
    expect(html).toContain("Nobody controls this now.");
  });

  test("unproven shows the dashed not-identified chip with no address", () => {
    const html = renderToString(<OwnerChip owner={null} />);
    expect(html).toContain("Owner not identified");
    expect(html).toContain("is-unknown");
    expect(html).not.toContain("0x");
  });
});
