// S-095 snippet deepening over REST (K-008, K-010): quoted source lines
// per dispatcher selector from the local pipeline. Written first per A-21
// (red): no `/v1/snippet` route and no `snippetService` option exist yet,
// so every test below fails until the story is implemented. In-process
// `inject` only with the fake RPC adapter and a counting decompile
// wrapper; no listener is opened and no outbound network happens here.
import { describe, expect, test } from "vitest";
import type { Result } from "../../../src/domain/result.ts";
import {
  Address,
  BlockNumber,
  IndexVersion,
  ModelVersion,
  TemplateVersion,
  Timestamp,
} from "../../../src/domain/types.ts";
import type { Bytecode as BytecodeType } from "../../../src/domain/types.ts";
import type { DecompiledContract } from "../../../src/domain/evmSsa.ts";
import { decompileContract } from "../../../src/domain/evmSsa.ts";
import type { CapabilityCatalogue } from "../../../src/domain/signals.ts";
import { createAppServices } from "../../../src/application/analyzeToken.ts";
import type { AppServices } from "../../../src/application/analyzeToken.ts";
import { SecretString } from "../../../src/ports/config.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { parseModelArtifact } from "../../../src/domain/risk.ts";
import { ArtifactChecksum } from "../../../src/domain/types.ts";
import { createRestServer } from "../../../src/interfaces/rest/server.ts";
import type { RestServer } from "../../../src/interfaces/rest/server.ts";
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";

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

const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

// Hand-assembled dispatcher fixture with two entries: transfer
// (0xa9059cbb) and balanceOf (0x70a08231). Mirrors the token-simple
// corpus shape so the fast-path scan and the pipeline agree on entries.
const TEST_ADDRESS = "0x0102030405060708090a0b0c0d0e0f1011121314";
const TEST_BYTECODE =
  "0x608060405234801561001057600080fd5b508063a9059cbb1461002d57806370a0823114610047575b600080fd5b600035331461003b57600080fd5b60015460023501600155005b6000355460005260206000f3";
const TEST_BLOCK = 18000000;
const TEST_API_KEY = "test-key-for-snippet-suite-only";
const TEST_PEPPER = "test-pepper-for-snippet-suite-only";

function testServer(options?: {
  readonly decompile?: ((bytecode: BytecodeType) => DecompiledContract) | undefined;
  readonly onRpc?: ((fake: FakeRpcAdapter) => void) | undefined;
}): { server: RestServer; rpc: FakeRpcAdapter; decompileCalls: number } {
  const codes = new Map<string, string>([[mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE]]);
  const rpcFake = new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK)));
  let decompileCalls = 0;
  const decompile = (bytecode: BytecodeType): DecompiledContract => {
    decompileCalls += 1;
    return (options?.decompile ?? decompileContract)(bytecode);
  };
  const services: AppServices = createAppServices(
    {
      rpc: rpcFake,
      modelArtifacts: placeholderArtifact(),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
    mustDefaultDetectorSet(),
  );
  const server = createRestServer({
    services,
    apiKeys: [new SecretString(TEST_API_KEY)] as readonly SecretString[],
    apiKeyPepper: new SecretString(TEST_PEPPER),
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
    detectors: mustDefaultDetectorSet(),
    snippetRpc: rpcFake,
    snippetDecompile: decompile,
  });
  if (options?.onRpc !== undefined) {
    options.onRpc(rpcFake);
  }
  return {
    server,
    rpc: rpcFake,
    get decompileCalls(): number {
      return decompileCalls;
    },
  };
}

type SnippetBody = {
  readonly status?: unknown;
  readonly snippet?: {
    readonly selector?: unknown;
    readonly entryPc?: unknown;
    readonly lines?: ReadonlyArray<{ readonly selector?: unknown; readonly lineNumber?: unknown; readonly text?: unknown }>;
  };
};

describe("snippet deepening per selector (S-095)", () => {
  test("s095_snippet_returns_quoted_text_per_selector", async () => {
    const built = testServer();
    try {
      const response = await built.server.inject({
        method: "GET",
        url: `/v1/snippet?address=${TEST_ADDRESS}&selector=0xa9059cbb`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as SnippetBody;
      const snippet = body.snippet;
      expect(snippet?.selector).toBe("0xa9059cbb");
      expect(typeof snippet?.entryPc).toBe("number");
      const lines = snippet?.lines ?? [];
      expect(lines.length).toBeGreaterThan(0);
      // Each snippet line carries its selector, a 1-based line number and
      // non-empty quoted text from the local pipeline emission.
      for (const [index, line] of lines.entries()) {
        expect(line.selector).toBe("0xa9059cbb");
        expect(line.lineNumber).toBe(index + 1);
        expect(typeof line.text).toBe("string");
        expect((line.text as string).length).toBeGreaterThan(0);
      }
      // The quoted lines are exactly the pipeline's rendered block for the
      // selector: header line first, closing brace last.
      expect(lines[0]?.text).toContain("function transfer(");
      expect(lines[lines.length - 1]?.text).toBe("}");
      expect(built.decompileCalls).toBe(1);
    } finally {
      await built.server.close();
    }
  });

  test("s095_unknown_selector_fails_before_decompilation", async () => {
    const built = testServer();
    try {
      const response = await built.server.inject({
        method: "GET",
        url: `/v1/snippet?address=${TEST_ADDRESS}&selector=0x12345678`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body) as { code?: unknown };
      expect(body.code).toBe("validation-error");
      // The fast-path dispatcher scan turns the unknown selector away
      // before the decompilation pipeline runs even once.
      expect(built.decompileCalls).toBe(0);
    } finally {
      await built.server.close();
    }
  });
});
