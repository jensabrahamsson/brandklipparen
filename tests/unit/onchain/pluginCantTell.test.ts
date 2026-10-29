// On-chain plugins can't-tell paths: every pure computation reports
// can't-tell with a reason on missing or failed data, never a guess.
// Synthetic values only; no chain reads here.
import { describe, expect, test } from "vitest";
import { liquidityOf, lpBucketsOf, ownerFeatureOf } from "../../../src/domain/onchain/features.ts";
import { concentrationOf } from "../../../src/domain/onchain/transfers.ts";
import { TRANSFER_LOG_CAP } from "../../../src/domain/onchain/transfers.ts";

describe("on-chain plugins can't-tell paths", () => {
  test("owner without proof stays can't-tell", () => {
    expect(ownerFeatureOf({ ownerWord: null, ownerHasCode: false, masterCopy: null, slotProven: false })).toEqual({
      status: "cant-tell",
      reason: "no proven owner slot and no owner() answer",
    });
    const renounced = ownerFeatureOf({
      ownerWord: "0x0000000000000000000000000000000000000000",
      ownerHasCode: false,
      masterCopy: null,
      slotProven: true,
    });
    expect(renounced.status).toBe("ok");
  });

  test("lp buckets stay can't-tell on v3 or missing supply", () => {
    expect(
      lpBucketsOf({ kind: "v3", lpTotalSupply: 100n, balances: {}, deployer: null, owner: null }),
    ).toEqual({ status: "cant-tell", reason: "v3 position ownership is too costly to prove" });
    expect(
      lpBucketsOf({ kind: "v2", lpTotalSupply: null, balances: {}, deployer: null, owner: null }),
    ).toEqual({ status: "cant-tell", reason: "lp total supply is missing or zero" });
    expect(
      lpBucketsOf({ kind: "v2", lpTotalSupply: 0n, balances: {}, deployer: null, owner: null }),
    ).toEqual({ status: "cant-tell", reason: "lp total supply is missing or zero" });
  });

  test("liquidity stays can't-tell on v3 or missing reserves", () => {
    expect(
      liquidityOf({
        kind: "v3",
        quote: "0x0102030405000000000000000000000000000001",
        quoteIsWeth: true,
        quoteIsStable: false,
        quoteReserve: 1n,
        quoteDecimals: 18,
        wethPerStable: null,
      }),
    ).toEqual({ status: "cant-tell", reason: "v3 liquidity math is too costly to prove" });
    expect(
      liquidityOf({
        kind: "v2",
        quote: "0x0102030405000000000000000000000000000001",
        quoteIsWeth: true,
        quoteIsStable: false,
        quoteReserve: null,
        quoteDecimals: 18,
        wethPerStable: null,
      }),
    ).toEqual({ status: "cant-tell", reason: "quote reserves are missing" });
  });

  test("concentration stays can't-tell without a usable supply", () => {
    expect(
      concentrationOf({ transfers: [], excluded: [], totalSupply: null, deployer: null, owner: null }),
    ).toEqual({ kind: "cant-tell", reason: "total supply is missing or zero" });
    expect(TRANSFER_LOG_CAP).toBeGreaterThan(0);
  });
});
