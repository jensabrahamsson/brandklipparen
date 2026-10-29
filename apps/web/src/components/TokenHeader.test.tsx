// Token identity resolution and heading fallbacks: the analysis
// response wins, then the live-list entry, then the short address.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { TokenHeader } from "./TokenHeader.tsx";
import { resolveTokenIdentity } from "../lib/tokenIdentity.ts";

describe("token identity resolution", () => {
  test("analysis symbol and name win over the live entry", () => {
    expect(
      resolveTokenIdentity(
        { tokenSymbol: "NEW", tokenName: "New Token" },
        { symbol: "OLD", name: "Old Token" },
      ),
    ).toEqual({ symbol: "NEW", name: "New Token" });
  });

  test("live entry fills gaps the analysis leaves", () => {
    expect(resolveTokenIdentity({}, { symbol: "LIVE", name: null })).toEqual({
      symbol: "LIVE",
      name: null,
    });
  });

  test("blank strings fall through to the short address", () => {
    expect(resolveTokenIdentity({ tokenSymbol: "  ", tokenName: "" }, null)).toEqual({
      symbol: null,
      name: null,
    });
  });
});

describe("token heading fallbacks", () => {
  const address = "0x5ab1e0000000000000000000000000000000a001";

  test("symbol heads with name and short address beneath", () => {
    const html = renderToString(
      <TokenHeader address={address} identity={{ symbol: "NEW", name: "New Token" }} liveEntry={null} />,
    );
    expect(html).toContain("<h1");
    expect(html).toContain(">NEW</h1>");
    expect(html).toContain("New Token");
    expect(html).toContain("0x5ab1…a001");
  });

  test("live entry supplies the symbol and DEX age meta", () => {
    const html = renderToString(
      <TokenHeader
        address={address}
        identity={{ symbol: "LIVE", name: null }}
        liveEntry={{
          tokenAddress: address,
          symbol: "LIVE",
          name: null,
          pairAddress: "0x5ab1e0000000000000000000000000000000b0bb",
          dex: "Uniswap V3",
          feeTier: 3000,
          block: 21600002,
          createdAt: 1700000000000,
          blockTimestampMs: null,
          ageSeconds: 300,
          initialLiquidityWeth: null,
          state: "done",
        }}
      />,
    );
    expect(html).toContain(">LIVE</h1>");
    expect(html).toContain("Uniswap V3 · 0.3% · 5 min ago");
  });

  test("short address heads when nothing names the token", () => {
    const html = renderToString(
      <TokenHeader address={address} identity={{ symbol: null, name: null }} liveEntry={null} />,
    );
    expect(html).toContain(">0x5ab1…a001</h1>");
  });
});
