// Live-tokens file adapter (E-11 follow-up): atomic save plus typed
// load with a missing-file clean start. Written first (red) per A-21.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadLiveTokensFile, saveLiveTokensFile } from "../../../src/adapters/liveTokens/liveTokensFile.ts";
import type { LiveTokensDoc } from "../../../src/domain/liveTokens.ts";
import { syntheticAddress, syntheticTxHash } from "../../helpers/syntheticAddresses.ts";

const PAIR = syntheticAddress(10);
const TOKEN = syntheticAddress(2);
const TX = syntheticTxHash(1);

function doc(): LiveTokensDoc {
  return {
    version: 1,
    cursorBlock: 21600010,
    items: [
      {
        chainId: 1,
        tokenAddress: TOKEN,
        symbol: "TKN",
        name: "Token",
        pairAddress: PAIR,
        dex: "Uniswap V2",
        block: 21600000,
        txHash: TX,
        logIndex: 0,
        createdAt: 1700000000000,
        blockTimestampMs: 1700000000000 - 3600 * 1000,
        initialLiquidityWeth: "1.5",
        state: "done",
        score: 12,
        riskBand: "Low",
      },
    ],
  };
}

describe("live tokens file", () => {
  test("round trips through an atomic write", () => {
    const dir = mkdtempSync(join(tmpdir(), "live-tokens-"));
    const path = join(dir, "nested", "live-tokens.json");
    const saved = saveLiveTokensFile(path, doc());
    expect(saved.ok).toBe(true);
    expect(path.includes(".tmp-")).toBe(false);
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain(PAIR);
    const loaded = loadLiveTokensFile(path);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value?.cursorBlock).toBe(21600010);
      expect(loaded.value?.items).toHaveLength(1);
      expect(loaded.value?.items[0]?.blockTimestampMs).toBe(1700000000000 - 3600 * 1000);
    }
  });

  test("entries without the chain stamp load with unknown age", () => {
    const dir = mkdtempSync(join(tmpdir(), "live-tokens-"));
    const legacy = join(dir, "legacy.json");
    const withoutStamp = {
      version: 1,
      cursorBlock: 21600010,
      items: [
        {
          chainId: 1,
          tokenAddress: TOKEN,
          symbol: "TKN",
          name: "Token",
          pairAddress: PAIR,
          dex: "Uniswap V2",
          block: 21600000,
          txHash: TX,
          logIndex: 0,
          createdAt: 1700000000000,
          initialLiquidityWeth: "1.5",
          state: "done",
          score: 12,
          riskBand: "Low",
        },
      ],
    };
    writeFileSync(legacy, JSON.stringify(withoutStamp), "utf8");
    const loaded = loadLiveTokensFile(legacy);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value?.items).toHaveLength(1);
      expect(loaded.value?.items[0]?.blockTimestampMs).toBeNull();
    }
  });

  test("missing file loads as a clean start", () => {
    const dir = mkdtempSync(join(tmpdir(), "live-tokens-"));
    const loaded = loadLiveTokensFile(join(dir, "absent.json"));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value).toBeNull();
    }
  });

  test("corrupt files fail typed", () => {
    const dir = mkdtempSync(join(tmpdir(), "live-tokens-"));
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{oops", "utf8");
    expect(loadLiveTokensFile(broken).ok).toBe(false);
    const shaped = join(dir, "shaped.json");
    writeFileSync(shaped, JSON.stringify({ version: 2, cursorBlock: 1, items: [] }), "utf8");
    const loaded = loadLiveTokensFile(shaped);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.kind).toBe("invalid-state");
    }
  });
});
