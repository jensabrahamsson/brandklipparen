// Contract facts redesign (W-7, UI v2 §3): short facts carry no copy
// control, long values copy the full strings, and the deployed sentence
// is gone. Copy writes are exercised in Playwright; these unit checks
// pin the copy mapping plus the static contract through rendering.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { ContractFacts, factCopyTargets } from "./ContractFacts.tsx";
import { toChecksumAddress } from "../lib/checksumAddress.ts";
import type { AnalyzeSuccess } from "../types.ts";
import type { LiveTokenEntry } from "../lib/liveTokens.ts";

const TARGET = "0x0102030405000000000000000000000000000001";
const PAIR = "0x0102030405000000000000000000000000000002";
const IMPL = "0x0102030405000000000000000000000000000003";

function result(overrides: Partial<AnalyzeSuccess> = {}): AnalyzeSuccess {
  return {
    kind: "assessed",
    target: TARGET,
    block: 26315100,
    proxy: { kind: "none" },
    codeHash: "0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
    modelVersion: "1.0.1",
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
    ...overrides,
  };
}

function liveEntry(): LiveTokenEntry {
  return {
    tokenAddress: TARGET,
    symbol: "SYNTH",
    name: null,
    pairAddress: PAIR,
    dex: "Uniswap V3",
    feeTier: 10000,
    block: 26314689,
    createdAt: 1700000000000,
    blockTimestampMs: 1762020000000,
    ageSeconds: 3700,
    initialLiquidityWeth: "0.5",
    state: "done",
  };
}

function htmlOf(proxy: AnalyzeSuccess["proxy"], expert = false, entry: LiveTokenEntry | null = liveEntry()): string {
  return renderToString(
    <ContractFacts
      result={result({ proxy })}
      expert={expert}
      liveEntry={entry}
      address={TARGET}
      apiKey=""
      availability="available"
    />,
  );
}

// Grouped address chunks wrap by group in the markup but read as the
// full address, so address assertions strip tags first.
function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

describe("contract facts copy mapping", () => {
  test("contract pair implementation and hash copy the full values", () => {
    const targets = factCopyTargets(
      result({ proxy: { kind: "eip1967", implementation: IMPL } }),
      liveEntry(),
    );
    expect(targets).toEqual([
      { label: "Copy contract address", value: toChecksumAddress(TARGET) },
      { label: "Copy pair address", value: toChecksumAddress(PAIR) },
      { label: "Copy implementation address", value: toChecksumAddress(IMPL) },
      {
        label: "Copy code hash",
        value: "0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
      },
    ]);
    for (const target of targets) {
      expect(target.value).not.toContain(" ");
      expect(target.value).not.toContain("…");
    }
  });

  test("no proxy means no implementation target and no pair without a feed entry", () => {
    const targets = factCopyTargets(result({ proxy: { kind: "none" } }), null);
    expect(targets.map((target) => target.label)).toEqual(["Copy contract address", "Copy code hash"]);
  });
});

describe("contract facts rendering", () => {
  test("proxy model and block facts have no copy button", () => {
    const html = htmlOf({ kind: "none" });
    const buttons = html.match(/<button[^>]*aria-label="([^"]*)"/g) ?? [];
    const labels = buttons.map((button) => button.match(/aria-label="([^"]*)"/)?.[1] ?? "");
    expect(labels).toContain("Copy contract address");
    expect(labels).toContain("Copy pair address");
    expect(labels).toContain("Copy code hash");
    expect(labels).not.toContain("Copy proxy");
    expect(labels).not.toContain("Copy model");
    expect(labels).not.toContain("Copy block");
    expect(labels).not.toContain("Copy implementation address");
    expect(html).toContain(">None<");
  });

  test("proxy implementation copies the full address with its own button", () => {
    const html = htmlOf({ kind: "eip1967", implementation: IMPL });
    expect(html).toContain("EIP-1967");
    expect(html).toContain('aria-label="Copy implementation address"');
    expect(textOf(html)).toContain(toChecksumAddress(IMPL));
  });

  test("proxy admin renders as a full address fact with its own copy button", () => {
    const admin = "0x3132333435363738393a3b3c3d3e3f4041424344";
    const html = htmlOf({ kind: "eip1967", implementation: IMPL, admin: { kind: "contract", address: admin } });
    expect(html).toContain("Proxy admin");
    expect(html).toContain('aria-label="Copy proxy admin address"');
    expect(html.replace(/<[^>]+>/g, "")).toContain(toChecksumAddress(admin));
  });

  test("eip1967 and zos proxy cards name the admin who can replace the code", () => {
    const admin = "0x3132333435363738393a3b3c3d3e3f4041424344";
    const eip = htmlOf({ kind: "eip1967", implementation: IMPL, admin: { kind: "contract", address: admin } });
    expect(textOf(eip)).toContain("Admin can swap the code. See Proxy admin.");
    const zos = htmlOf({ kind: "zos", implementation: IMPL, admin: { kind: "contract", address: admin } });
    expect(zos).toContain("ZeppelinOS");
    expect(textOf(zos)).toContain("Admin can swap the code. See Proxy admin.");
  });

  test("short values and explanations render verbatim without a deployed sentence", () => {
    const html = htmlOf({ kind: "none" });
    expect(html).toContain("Ethereum mainnet");
    expect(html).toContain("The network this token lives on.");
    expect(html).toContain("The token contract we read.");
    expect(html).toContain("The trading pool where it was first listed.");
    expect(html).toContain("Where the pool trades. 1% is the pool&#x27;s swap fee.");
    expect(html).toContain("What was put in the pool at launch. Small pools move fast.");
    expect(html).toContain("No proxy. Code is fixed.");
    expect(html).toContain("Fingerprint of the code. Same hash, same code.");
    expect(html).toContain("Chain height we read the code at.");
    expect(html).toContain("Version of the scoring model.");
    expect(html).not.toContain("Deployed");
    expect(html).not.toContain("not reported");
  });

  test("first seen renders the compact age in a dated time element", () => {
    const html = htmlOf({ kind: "none" });
    expect(html).toContain("1h ago");
    expect(html).toContain("<time");
    expect(html).toContain(new Date(1762020000000).toISOString());
    expect(html).toContain("When the pool first appeared, at block 26314689.");
  });

  test("code hash truncates in simple mode and shows in full for experts", () => {
    const simple = htmlOf({ kind: "none" }, false);
    expect(simple).toContain("·…·");
    const expert = htmlOf({ kind: "none" }, true);
    expect(expert).not.toContain("·…·");
    expect(textOf(expert)).toContain(
      "0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
    );
  });

  test("every grouped chunk on the card is a whole group, never a tail", () => {
    for (const expert of [false, true]) {
      const chunks = [
        ...htmlOf({ kind: "none" }, expert).matchAll(/<span class="addr-chunk">([^<]*)<\/span>/g),
      ].map((match) => match[1] ?? "");
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        // The 0x-prefixed first group carries six characters; every other
        // group carries four. The old slicing left two-character tails.
        expect([4, 6]).toContain(chunk.length);
      }
    }
  });

  test("load on-chain reads action renders with its live tag contract", () => {
    const html = htmlOf({ kind: "none" });
    expect(html).toContain("Load on-chain reads");
    expect(html).not.toContain("Live · not scored");
  });
});
