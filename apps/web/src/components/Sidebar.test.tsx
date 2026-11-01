// Sidebar contract facts (S-134): the token contract address and the
// pair address always render in full with a copy control, never
// shortened.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { Sidebar } from "./Sidebar.tsx";
import { toChecksumAddress } from "../lib/checksumAddress.ts";
import type { AnalyzeSuccess } from "../types.ts";

const TARGET = "0x5ab1e0000000000000000000000000000000a001";
const PAIR = "0x5ab1e0000000000000000000000000000000a0aa";

function result(): AnalyzeSuccess {
  return {
    kind: "assessed",
    target: TARGET,
    block: 18000000,
    proxy: { kind: "none" },
    codeHash: "0xabc",
    modelVersion: "0.1.0",
    artifactChecksum: "checksum",
    indexVersion: "1.0.0",
    templateVersion: "1.0.0",
    assessedAt: 1700000000000,
    probabilities: { "rug-pull": 0.1, honeypot: 0.1, "bot-pump": 0.1 },
    score: 10,
    signals: [],
    explanation: { kind: "template", templateVersion: "1.0.0", claims: [] },
    cantTell: [],
    deepening: "ready",
  };
}

describe("sidebar contract facts", () => {
  test("s134_address_and_pair_render_in_full_with_copy", () => {
    const html = renderToString(
      <Sidebar
        result={result()}
        expert={false}
        address={TARGET}
        apiKey=""
        availability="available"
        liveEntry={{
          tokenAddress: TARGET,
          symbol: "SYNTH",
          name: null,
          pairAddress: PAIR,
          dex: "Uniswap V2",
          block: 21600002,
          createdAt: 1700000000000,
          blockTimestampMs: null,
          ageSeconds: 45,
          initialLiquidityWeth: "1.5",
          state: "done",
        }}
      />,
    );
    // Displayed facts and copied values use the checksummed form. The
    // address block wraps between 4-character groups in the markup, so
    // full-address assertions strip tags first.
    const text = html.replace(/<[^>]+>/g, "");
    expect(toChecksumAddress(TARGET)).toBe("0x5ab1E0000000000000000000000000000000a001");
    expect(toChecksumAddress(PAIR)).toBe("0x5aB1E0000000000000000000000000000000a0aa");
    expect(text).toContain("0x5ab1E0000000000000000000000000000000a001");
    expect(text).toContain("0x5aB1E0000000000000000000000000000000a0aa");
    expect(html).not.toContain(`>${TARGET}<`);
    expect(html).toContain('aria-label="Copy contract address"');
    expect(html).toContain('aria-label="Copy pair address"');
  });
});
