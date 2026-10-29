// Locker-set alignment tests (issue 4): one source of truth
// (LOCKER_REGISTRY) drives both the snapshot mapping and the live LP
// plugin, so train and serve use the same locker definition. Registry
// entries are derived at runtime; no locker name or address is hardcoded
// here, only synthetic filler values.
import { describe, expect, test } from "vitest";
import {
  LOCKER_REGISTRY,
  lockerAddresses,
  lockerShareOfBreakdown,
  snapshotLockerNames,
} from "../../../src/domain/onchain/lockers.ts";
import { lpBucketsOf } from "../../../src/domain/onchain/features.ts";
import { syntheticAddress } from "../../helpers/syntheticAddresses.ts";

describe("locker set alignment between snapshot mapping and live plugin", () => {
  test("every snapshot locker name resolves through the shared registry", () => {
    const names = snapshotLockerNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const entry = LOCKER_REGISTRY.find((candidate) => candidate.snapshotNames.includes(name));
      expect(entry).toBeDefined();
      expect(entry?.kind).toBe("v2-lp");
    }
  });

  test("the snapshot mapping sums exactly the registry locker names", () => {
    const names = snapshotLockerNames();
    const breakdown: Record<string, number> = {};
    for (const name of names) {
      breakdown[name] = 0.1;
    }
    breakdown["Unknown Locker"] = 0.5;
    const share = lockerShareOfBreakdown(breakdown);
    expect(share).toBeCloseTo(0.1 * names.length, 9);
  });

  test("the live LP plugin counts exactly the registry v2 locker addresses", () => {
    const lockers = LOCKER_REGISTRY.filter((entry) => entry.kind === "v2-lp").map((entry) =>
      entry.address.toLowerCase(),
    );
    expect(lockers.length).toBeGreaterThan(0);
    expect(lockerAddresses().length).toBeGreaterThanOrEqual(lockers.length);
    const supply = 1000n * BigInt(Math.max(1, lockers.length));
    const balances: Record<string, bigint> = {};
    for (const locker of lockers) {
      balances[locker] = 1000n;
    }
    const buckets = lpBucketsOf({ kind: "v2", lpTotalSupply: supply, balances, deployer: null, owner: null });
    expect(buckets.status).toBe("ok");
    if (buckets.status !== "ok") {
      return;
    }
    expect(buckets.lockerShare).toBeCloseTo(1, 9);
    // A non-registry holder is never counted as a locker.
    const outsider = syntheticAddress(211);
    const mixed = lpBucketsOf({
      kind: "v2",
      lpTotalSupply: 2000n,
      balances: { [lockers[0] ?? outsider]: 1000n, [outsider.toLowerCase()]: 1000n },
      deployer: null,
      owner: null,
    });
    expect(mixed.status).toBe("ok");
    if (mixed.status !== "ok") {
      return;
    }
    expect(mixed.lockerShare).toBeCloseTo(0.5, 9);
  });
});
