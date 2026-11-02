import { describe, expect, test } from "vitest";
import { floorMarkFor } from "./floorPowers.ts";

const FLOOR = {
  rule: "owner-can-block-holders" as const,
  minimum: 60,
  label: "floor: owner can block holders (blacklist)",
  facts: ["blacklist"],
};
const RENOUNCED = {
  status: "renounced" as const,
  getter: "owner()" as const,
  address: "0x0000000000000000000000000000000000000000",
  block: 24000000,
  reason: "the owner getter returns the zero or dead address",
};

describe("score-floor marks (SCORE-4)", () => {
  test("floor fact marks floor, renounced lifted marks renounced", () => {
    expect(floorMarkFor("blacklist", "extended", { scoreFloor: FLOOR })).toBe("floor");
    expect(floorMarkFor("blacklist", "extended", { ownerState: RENOUNCED })).toBe("renounced");
    // A fact still in the floor (non-owner gate) wins over renounced.
    expect(floorMarkFor("blacklist", "extended", { scoreFloor: FLOOR, ownerState: RENOUNCED })).toBe("floor");
    expect(floorMarkFor("blacklist", "extended", {})).toBeNull();
    expect(floorMarkFor("ownership", "found-scored", { scoreFloor: FLOOR })).toBeNull();
    expect(floorMarkFor("blacklist", "not-found", { scoreFloor: FLOOR })).toBeNull();
  });
});
