// Owner-powers breakdown card (SCORE-6): the floor card leads the row
// in the floor band colour with the facts and minimum; the renounced
// card stays muted; nothing renders without a floor or renounced
// owner. Behavior based: rendered text, roles and classes only.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { FloorCard } from "./FloorCard.tsx";

const FLOOR = {
  rule: "owner-can-block-holders",
  minimum: 60,
  label: "floor: owner can block holders (blacklist)",
  facts: ["blacklist"],
} as const;

const RENOUNCED = {
  status: "renounced" as const,
  getter: "owner()" as const,
  address: "0x0000000000000000000000000000000000000000",
  block: 24000000,
  reason: "the owner getter returns the zero or dead address",
};

describe("owner powers breakdown card (SCORE-6)", () => {
  test("floor card leads in high with facts and minimum", () => {
    const html = renderToString(<FloorCard scoreFloor={FLOOR} ownerState={undefined} />);
    expect(html).toContain('data-testid="floor-card"');
    expect(html).toContain("Owner powers");
    expect(html).toContain("HIGH");
    expect(html).toContain("Owner can block holders: blacklist");
    expect(html).toContain("Sets score floor: 60.");
    expect(html).toContain("gauge floor-card high");
    expect(html).toContain('aria-label="Owner powers: HIGH.');
  });

  test("elevated floor reads elevated, never red", () => {
    const html = renderToString(
      <FloorCard
        scoreFloor={{ rule: "owner-risky-capability", minimum: 30, label: "floor", facts: ["mint"] }}
        ownerState={undefined}
      />,
    );
    expect(html).toContain("gauge floor-card elevated");
    expect(html).toContain("ELEVATED");
    expect(html).toContain("Owner has risky capability: mint");
    expect(html).not.toContain("high");
  });

  test("renounced card stays muted, never red", () => {
    const html = renderToString(<FloorCard scoreFloor={undefined} ownerState={RENOUNCED} />);
    expect(html).toContain('data-testid="floor-card"');
    expect(html).toContain("Owner renounced");
    expect(html).toContain("floor-muted");
    expect(html).not.toContain("gauge floor-card high");
    expect(html).not.toContain("gauge floor-card elevated");
  });

  test("renders nothing without a floor or renounced owner", () => {
    expect(renderToString(<FloorCard scoreFloor={undefined} ownerState={undefined} />)).toBe("");
  });
});
