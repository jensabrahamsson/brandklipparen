// Token identity resolution and heading fallbacks: the analysis
// response wins, then the live-list entry, then the short address for
// the title only; the full address always rides the meta (S-134) in
// EIP-55 checksummed form, and the DEX/age meta items are unbreakable
// units that carry their own separators.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { TokenHeader } from "./TokenHeader.tsx";
import { toChecksumAddress } from "../lib/checksumAddress.ts";
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
  const checksummed = "0x5ab1E0000000000000000000000000000000a001";

  test("symbol heads with name and full address beneath", () => {
    const html = renderToString(
      <TokenHeader address={address} identity={{ symbol: "NEW", name: "New Token" }} liveEntry={null} />,
    );
    expect(toChecksumAddress(address)).toBe(checksummed);
    expect(html).toContain("<h1");
    expect(html).toContain(">NEW</h1>");
    expect(html).toContain("New Token");
    expect(html).toContain(checksummed);
    expect(html).not.toContain(`>${address}<`);
    expect(html).toContain('aria-label="Copy contract address"');
  });

  test("live entry supplies the symbol and DEX age meta as unbreakable items", () => {
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
    expect(html).toContain(checksummed);
    // Each meta item renders as one nowrap unit with its own separator.
    expect(html).toContain("Uniswap V3");
    expect(html).toContain("0.3%");
    expect(html).toContain("5 min ago");
    expect(html).toContain("token-meta-age");
    expect(html).toContain("meta-item");
  });

  test("short address heads when nothing names the token, full address in meta", () => {
    const html = renderToString(
      <TokenHeader address={address} identity={{ symbol: null, name: null }} liveEntry={null} />,
    );
    expect(html).toContain(">0x5ab1…a001</h1>");
    expect(html).toContain(checksummed);
    expect(html).toContain("token-address-full");
  });
});
