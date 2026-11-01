// S-007 failing tests first (red): EIP-1167 minimal proxies and EIP-7702
// delegations (K-004, K-007). Uses fake RPC with frozen synthetic values;
// no network access. All addresses are synthetic and unused elsewhere.
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { createAppServices } from "../../src/application/analyzeToken.ts";
import { resolveProxy } from "../../src/application/resolveProxy.ts";
import type { Result } from "../../src/domain/result.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  Bytecode,
  CodeHash,
  IndexVersion,
  ModelVersion,
  RequestId,
  TemplateVersion,
  Timestamp,
} from "../../src/domain/types.ts";
import type {
  BlockNumber as BlockNumberType,
  Bytecode as BytecodeType,
} from "../../src/domain/types.ts";
import type { CapabilityCatalogue } from "../../src/domain/signals.ts";
import { parseModelArtifact } from "../../src/domain/risk.ts";
import type { LoadedArtifact } from "../../src/ports/modelArtifact.ts";
import { FakeClockAdapter } from "../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../fakes/fakeRpc.ts";
import { mustDefaultDetectorSet } from "../helpers/detectorSets.ts";

const HEAD_BLOCK = 24000000;

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function headBlock(): BlockNumberType {
  return mustOk(BlockNumber.of(HEAD_BLOCK));
}

function requestInput(address: string, block: BlockNumberType) {
  return {
    address: mustOk(Address.parse(address)),
    block,
    requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(4102444800000)),
  } as const;
}

// Synthetic addresses (checksummed at parse, never real contracts).
const MINIMAL_PROXY = "0x0a0b0c0d0e0f1011121314151617181920212223";
const MINIMAL_TARGET = "0x3a3b3c3d3e3f4041424344454647484950515253";
const DELEGATED_ACCOUNT = "0x5a5b5c5d5e5f6061626364656667686970717273";
const DELEGATED_TARGET = "0x7a7b7c7d7e7f8081828384858687888990919293";
const TARGET_CODE = "0x6001600055";
const OTHER_CODE = "0x6002600055";

const EIP1167_PREFIX = "363d3d373d3d3d363d73";
const EIP1167_SUFFIX = "5af43d82803e903d91602b57fd5bf3";

function minimalProxyBytecode(target: string): string {
  return `0x${EIP1167_PREFIX}${target.slice(2).toLowerCase()}${EIP1167_SUFFIX}`;
}

function delegationCode(delegation: string): string {
  return `0xef0100${delegation.slice(2).toLowerCase()}`;
}

function codesFor(entries: ReadonlyArray<readonly [string, string]>): Map<string, string> {
  const codes = new Map<string, string>();
  for (const [address, code] of entries) {
    codes.set(mustOk(Address.parse(address)) as string, code);
  }
  return codes;
}

function placeholderLoadedArtifact(): LoadedArtifact {
  const artifact = mustOk(
    parseModelArtifact({
      version: "0.1.0",
      severityWeights: { low: 0.2, medium: 0.5, high: 1.0 },
      causeWeights: {
        timeout: 0.4,
        "resource-limit": 0.4,
        "decompiler-error": 0.6,
        "obfuscated-structure": 0.6,
      },
      biases: { "rug-pull": 0.0, honeypot: 0.0, "bot-pump": 0.0 },
      calibration: {
        "rug-pull": { slope: 1.0, intercept: 0.0 },
        honeypot: { slope: 1.0, intercept: 0.0 },
        "bot-pump": { slope: 1.0, intercept: 0.0 },
      },
      scoreWeights: { "rug-pull": 1.0, honeypot: 1.0, "bot-pump": 1.0 },
    }),
  );
  return Object.freeze({
    artifact,
    checksum: mustOk(ArtifactChecksum.parse("ab".repeat(32))),
  });
}

const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

describe("S-007 minimal proxy and 7702 delegation (K-004, K-007)", () => {
  test("k004_eip1167_reads_embedded_target", async () => {
    const proxyCode = minimalProxyBytecode(MINIMAL_TARGET);
    const codes = codesFor([
      [MINIMAL_PROXY, proxyCode],
      [MINIMAL_TARGET, TARGET_CODE],
    ]);
    const rpc = new FakeRpcAdapter(codes, headBlock());
    const result = await resolveProxy({ rpc }, requestInput(MINIMAL_PROXY, headBlock()));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const resolution = result.value.resolution;
    expect(resolution.kind).toBe("eip1167");
    if (resolution.kind !== "eip1167") {
      return;
    }
    expect(resolution.target as string).toBe(mustOk(Address.parse(MINIMAL_TARGET)) as string);
    const expectedHash = mustOk(CodeHash.of(mustOk(Bytecode.parse(TARGET_CODE))));
    expect(resolution.targetCodeHash as string).toBe(expectedHash as string);
  });

  test("k004_target_marked_as_fixed", async () => {
    const proxyCode = minimalProxyBytecode(MINIMAL_TARGET);
    const codes = codesFor([
      [MINIMAL_PROXY, proxyCode],
      [MINIMAL_TARGET, TARGET_CODE],
    ]);
    const rpc = new FakeRpcAdapter(codes, headBlock());
    const result = await resolveProxy({ rpc }, requestInput(MINIMAL_PROXY, headBlock()));
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.resolution.kind !== "eip1167") {
      throw new Error("expected an eip1167 resolution");
    }
    expect(result.value.resolution.mutability).toBe("fixed");
  });

  test("k004_nonmatching_bytecode_means_no_eip1167_proxy", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 0, maxLength: 128 }),
        async (bytes: number[]) => {
          const hex = `0x${bytes.map((byte) => (byte as number).toString(16).padStart(2, "0")).join("")}`;
          const parsed = Bytecode.parse(hex);
          if (!parsed.ok) {
            return;
          }
          const { parseEip1167Target } = await import("../../src/domain/proxy.ts");
          const found = parseEip1167Target(parsed.value as BytecodeType);
          if (found === null) {
            return;
          }
          // A reported target must come from one of the known templates:
          // the standard EIP-1167 runtime (with optional trailing immutable
          // args) or the Solady PUSH0 clone runtime (likewise).
          const raw = (parsed.value as Uint8Array);
          const standard =
            raw.length >= 45 &&
            raw[0] === 0x36 && raw[1] === 0x3d && raw[2] === 0x3d && raw[3] === 0x37 &&
            raw[4] === 0x3d && raw[5] === 0x3d && raw[6] === 0x3d && raw[7] === 0x36 &&
            raw[8] === 0x3d && raw[9] === 0x73 &&
            raw[30] === 0x5a && raw[44] === 0xf3;
          const push0 =
            raw.length >= 45 &&
            raw[0] === 0x5f && raw[1] === 0x5f && raw[2] === 0x36 && raw[3] === 0x5f &&
            raw[4] === 0x5f && raw[5] === 0x37 && raw[6] === 0x36 && raw[7] === 0x5f &&
            raw[8] === 0x73 &&
            raw[29] === 0x5a && raw[44] === 0xf3;
          expect(standard || push0).toBe(true);
        },
      ),
      { numRuns: 40 },
    );
  });

  test("k007_eip7702_follows_delegation", async () => {
    const accountCode = delegationCode(DELEGATED_TARGET);
    const codes = codesFor([
      [DELEGATED_ACCOUNT, accountCode],
      [DELEGATED_TARGET, OTHER_CODE],
    ]);
    const rpc = new FakeRpcAdapter(codes, headBlock());
    const result = await resolveProxy({ rpc }, requestInput(DELEGATED_ACCOUNT, headBlock()));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const resolution = result.value.resolution;
    expect(resolution.kind).toBe("eip7702");
    if (resolution.kind !== "eip7702") {
      return;
    }
    expect(resolution.delegation as string).toBe(
      mustOk(Address.parse(DELEGATED_TARGET)) as string,
    );
    const expectedHash = mustOk(CodeHash.of(mustOk(Bytecode.parse(OTHER_CODE))));
    expect(resolution.delegationCodeHash as string).toBe(expectedHash as string);
  });

  test("k007_delegation_marked_as_changeable", async () => {
    const accountCode = delegationCode(DELEGATED_TARGET);
    const codes = codesFor([
      [DELEGATED_ACCOUNT, accountCode],
      [DELEGATED_TARGET, OTHER_CODE],
    ]);
    const rpc = new FakeRpcAdapter(codes, headBlock());
    const result = await resolveProxy({ rpc }, requestInput(DELEGATED_ACCOUNT, headBlock()));
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.resolution.kind !== "eip7702") {
      throw new Error("expected an eip7702 resolution");
    }
    expect(result.value.resolution.mutability).toBe("changeable-by-new-authorization");
  });

  test("k007_other_prefix_means_no_eip7702_delegation", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 0, maxLength: 64 }),
        async (bytes: number[]) => {
          // Skip the delegated shape itself: first three bytes ef0100 with length 23.
          if (
            bytes.length === 23 &&
            bytes[0] === 0xef &&
            bytes[1] === 0x01 &&
            bytes[2] === 0x00
          ) {
            return;
          }
          const hex = `0x${bytes.map((byte) => (byte as number).toString(16).padStart(2, "0")).join("")}`;
          const parsed = Bytecode.parse(hex);
          if (!parsed.ok) {
            return;
          }
          const { parseEip7702Delegation } = await import("../../src/domain/proxy.ts");
          expect(parseEip7702Delegation(parsed.value as BytecodeType)).toBeNull();
        },
      ),
      { numRuns: 40 },
    );
  });

  test("analysis_of_minimal_proxy_resolves_and_scores", async () => {
    const proxyCode = minimalProxyBytecode(MINIMAL_TARGET);
    const proxy = mustOk(Address.parse(MINIMAL_PROXY));
    const block = headBlock();
    const codes = new Map<string, string>([
      [proxy as string, proxyCode],
      [mustOk(Address.parse(MINIMAL_TARGET)) as string, TARGET_CODE],
    ]);
    const services = createAppServices({
      rpc: new FakeRpcAdapter(codes, block),
      modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact()),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
  mustDefaultDetectorSet());
    const analysed = await services.analyzeToken({
      address: proxy,
      block,
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustOk(ModelVersion.parse("0.1.0")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    });
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    expect(analysed.value.envelope.proxy.kind).toBe("eip1167");
    expect(typeof (analysed.value.envelope.score as number)).toBe("number");
  });

  test("analysis_of_7702_account_resolves_and_scores", async () => {
    const accountCode = delegationCode(DELEGATED_TARGET);
    const account = mustOk(Address.parse(DELEGATED_ACCOUNT));
    const block = headBlock();
    const codes = new Map<string, string>([
      [account as string, accountCode],
      [mustOk(Address.parse(DELEGATED_TARGET)) as string, OTHER_CODE],
    ]);
    const services = createAppServices({
      rpc: new FakeRpcAdapter(codes, block),
      modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact()),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
  mustDefaultDetectorSet());
    const analysed = await services.analyzeToken({
      address: account,
      block,
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustOk(ModelVersion.parse("0.1.0")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    });
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    expect(analysed.value.envelope.proxy.kind).toBe("eip7702");
    expect(typeof (analysed.value.envelope.score as number)).toBe("number");
  });
});
