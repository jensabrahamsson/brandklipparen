// VS-B3 explain-code plugin over REST: opt-in per-function code
// explanation on the frozen decompiled lines or the verified source
// range. In-process `inject` only with the fake RPC adapter and the fake
// explain-code adapter; no listener is opened and no outbound network
// happens in this file.
import { describe, expect, test } from "vitest";
import { parseModelArtifact } from "../../../src/domain/risk.ts";
import type { Result } from "../../../src/domain/result.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  IndexVersion,
  ModelVersion,
  TemplateVersion,
  Timestamp,
} from "../../../src/domain/types.ts";
import type { CapabilityCatalogue } from "../../../src/domain/signals.ts";
import { createAppServices } from "../../../src/application/analyzeToken.ts";
import type { AppServices } from "../../../src/application/analyzeToken.ts";
import { createExplainCodeService } from "../../../src/application/explainCodeService.ts";
import type { ExplainCodeService } from "../../../src/application/explainCodeService.ts";
import type { VerifiedSourceService } from "../../../src/application/verifiedSource.ts";
import { SecretString } from "../../../src/ports/config.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeExplainCodeModelAdapter } from "../../fakes/fakeExplainCodeModel.ts";
import type { FakeExplainCodeMode } from "../../fakes/fakeExplainCodeModel.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
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
const TEST_API_KEY = "test-key-for-explain-code-suite-only";
const TEST_PEPPER = "test-pepper-for-explain-code-suite-only";
const TEST_SELECTOR = "0xa9059cbb";

// Hand-assembled verified-source fixture: the transfer function lives on
// lines 2-4 of the single published file.
const FIXTURE_FILE = "contracts/FixtureToken.sol";
const FIXTURE_CONTENT = [
  "// synthetic fixture source",
  "function transfer(address to, uint256 amount) {",
  "balances[to] += amount;",
  "}",
  "",
].join("\n");

function stubSourceService(): VerifiedSourceService {
  return {
    getSource: async () => ({
      ok: true as const,
      value: {
        codeHash: "code-hash-for-unit-suite",
        source: {
          status: "verified" as const,
          provider: "sourcify" as const,
          match: "full" as const,
          compiler: "0.8.20+commit.a1b79de6",
          files: [{ path: FIXTURE_FILE, content: FIXTURE_CONTENT }],
          functions: [
            {
              selector: TEST_SELECTOR,
              file: FIXTURE_FILE,
              startLine: 2,
              endLine: 4,
              name: "transfer",
              signature: "transfer(address,uint256)",
            },
          ],
        },
      },
    }),
  };
}

function testServer(
  explainCode: ExplainCodeService | undefined,
  sourceService?: VerifiedSourceService | undefined,
): { server: RestServer; fake: FakeExplainCodeModelAdapter | null } {
  const codes = new Map<string, string>([[mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE]]);
  const rpcFake = new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK)));
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
    explainCodeService: explainCode,
    snippetRpc: rpcFake,
    sourceService,
  });
  return { server, fake: null };
}

function serverWithFake(
  mode: FakeExplainCodeMode,
  sourceService?: VerifiedSourceService | undefined,
): { server: RestServer; fake: FakeExplainCodeModelAdapter } {
  const fake = new FakeExplainCodeModelAdapter(mode);
  const built = testServer(createExplainCodeService(fake), sourceService);
  return { server: built.server, fake };
}

async function postExplainCode(
  server: RestServer,
  payload: unknown,
): Promise<{ statusCode: number; body: unknown }> {
  const response = await server.inject({
    method: "POST",
    url: "/v1/explain-code",
    headers: { "x-api-key": TEST_API_KEY, "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });
  return { statusCode: response.statusCode, body: JSON.parse(response.body) as unknown };
}

describe("explain-code plugin over REST (VS-B3)", () => {
  test("vsb3_explain_code_without_service_reports_not_configured_and_sends_nothing", async () => {
    const fake = new FakeExplainCodeModelAdapter("ok");
    const { server } = testServer(createExplainCodeService(null));
    try {
      const posted = await postExplainCode(server, {
        address: TEST_ADDRESS,
        selector: TEST_SELECTOR,
        view: "decompiled",
      });
      expect(posted.statusCode).toBe(200);
      const body = posted.body as { explainCode: { kind: string } };
      expect(body.explainCode.kind).toBe("not-configured");
      expect(fake.calls.length).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("vsb3_explain_code_decompiled_returns_summary_and_line_notes", async () => {
    const { server, fake } = serverWithFake("ok");
    try {
      const posted = await postExplainCode(server, {
        address: TEST_ADDRESS,
        selector: TEST_SELECTOR,
        view: "decompiled",
      });
      expect(posted.statusCode).toBe(200);
      expect(fake.calls.length).toBe(1);
      const sent = fake.calls[0];
      expect(sent?.selector).toBe(TEST_SELECTOR);
      expect(sent?.view).toBe("decompiled");
      expect((sent?.lines.length ?? 0)).toBeGreaterThan(2);
      const body = posted.body as {
        codeHash: string;
        selector: string;
        view: string;
        explainCode: {
          kind: string;
          summary: string[];
          notes: { lines: number[]; text: string }[];
          droppedClaims: number;
          provider: string;
          modelId: string;
        };
      };
      expect(typeof body.codeHash).toBe("string");
      expect(body.codeHash.length).toBeGreaterThan(0);
      expect(body.selector).toBe(TEST_SELECTOR);
      expect(body.view).toBe("decompiled");
      expect(body.explainCode.kind).toBe("ok");
      expect(body.explainCode.summary).toEqual(["This function moves tokens."]);
      expect(body.explainCode.notes).toEqual([{ lines: [2, 3], text: "The transfer happens here." }]);
      expect(typeof body.explainCode.provider).toBe("string");
      expect(typeof body.explainCode.modelId).toBe("string");
    } finally {
      await server.close();
    }
  });

  test("vsb3_explain_code_source_returns_the_verified_range", async () => {
    const { server, fake } = serverWithFake("ok", stubSourceService());
    try {
      const posted = await postExplainCode(server, {
        address: TEST_ADDRESS,
        selector: TEST_SELECTOR,
        view: "source",
      });
      expect(posted.statusCode).toBe(200);
      expect(fake.calls.length).toBe(1);
      const sent = fake.calls[0];
      expect(sent?.view).toBe("source");
      expect(sent?.file).toBe(FIXTURE_FILE);
      expect(sent?.lines.map((line) => line.text)).toEqual([
        "function transfer(address to, uint256 amount) {",
        "balances[to] += amount;",
        "}",
      ]);
      const body = posted.body as { view: string; explainCode: { kind: string } };
      expect(body.view).toBe("source");
      expect(body.explainCode.kind).toBe("ok");
    } finally {
      await server.close();
    }
  });

  test("vsb3_explain_code_drops_unknown_lines_and_counts_them", async () => {
    const { server, fake } = serverWithFake("mixed", stubSourceService());
    try {
      const posted = await postExplainCode(server, {
        address: TEST_ADDRESS,
        selector: TEST_SELECTOR,
        view: "source",
      });
      expect(posted.statusCode).toBe(200);
      expect(fake.calls.length).toBe(1);
      const body = posted.body as {
        explainCode: { kind: string; summary: string[]; notes: unknown[]; droppedClaims: number };
      };
      expect(body.explainCode.kind).toBe("ok");
      // The source range has 3 lines: line:9999 cites drop, and the
      // suite address carries no scored signals for this selector, so
      // evidence cites drop too.
      expect(body.explainCode.droppedClaims).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  test("vsb3_explain_code_rejects_bad_shapes_before_any_provider_call", async () => {
    const { server, fake } = serverWithFake("ok", stubSourceService());
    try {
      for (const payload of [
        { address: TEST_ADDRESS, selector: "0x123", view: "decompiled" },
        { address: TEST_ADDRESS, selector: TEST_SELECTOR, view: "sideways" },
        { address: TEST_ADDRESS, selector: "0xdeadbeef", view: "decompiled" },
        { address: TEST_ADDRESS, view: "decompiled" },
      ]) {
        const posted = await postExplainCode(server, payload);
        expect(posted.statusCode).toBe(400);
      }
      expect(fake.calls.length).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("vsb3_explain_code_leaves_score_and_evidence_unchanged", async () => {
    async function analyzeBody(server: RestServer): Promise<string> {
      const response = await server.inject({
        method: "GET",
        url: `/v1/analyze?address=${TEST_ADDRESS}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(response.statusCode).toBe(200);
      return response.body;
    }
    const cases: Array<{ server: RestServer }> = [
      serverWithFake("ok"),
      serverWithFake("invalid-output"),
      testServer(createExplainCodeService(null)),
      testServer(undefined),
    ];
    try {
      const primary = cases[0];
      if (primary === undefined) {
        throw new Error("expected at least one explain-code case");
      }
      const before = await analyzeBody(primary.server);
      for (const entry of cases) {
        const posted = await postExplainCode(entry.server, {
          address: TEST_ADDRESS,
          selector: TEST_SELECTOR,
          view: "decompiled",
        });
        expect(posted.statusCode).toBe(200);
        expect(await analyzeBody(entry.server)).toBe(before);
      }
    } finally {
      for (const entry of cases) {
        await entry.server.close();
      }
    }
  });
});
