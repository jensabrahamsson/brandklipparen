// VS-B2 verified-source route: the composed app answers
// `GET /v1/source?address=` with published contract sources, Sourcify
// first and the block explorer fallback. Key-gated like the other read
// routes, cached by code hash, never in the score. `none` (checked,
// nothing published) is distinct from `unavailable` (could not check).
// In-process `inject` only with the fake RPC adapter and recorded
// synthetic transports; no listener is opened and no outbound network
// happens here. All bytecode, sources and addresses below are
// hand-assembled synthetic shapes for tests only.
import { describe, expect, test } from "vitest";
import type { Result } from "../../../src/domain/result.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  IndexVersion,
  ModelVersion,
  Timestamp,
  keccak256HexOfUtf8,
} from "../../../src/domain/types.ts";
import { parseModelArtifact } from "../../../src/domain/risk.ts";
import { SecretString } from "../../../src/ports/config.ts";
import type { AppConfig } from "../../../src/ports/config.ts";
import { buildApp } from "../../../src/composition/app.ts";
import { createRestServer } from "../../../src/interfaces/rest/server.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";
import type { SourcifyTransportResponse } from "../../../src/adapters/source/sourcifyAdapter.ts";
import type { ExplorerSourceTransportResponse } from "../../../src/adapters/source/explorerSourceAdapter.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function placeholderArtifact(): FakeModelArtifactAdapter {
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
  return new FakeModelArtifactAdapter(
    Object.freeze({
      artifact,
      checksum: mustOk(ArtifactChecksum.parse("cd".repeat(32))),
    }),
  );
}

// Hand-assembled synthetic dispatcher with two entries: transfer
// (0xa9059cbb) and balanceOf (0x70a08231).
const TEST_BYTECODE =
  "0x608060405234801561001057600080fd5b508063a9059cbb1461002d57806370a0823114610047575b600080fd5b600035331461003b57600080fd5b60015460023501600155005b6000355460005260206000f3";
const TEST_ADDRESS = "0x0102030405060708090a0b0c0d0e0f1011121314";
const TEST_ADDRESS_SAME_CODE = `0x${"ab".repeat(20)}`;
const TEST_BLOCK = 18000000;
const TEST_API_KEY = "test-key-for-source-suite-only";
const TEST_PEPPER = "test-pepper-for-source-suite-only";
const TEST_EXPLORER_KEY = "test-explorer-key-for-source-suite-only";

// Hand-assembled synthetic contract: the comment and the string each
// name a `function` that must not match; the two real declarations sit
// on known 1-based lines (transfer 7-10, balanceOf 11-13).
const FIXTURE_SOURCE = [
  "// SPDX-License-Identifier: MIT",
  "pragma solidity ^0.8.20;",
  "contract FixtureToken {",
  "    mapping(address => uint256) private balances;",
  '    string private note = "function nope(uint256 x)";',
  "    // function transfer(address,uint256) is below",
  "    function transfer(address to, uint256 amount) public returns (bool) {",
  "        balances[to] += amount;",
  "        return true;",
  "    }",
  "    function balanceOf(address account) public view returns (uint256) {",
  "        return balances[account];",
  "    }",
  "}",
].join("\n");

const FIXTURE_ABI = [
  { type: "function", name: "transfer", inputs: [{ type: "address" }, { type: "uint256" }], stateMutability: "nonpayable" },
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "totalSupply", inputs: [], stateMutability: "view" },
];

function sourcifyVerifiedBody(): string {
  return JSON.stringify({
    match: "full",
    chainId: "1",
    compilerVersion: "0.8.20+commit.a1b79de6",
    compilation: { compilerVersion: "0.8.20+commit.a1b79de6" },
    sources: {
      "contracts/FixtureToken.sol": { content: FIXTURE_SOURCE },
      "contracts/Helper.sol": { content: "// helper note\u202e\nlibrary Helper {\n}" },
    },
    abi: FIXTURE_ABI,
  });
}

function explorerVerifiedBody(): string {
  return JSON.stringify({
    status: "1",
    message: "OK",
    result: [
      {
        SourceCode: FIXTURE_SOURCE,
        ABI: JSON.stringify(FIXTURE_ABI),
        ContractName: "FixtureToken",
        CompilerVersion: "v0.8.20+commit.a1b79de6",
      },
    ],
  });
}

function baseConfig(withExplorerKey: boolean): AppConfig {
  return Object.freeze({
    env: "ci",
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    modelArtifactPath: "model",
    cloneIndexVersion: mustOk(IndexVersion.parse("1.0.0")),
    extdecompDeadlineMs: 5000,
    extdecompMaxOutputBytes: 65536,
    extdecompMaxMemoryMb: 512,
    logLevel: "error",
    apiKeys: Object.freeze([new SecretString(TEST_API_KEY)]),
    apiKeyPepper: new SecretString(TEST_PEPPER),
    rateLimitPerKeyPerMinute: 1000,
    quotaPerKeyPerDay: 10000,
    globalRatePerMinute: 10000,
    sourceProvider: "sourcify",
    ...(withExplorerKey ? { feedEtherscanApiKey: new SecretString(TEST_EXPLORER_KEY) } : {}),
  });
}

function rpcWithBothAddresses(): FakeRpcAdapter {
  const codes = new Map<string, string>([
    [mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE],
    [mustOk(Address.parse(TEST_ADDRESS_SAME_CODE)) as string, TEST_BYTECODE],
  ]);
  return new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK)));
}

type SourceBody = {
  readonly status?: unknown;
  readonly code?: unknown;
  readonly codeHash?: unknown;
  readonly source?:
    | {
        readonly status?: unknown;
        readonly provider?: unknown;
        readonly match?: unknown;
        readonly compiler?: unknown;
        readonly files?: ReadonlyArray<{ readonly path?: unknown; readonly content?: unknown }>;
        readonly functions?: ReadonlyArray<{
          readonly selector?: unknown;
          readonly file?: unknown;
          readonly startLine?: unknown;
          readonly endLine?: unknown;
          readonly name?: unknown;
          readonly signature?: unknown;
        }>;
      }
    | undefined;
};

describe("verified-source route through the composed app (VS-B2)", () => {
  test("vsb2_verified_full_match_serves_files_and_located_functions", async () => {
    const sourcifyCalls: string[] = [];
    const built = buildApp(baseConfig(false), {
      ports: Object.freeze({
        rpc: rpcWithBothAddresses(),
        modelArtifacts: placeholderArtifact(),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      }),
      detectors: mustDefaultDetectorSet(),
      sourceTransports: {
        sourcify: async (url: string): Promise<SourcifyTransportResponse> => {
          sourcifyCalls.push(url);
          expect(url).toContain("sourcify.dev");
          return { status: 200, bodyText: sourcifyVerifiedBody() };
        },
      },
    });
    if (!built.ok) {
      throw new Error(`expected the composed app to build, got ${built.error.kind}`);
    }
    const rest = createRestServer(built.value.rest);
    try {
      const first = await rest.inject({
        method: "GET",
        url: `/v1/source?address=${TEST_ADDRESS}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(first.statusCode).toBe(200);
      const body = JSON.parse(first.body) as SourceBody;
      expect(body.status).toBe("ok");
      expect(typeof body.codeHash).toBe("string");
      const source = body.source;
      expect(source?.status).toBe("verified");
      expect(source?.provider).toBe("sourcify");
      expect(source?.match).toBe("full");
      expect(source?.compiler).toBe("0.8.20+commit.a1b79de6");
      const files = source?.files ?? [];
      expect(files.map((file) => file.path)).toEqual([
        "contracts/FixtureToken.sol",
        "contracts/Helper.sol",
      ]);
      expect(files[0]?.content).toContain("function transfer(");
      // The hidden character in the helper note renders as a visible
      // marker instead of surviving invisibly.
      expect(files[1]?.content).toContain("[[U+202E]]");
      const functions = source?.functions ?? [];
      // totalSupply has no located declaration, so it stays out.
      expect(functions.map((fn) => fn.name)).toEqual(["balanceOf", "transfer"]);
      const transfer = functions.find((fn) => fn.name === "transfer");
      expect(transfer).toMatchObject({
        selector: keccak256HexOfUtf8("transfer(address,uint256)").slice(0, 10),
        file: "contracts/FixtureToken.sol",
        startLine: 7,
        endLine: 10,
        signature: "transfer(address,uint256)",
      });
      expect(transfer?.selector).toMatch(/^0x[0-9a-f]{8}$/);
      // A second call answers byte-identically: the code-hash cache
      // replays the outcome without another provider call.
      const second = await rest.inject({
        method: "GET",
        url: `/v1/source?address=${TEST_ADDRESS}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(second.statusCode).toBe(200);
      expect(second.body).toBe(first.body);
      expect(sourcifyCalls).toHaveLength(1);
      // A different address with identical bytecode shares the cache
      // entry: still one provider call.
      const twin = await rest.inject({
        method: "GET",
        url: `/v1/source?address=${TEST_ADDRESS_SAME_CODE}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(twin.statusCode).toBe(200);
      expect((JSON.parse(twin.body) as SourceBody).source?.status).toBe("verified");
      expect(sourcifyCalls).toHaveLength(1);
    } finally {
      await rest.close();
    }
  });

  test("vsb2_none_when_providers_hold_nothing", async () => {
    const built = buildApp(baseConfig(false), {
      ports: Object.freeze({
        rpc: rpcWithBothAddresses(),
        modelArtifacts: placeholderArtifact(),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      }),
      detectors: mustDefaultDetectorSet(),
      sourceTransports: {
        sourcify: async (): Promise<SourcifyTransportResponse> => ({ status: 404, bodyText: "not found" }),
      },
    });
    if (!built.ok) {
      throw new Error(`expected the composed app to build, got ${built.error.kind}`);
    }
    const rest = createRestServer(built.value.rest);
    try {
      const response = await rest.inject({
        method: "GET",
        url: `/v1/source?address=${TEST_ADDRESS}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as SourceBody;
      expect(body.source).toMatchObject({
        status: "none",
        provider: "sourcify",
        match: null,
        compiler: null,
        files: [],
        functions: [],
      });
    } finally {
      await rest.close();
    }
  });

  test("vsb2_explorer_fallback_serves_when_primary_has_nothing", async () => {
    const seenUrls: string[] = [];
    const built = buildApp(baseConfig(true), {
      ports: Object.freeze({
        rpc: rpcWithBothAddresses(),
        modelArtifacts: placeholderArtifact(),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      }),
      detectors: mustDefaultDetectorSet(),
      sourceTransports: {
        sourcify: async (): Promise<SourcifyTransportResponse> => ({ status: 404, bodyText: "not found" }),
        explorer: async (url: string): Promise<ExplorerSourceTransportResponse> => {
          seenUrls.push(url);
          expect(url).toContain("api.etherscan.io");
          return { status: 200, bodyText: explorerVerifiedBody() };
        },
      },
    });
    if (!built.ok) {
      throw new Error(`expected the composed app to build, got ${built.error.kind}`);
    }
    const rest = createRestServer(built.value.rest);
    try {
      const response = await rest.inject({
        method: "GET",
        url: `/v1/source?address=${TEST_ADDRESS}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as SourceBody;
      expect(body.source?.status).toBe("verified");
      expect(body.source?.provider).toBe("etherscan");
      expect(body.source?.match).toBeNull();
      const functions = body.source?.functions ?? [];
      expect(functions.map((fn) => fn.name)).toEqual(["balanceOf", "transfer"]);
      expect(seenUrls).toHaveLength(1);
    } finally {
      await rest.close();
    }
  });

  test("vsb2_unavailable_when_providers_cannot_be_reached", async () => {
    const built = buildApp(baseConfig(true), {
      ports: Object.freeze({
        rpc: rpcWithBothAddresses(),
        modelArtifacts: placeholderArtifact(),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      }),
      detectors: mustDefaultDetectorSet(),
      sourceTransports: {
        sourcify: async (): Promise<SourcifyTransportResponse> => {
          throw new Error("synthetic transport failure");
        },
        explorer: async (): Promise<ExplorerSourceTransportResponse> => {
          throw new Error("synthetic transport failure");
        },
      },
    });
    if (!built.ok) {
      throw new Error(`expected the composed app to build, got ${built.error.kind}`);
    }
    const rest = createRestServer(built.value.rest);
    try {
      const response = await rest.inject({
        method: "GET",
        url: `/v1/source?address=${TEST_ADDRESS}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      // Could not check is a 200 `unavailable`, distinct from `none`.
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as SourceBody;
      expect(body.source).toMatchObject({
        status: "unavailable",
        provider: null,
        match: null,
        compiler: null,
        files: [],
        functions: [],
      });
    } finally {
      await rest.close();
    }
  });

  test("vsb2_off_provider_answers_unavailable_with_zero_provider_calls", async () => {
    const config = baseConfig(false);
    const { sourceProvider: _dropped, ...withoutProvider } = config as Record<string, unknown>;
    void _dropped;
    const built = buildApp(withoutProvider as AppConfig, {
      ports: Object.freeze({
        rpc: rpcWithBothAddresses(),
        modelArtifacts: placeholderArtifact(),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      }),
      detectors: mustDefaultDetectorSet(),
      sourceTransports: {
        sourcify: async (): Promise<SourcifyTransportResponse> => {
          throw new Error("the disabled route must not call any provider");
        },
      },
    });
    if (!built.ok) {
      throw new Error(`expected the composed app to build, got ${built.error.kind}`);
    }
    const rest = createRestServer(built.value.rest);
    try {
      const response = await rest.inject({
        method: "GET",
        url: `/v1/source?address=${TEST_ADDRESS}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as SourceBody;
      expect(body.source?.status).toBe("unavailable");
      expect(body.source?.provider).toBeNull();
    } finally {
      await rest.close();
    }
  });

  test("vsb2_route_is_key_gated_and_validates_the_address", async () => {
    const built = buildApp(baseConfig(false), {
      ports: Object.freeze({
        rpc: rpcWithBothAddresses(),
        modelArtifacts: placeholderArtifact(),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      }),
      detectors: mustDefaultDetectorSet(),
      sourceTransports: {
        sourcify: async (): Promise<SourcifyTransportResponse> => ({ status: 404, bodyText: "not found" }),
      },
    });
    if (!built.ok) {
      throw new Error(`expected the composed app to build, got ${built.error.kind}`);
    }
    const rest = createRestServer(built.value.rest);
    try {
      const missing = await rest.inject({ method: "GET", url: `/v1/source?address=${TEST_ADDRESS}` });
      expect(missing.statusCode).toBe(401);
      expect((JSON.parse(missing.body) as SourceBody).code).toBe("missing-api-key");
      const badAddress = await rest.inject({
        method: "GET",
        url: "/v1/source?address=0x123",
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(badAddress.statusCode).toBe(400);
      expect((JSON.parse(badAddress.body) as SourceBody).code).toBe("validation-error");
    } finally {
      await rest.close();
    }
  });

  test("vsb2_registry_match_words_crlf_and_bom_normalise_end_to_end", async () => {
    // Live-registry shape: the match word arrives as `runtimeMatch`
    // with value "exact_match", sources use CRLF, and one file starts
    // with a BOM. All fixtures below are hand-assembled synthetic
    // shapes for tests only.
    const crlfSource = FIXTURE_SOURCE.split("\n").join("\r\n");
    const built = buildApp(baseConfig(false), {
      ports: Object.freeze({
        rpc: rpcWithBothAddresses(),
        modelArtifacts: placeholderArtifact(),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      }),
      detectors: mustDefaultDetectorSet(),
      sourceTransports: {
        sourcify: async (): Promise<SourcifyTransportResponse> => ({
          status: 200,
          bodyText: JSON.stringify({
            runtimeMatch: "exact_match",
            chainId: "1",
            compilation: { compilerVersion: "0.8.20+commit.a1b79de6" },
            sources: {
              "contracts/FixtureToken.sol": { content: crlfSource },
              "contracts/Helper.sol": {
                content: `${String.fromCharCode(0xfeff)}// helper note\r\nlibrary Helper {\r\n}`,
              },
            },
            abi: FIXTURE_ABI,
          }),
        }),
      },
    });
    if (!built.ok) {
      throw new Error(`expected the composed app to build, got ${built.error.kind}`);
    }
    const rest = createRestServer(built.value.rest);
    try {
      const response = await rest.inject({
        method: "GET",
        url: `/v1/source?address=${TEST_ADDRESS}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as SourceBody;
      expect(body.source?.status).toBe("verified");
      expect(body.source?.match).toBe("full");
      const files = body.source?.files ?? [];
      expect(files.map((file) => file.path)).toEqual([
        "contracts/FixtureToken.sol",
        "contracts/Helper.sol",
      ]);
      for (const file of files) {
        expect(file.content as string).not.toContain("[[U+000D]]");
        expect(file.content as string).not.toContain("\r");
      }
      expect(files[0]?.content).toContain("function transfer(");
      expect(files[1]?.content).toBe("// helper note\nlibrary Helper {\n}");
      const functions = body.source?.functions ?? [];
      expect(functions.map((fn) => fn.name)).toEqual(["balanceOf", "transfer"]);
    } finally {
      await rest.close();
    }
  });
});
