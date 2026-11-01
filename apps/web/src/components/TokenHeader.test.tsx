// Token identity resolution and heading fallbacks: the analysis
// response wins, then the live-list entry, then the short address for
// the title only; the full address always rides the meta (S-134) in
// EIP-55 checksummed form, and DEX, fee tier and age ride one shared
// unbreakable unit with interior separators while every other boundary
// draws its separator through CSS.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { TokenHeader, groupAddressChunks } from "./TokenHeader.tsx";
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
    // The name rides the h1 as a subtitle, not as a meta item.
    expect(html).toContain(">NEW");
    expect(html).toContain('<span class="token-sub">New Token</span>');
    expect(html).not.toContain("meta-addr");
    expect(html.replace(/<[^>]*>/g, "")).toContain(checksummed);
    expect(html).not.toContain(`>${address}<`);
    expect(html).toContain('aria-label="Copy contract address"');
  });

  test("the copy button sits on the label row ahead of the grouped value", () => {
    const html = renderToString(
      <TokenHeader address={address} identity={{ symbol: "NEW", name: "New Token" }} liveEntry={null} />,
    );
    expect(html).toContain("token-addr-top");
    const copyAt = html.indexOf("copy-contract-address");
    const valueAt = html.indexOf("token-address-full");
    expect(copyAt).toBeGreaterThanOrEqual(0);
    expect(valueAt).toBeGreaterThanOrEqual(0);
    expect(copyAt).toBeLessThan(valueAt);
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
    expect(html.replace(/<[^>]*>/g, "")).toContain(checksummed);
    // Each meta item renders as one nowrap unit with its own separator.
    expect(html).toContain("Uniswap V3");
    expect(html).toContain("0.3%");
    expect(html).toContain("5 min ago");
    expect(html).toContain("token-meta-age");
    expect(html).toContain("meta-item");
  });

  test("dex, fee and age stay one unbreakable unit with interior separators", () => {
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
    // The heading meta reads as one contiguous run: the boundary
    // separators live in CSS, so no inline separator can strand here.
    // (Server rendering interleaves tags and comment markers; the
    // browser text run itself is contiguous, as the heading e2e shows.)
    expect(html.replace(/<!-- -->|<[^>]*>/g, "")).toContain("Uniswap V3 · 0.3% · 5 min ago");
    expect(html).not.toContain("meta-sep");
  });

  test("short address heads when nothing names the token, full address in meta", () => {
    const html = renderToString(
      <TokenHeader address={address} identity={{ symbol: null, name: null }} liveEntry={null} />,
    );
    expect(html).toContain(">0x5ab1…a001</h1>");
    expect(html.replace(/<[^>]*>/g, "")).toContain(checksummed);
    expect(html).toContain("token-address-full");
  });
});

describe("grouped address keeps the exact value (N-15)", () => {
  const address = "0x5ab1e0000000000000000000000000000000a001";
  const checksummed = "0x5ab1E0000000000000000000000000000000a001";

  test("0x stays glued to the first group: ten groups, no orphan tail", () => {
    const chunks = groupAddressChunks(checksummed);
    expect(chunks.join("")).toBe(checksummed);
    expect(chunks).toHaveLength(10);
    expect(chunks[0]).toBe("0x5ab1");
    for (const chunk of chunks) {
      expect(chunk).not.toContain(" ");
      expect(chunk.length).toBeGreaterThanOrEqual(4);
    }
    for (const chunk of chunks.slice(1)) {
      expect(chunk).toHaveLength(4);
    }
  });

  test("hash input chunks the same way with no two-character group", () => {
    const hash = "0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
    const chunks = groupAddressChunks(hash);
    expect(chunks.join("")).toBe(hash);
    expect(chunks).toHaveLength(16);
    expect(chunks[0]).toBe("0x0102");
    for (const chunk of chunks.slice(1)) {
      expect(chunk).toHaveLength(4);
    }
  });

  test("accessible text and copy control keep the unchanged full address", () => {
    const html = renderToString(
      <TokenHeader address={address} identity={{ symbol: null, name: null }} liveEntry={null} />,
    );
    expect(html).toContain("addr-chunk");
    expect(html).toContain('aria-label="Copy contract address"');
    const stripped = html.replace(/<[^>]*>/g, "");
    expect(stripped).toContain(checksummed);
  });
});
