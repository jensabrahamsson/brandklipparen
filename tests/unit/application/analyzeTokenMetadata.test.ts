// Tests for display-only ERC-20 symbol()/name() in the analysis response:
// read through the existing RpcPort at the pinned block, decoded
// strictly, present when the chain answers, absent on any failure, and
// never steering the score.
import { describe, expect, test } from "vitest";
import { Address, BlockNumber, ModelVersion, IndexVersion, RequestId, TemplateVersion, Timestamp } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import { createAppServices } from "../../../src/application/analyzeToken.ts";
import { FileModelArtifactAdapter } from "../../../src/adapters/model/fileArtifact.ts";
import { FakeCacheAdapter } from "../../fakes/fakeCache.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";
import { syntheticAddress } from "../../helpers/syntheticAddresses.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function abiString(text: string): string {
  const bytes = [...text].map((char) => char.charCodeAt(0));
  const out: number[] = [...new Array(31).fill(0), 32, ...new Array(31).fill(0), bytes.length, ...bytes];
  while (out.length % 32 !== 0) {
    out.push(0);
  }
  return `0x${out.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function bytes32(text: string): string {
  const bytes = [...text].map((char) => char.charCodeAt(0));
  while (bytes.length < 32) {
    bytes.push(0);
  }
  return `0x${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

const BYTECODE = "0x8063a9059cbb14600a575bff00";

function codeMap(target: string, bytecode: string): Map<string, string> {
  return new Map([[mustOk(Address.parse(target)) as string, bytecode]]);
}

const SYMBOL_CALL = "0x95d89b41";
const NAME_CALL = "0x06fdde03";

function analyzeInput(target: string) {
  return {
    address: mustOk(Address.parse(target)),
    block: mustOk(BlockNumber.of(24000000)),
    requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(1700000005000)),
    modelVersion: mustOk(ModelVersion.parse("0.0.0-synthetic.1")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: {
      selfdestruct: { risk: "rug-pull", direction: "raises", severity: "high" },
      delegatecall: { risk: "rug-pull", direction: "raises", severity: "high" },
      call: { risk: "honeypot", direction: "raises", severity: "medium" },
      "storage-write": { risk: "bot-pump", direction: "raises", severity: "low" },
    } as const,
  };
}

function servicesWith(rpc: FakeRpcAdapter, cache?: FakeCacheAdapter) {
  return createAppServices(
    {
      rpc,
      modelArtifacts: new FileModelArtifactAdapter(join(repoRoot, "model")),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      ...(cache === undefined ? {} : { cache }),
    },
    mustDefaultDetectorSet(),
  );
}

describe("analysis response token symbol and name", () => {
  test("symbol and name ride the response when the chain answers", async () => {
    const target = syntheticAddress(41);
    const block = mustOk(BlockNumber.of(24000000));
    const rpc = new FakeRpcAdapter(
      codeMap(target, BYTECODE),
      block,
      new Map(),
      { calls: new Map([[SYMBOL_CALL, abiString("TEST")], [NAME_CALL, abiString("Test Token")]]) },
    );
    const analysed = await servicesWith(rpc).analyzeToken(analyzeInput(target));
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    expect(analysed.value.envelope.tokenSymbol).toBe("TEST");
    expect(analysed.value.envelope.tokenName).toBe("Test Token");
  });

  test("bytes32 legacy form decodes", async () => {
    const target = syntheticAddress(42);
    const block = mustOk(BlockNumber.of(24000000));
    const rpc = new FakeRpcAdapter(codeMap(target, BYTECODE), block, new Map(), {
      calls: new Map([[SYMBOL_CALL, bytes32("SYM")], [NAME_CALL, bytes32("NM")]]),
    });
    const analysed = await servicesWith(rpc).analyzeToken(analyzeInput(target));
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    expect(analysed.value.envelope.tokenSymbol).toBe("SYM");
    expect(analysed.value.envelope.tokenName).toBe("NM");
  });

  test("homoglyph symbol rides the response flagged as non-ASCII", async () => {
    const target = syntheticAddress(48);
    const block = mustOk(BlockNumber.of(24000000));
    const utf8 = new TextEncoder().encode("USD\u0442");
    const out: number[] = [...new Array(31).fill(0), 32, ...new Array(31).fill(0), utf8.length, ...utf8];
    while (out.length % 32 !== 0) {
      out.push(0);
    }
    const hex = `0x${out.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const rpc = new FakeRpcAdapter(codeMap(target, BYTECODE), block, new Map(), {
      calls: new Map([[SYMBOL_CALL, hex]]),
    });
    const analysed = await servicesWith(rpc).analyzeToken(analyzeInput(target));
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    expect(analysed.value.envelope.tokenSymbol).toBe("USD\u0442");
    expect(analysed.value.envelope.tokenSymbolNonAscii).toBe(true);
    expect("tokenName" in analysed.value.envelope).toBe(false);
  });

  test("symbol and name stay absent when the chain does not answer", async () => {
    const target = syntheticAddress(43);
    const block = mustOk(BlockNumber.of(24000000));
    const rpc = new FakeRpcAdapter(codeMap(target, BYTECODE), block);
    const analysed = await servicesWith(rpc).analyzeToken(analyzeInput(target));
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    expect("tokenSymbol" in analysed.value.envelope).toBe(false);
    expect("tokenName" in analysed.value.envelope).toBe(false);
  });

  test("hostile returndata stays absent", async () => {
    const target = syntheticAddress(44);
    const block = mustOk(BlockNumber.of(24000000));
    const hostile = `${abiString("AB").slice(0, 2 + 64 * 2)}01${"00".repeat(31)}`;
    const rpc = new FakeRpcAdapter(codeMap(target, BYTECODE), block, new Map(), {
      calls: new Map([[SYMBOL_CALL, hostile]]),
    });
    const analysed = await servicesWith(rpc).analyzeToken(analyzeInput(target));
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    expect("tokenSymbol" in analysed.value.envelope).toBe(false);
  });

  test("metadata never steers the score", async () => {
    const block = mustOk(BlockNumber.of(24000000));
    const plain = new FakeRpcAdapter(codeMap(syntheticAddress(45), BYTECODE), block);
    const named = new FakeRpcAdapter(codeMap(syntheticAddress(46), BYTECODE), block, new Map(), {
      calls: new Map([[SYMBOL_CALL, abiString("TEST")], [NAME_CALL, abiString("Test Token")]]),
    });
    const first = await servicesWith(plain).analyzeToken(analyzeInput(syntheticAddress(45)));
    const second = await servicesWith(named).analyzeToken(analyzeInput(syntheticAddress(46)));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok || first.value.kind !== "assessed" || second.value.kind !== "assessed") {
      throw new Error("expected assessed envelopes");
    }
    expect(second.value.envelope.score).toBe(first.value.envelope.score);
    expect(second.value.envelope.probabilities).toEqual(first.value.envelope.probabilities);
  });

  test("a cache hit still reads fresh metadata", async () => {
    const target = syntheticAddress(47);
    const block = mustOk(BlockNumber.of(24000000));
    const cache = new FakeCacheAdapter();
    const rpc = new FakeRpcAdapter(codeMap(target, BYTECODE), block, new Map(), {
      calls: new Map([[SYMBOL_CALL, abiString("TEST")], [NAME_CALL, abiString("Test Token")]]),
    });
    const services = servicesWith(rpc, cache);
    const first = await services.analyzeToken(analyzeInput(target));
    const second = await services.analyzeToken(analyzeInput(target));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok || first.value.kind !== "assessed" || second.value.kind !== "assessed") {
      throw new Error("expected assessed envelopes");
    }
    expect(first.value.envelope.tokenSymbol).toBe("TEST");
    expect(second.value.envelope.tokenSymbol).toBe("TEST");
  });
});
