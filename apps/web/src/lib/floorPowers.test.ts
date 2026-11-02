import { describe, expect, test } from "vitest";
import { floorMarkFor, powerStatusFor } from "./floorPowers.ts";

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
    // SCORE-6: the floor is the proof, so a floor fact reads as found
    // even when the tile state reads quiet.
    expect(floorMarkFor("blacklist", "not-found", { scoreFloor: FLOOR })).toBe("floor");
  });
});

describe("single power status (SCORE-6)", () => {
  test("floor wins over quiet, renounced and cant-tell states", () => {
    expect(powerStatusFor("blacklist", "not-found", { scoreFloor: FLOOR })).toBe("floor");
    expect(powerStatusFor("blacklist", "cant-tell", { scoreFloor: FLOOR })).toBe("floor");
    expect(powerStatusFor("blacklist", "not-found", { scoreFloor: FLOOR, ownerState: RENOUNCED })).toBe("floor");
    expect(powerStatusFor("blacklist", "found-scored", { scoreFloor: FLOOR })).toBe("found");
    expect(powerStatusFor("pause", "not-run", { scoreFloor: FLOOR })).toBe("cant-tell");
    expect(powerStatusFor("pause", "error", {})).toBe("cant-tell");
  });

  test("ownership reads found when the live read is active or a slot is proven", () => {
    const active = {
      status: "active" as const,
      getter: "owner()" as const,
      address: "0x5ab1e00000000000000000000000000000000001",
      block: 24000000,
      reason: "the owner getter returns a non-zero address",
    };
    expect(powerStatusFor("ownership", "not-found", { ownerState: active })).toBe("found");
    expect(
      powerStatusFor("ownership", "not-found", {}, [{ feature: "owner-slot", slot: 3 }]),
    ).toBe("found");
    expect(powerStatusFor("ownership", "not-found", {}, [{ privilegedFunctions: 11 }])).toBe("not-found");
    expect(powerStatusFor("ownership", "not-found", {})).toBe("not-found");
    expect(powerStatusFor("ownership", "not-found", {}, [{ privilegedFunctions: 0 }])).toBe("not-found");
    expect(powerStatusFor("ownership", "not-found", { ownerState: RENOUNCED }, [{ feature: "owner-slot" }])).toBe("renounced");
  });

  test("proven facts lift to renounced only when absent from the floor", () => {
    expect(powerStatusFor("blacklist", "extended", { ownerState: RENOUNCED })).toBe("renounced");
    expect(powerStatusFor("blacklist", "found-scored", { ownerState: RENOUNCED })).toBe("renounced");
    expect(powerStatusFor("blacklist", "not-found", { ownerState: RENOUNCED })).toBe("not-found");
  });

  test("quiet states pass through without context", () => {
    expect(powerStatusFor("mint", "found-scored", {})).toBe("found");
    expect(powerStatusFor("mint", "extended", {})).toBe("extended");
    expect(powerStatusFor("mint", "cant-tell", {})).toBe("cant-tell");
    expect(powerStatusFor("mint", "not-found", {})).toBe("not-found");
  });
});
