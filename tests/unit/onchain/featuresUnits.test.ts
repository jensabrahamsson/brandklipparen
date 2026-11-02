// BK-18/BK-19: liquidity unit normalisation and LP remainder over
// unique holders. Synthetic addresses only.
import { describe, expect, test } from "vitest";
import { liquidityOf, lpBucketsOf } from "../../../src/domain/onchain/features.ts";

const HOLDER = "0x5ab1e00000000000000000000000000000000011";
const OTHER = "0x5ab1e00000000000000000000000000000000022";

describe("onchain feature units", () => {
  test("weth liquidity reports whole WETH, not wei", () => {
    const out = liquidityOf({
      kind: "v2",
      quote: "WETH",
      quoteIsWeth: true,
      quoteIsStable: false,
      quoteReserve: 1500000000000000000n,
      quoteDecimals: 18,
      wethPerStable: null,
    });
    expect(out).toMatchObject({ status: "ok", wethAmount: "1.5", quoteAmount: "1500000000000000000" });
  });

  test("lp remainder counts an owner-deployer holder once", () => {
    const out = lpBucketsOf({
      kind: "v2",
      lpTotalSupply: 100n,
      balances: { [HOLDER]: 60n, [OTHER]: 40n },
      deployer: HOLDER,
      owner: HOLDER,
    });
    expect(out).toMatchObject({ status: "ok", deployerShare: 0.6, ownerShare: 0.6, otherShare: 0.4 });
  });
});
