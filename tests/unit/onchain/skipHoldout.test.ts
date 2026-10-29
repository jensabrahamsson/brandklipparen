// Skip-holdout gating tests: in skip mode the holdout rows are used for
// the overlap exclusion only and are never scored. Synthetic rows only.
import { describe, expect, test } from "vitest";
import { holdoutRowsForScoring } from "../../../src/application/onchainCalibration.ts";
import { syntheticAddress } from "../../helpers/syntheticAddresses.ts";

const HOLDOUT = [
  { address: syntheticAddress(201) },
  { address: syntheticAddress(202) },
];

describe("skip-holdout gating", () => {
  test("skip mode yields no holdout row for scoring or metrics", () => {
    const gated = holdoutRowsForScoring(true, HOLDOUT);
    expect(gated).toHaveLength(0);
    // No holdout id can reach scoring: every input id is absent.
    for (const row of HOLDOUT) {
      expect(gated).not.toContainEqual(row);
    }
    const scoredIds = gated.map((row) => row.address.toLowerCase());
    expect(scoredIds).toHaveLength(0);
  });

  test("without skip mode the holdout rows pass through untouched", () => {
    const gated = holdoutRowsForScoring(false, HOLDOUT);
    expect(gated).toHaveLength(HOLDOUT.length);
    expect([...gated]).toEqual([...HOLDOUT]);
  });
});
