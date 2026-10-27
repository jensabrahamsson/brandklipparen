// Script-bearing contract data renders as inert text, and every REST
// response carries a strict content security policy (K-507, M-13).
// Written first per A-21 (red): the server sends no CSP header yet, so
// k507_csp_header_present_on_responses fails until the header is added.
// Fakes and frozen fixtures only; no network, no secrets.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ok } from "../../../src/domain/result.ts";
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
import type {
  Bytecode as BytecodeType,
  CodeHash as CodeHashType,
} from "../../../src/domain/types.ts";
import type { CapabilityCatalogue } from "../../../src/domain/signals.ts";
import { CodeSnippet } from "../../../src/domain/evidence.ts";
import { countRawDoubleQuotes, escapeHtml } from "../../../src/domain/encoding.ts";
import { createAppServices } from "../../../src/application/analyzeToken.ts";
import { SecretString } from "../../../src/ports/config.ts";
import type {
  DecompiledContract,
  DecompilerError,
  DecompilerPort,
} from "../../../src/ports/decompiler.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { parseModelArtifact } from "../../../src/domain/risk.ts";
import { createRestServer } from "../../../src/interfaces/rest/server.ts";
import type { RestServer } from "../../../src/interfaces/rest/server.ts";
import { createMcpServer } from "../../../src/interfaces/mcp/server.ts";
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

// Placeholder catalogue for the test only: fixed risk mapping per
// capability key, so detection yields signals without learned values.
const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

// Script-bearing decompiled snippet: hostile markup travelling as snippet
// text through the deepening into the explanation and every interface.
const HOSTILE_SNIPPET = "<script>alert(\"xss\")</script>";

class HostileSnippetDecompiler implements DecompilerPort {
  async decompile(
    bytecode: BytecodeType,
    codeHash: CodeHashType,
  ): Promise<Result<DecompiledContract, DecompilerError>> {
    const { extractSelectors } = await import("../../../src/domain/selectors.ts");
    const entries = extractSelectors(bytecode);
    const first = entries[0];
    if (first === undefined) {
      return ok({ codeHash, functions: [] });
    }
    const snippet = mustOk(
      CodeSnippet.create({ text: HOSTILE_SNIPPET, line: 1, selector: first.selector }),
    );
    return ok({ codeHash, functions: Object.freeze([{ selector: first.selector, snippet }]) });
  }
}

const TEST_ADDRESS = "0x0102030405060708090a0b0c0d0e0f1011121314";
const TEST_BYTECODE = `0x8063a9059cbb14600a57${"00".repeat(10)}ff`;
const TEST_BLOCK = 18000000;
const TEST_API_KEY = "test-key-for-xss-suite-only";
const TEST_PEPPER = "test-pepper-for-xss-suite-only";

describe("script-bearing data stays inert with a strict CSP (K-507, M-13)", () => {
  let server: RestServer;
  let baseUrl: string;

  beforeAll(async () => {
    const codes = new Map<string, string>([[mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE]]);
    const services = createAppServices({
      rpc: new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK))),
      modelArtifacts: placeholderArtifact(),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      decompiler: new HostileSnippetDecompiler(),
    },
  mustDefaultDetectorSet());
    server = createRestServer({ detectors: mustDefaultDetectorSet(),
      services,
      apiKeys: [new SecretString(TEST_API_KEY)] as readonly SecretString[],
      apiKeyPepper: new SecretString(TEST_PEPPER),
      modelVersion: mustOk(ModelVersion.parse("0.1.0")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    });
    baseUrl = await server.listen("127.0.0.1", 0);
  });

  afterAll(async () => {
    await server.close();
  });

  test("k507_script_bearing_data_renders_as_inert_text", async () => {
    const response = await fetch(`${baseUrl}/v1/analyze?address=${TEST_ADDRESS}`, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(response.status).toBe(200);
    // JSON transport: the payload travels as data inside string values,
    // never as markup; parsing reproduces the exact snippet text.
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.text();
    const parsed = JSON.parse(body) as unknown;
    // The markup travels literally inside JSON string values: quote
    // escaping is the JSON transport's own quoting, not markup removal.
    expect(body).toContain("<script>alert(");
    expect(body).toContain("</script>");
    // Parsing reproduces the exact snippet text as data: the hostile
    // payload is a substring of a decoded claim string, never markup.
    const strings: string[] = [];
    const collect = (value: unknown): void => {
      if (typeof value === "string") {
        strings.push(value);
      } else if (Array.isArray(value)) {
        for (const entry of value) {
          collect(entry);
        }
      } else if (typeof value === "object" && value !== null) {
        for (const entry of Object.values(value)) {
          collect(entry);
        }
      }
    };
    collect(parsed);
    // The decoded claim strings carry the hostile payload as data: markup
    // present, but only inside a plain string value that parsed as JSON.
    expect(strings.some((text) => text.includes("<script>alert(") && text.includes("</script>"))).toBe(
      true,
    );
    // The same payload through the escaping helper renders inert: no raw
    // markup and no executable script tag survive.
    const escaped = escapeHtml(HOSTILE_SNIPPET);
    expect(escaped).not.toContain("<");
    expect(escaped).not.toContain(">");
    expect(/<\s*script/i.test(escaped)).toBe(false);
    expect(countRawDoubleQuotes(escaped)).toBeLessThanOrEqual(1);
    expect(escaped).toBe("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
  });

  test("k507_csp_header_present_on_responses", async () => {
    const authed = { headers: { "x-api-key": TEST_API_KEY } };
    const paths: Array<{ method: string; path: string; init?: RequestInit }> = [
      { method: "GET", path: "/health" },
      { method: "GET", path: `/v1/analyze?address=${TEST_ADDRESS}`, init: authed },
      {
        method: "POST",
        path: "/v1/analyze",
        init: {
          ...authed,
          method: "POST",
          headers: { "x-api-key": TEST_API_KEY, "content-type": "application/json" },
          body: JSON.stringify({ address: TEST_ADDRESS }),
        },
      },
      // Error paths carry the policy as well, so a rejected request cannot
      // weaken the client posture.
      { method: "GET", path: "/v1/analyze?address=not-an-address", init: authed },
      { method: "GET", path: "/does-not-exist", init: authed },
    ];
    for (const entry of paths) {
      const response = await fetch(
        `${baseUrl}${entry.path}`,
        entry.method === "GET" ? entry.init : (entry.init as RequestInit),
      );
      const policy = response.headers.get("content-security-policy") ?? "";
      expect(policy).toContain("default-src 'none'");
      expect(policy.length).toBeGreaterThan(0);
    }
  });

  test("k507_mcp_tool_output_marks_contract_data_as_untrusted", async () => {
    const codes = new Map<string, string>([[mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE]]);
    const services = createAppServices({
      rpc: new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK))),
      modelArtifacts: placeholderArtifact(),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      decompiler: new HostileSnippetDecompiler(),
    },
  mustDefaultDetectorSet());
    const mcp = createMcpServer({ detectors: mustDefaultDetectorSet(),
      services,
      apiKeys: [new SecretString(TEST_API_KEY)] as readonly SecretString[],
      apiKeyPepper: new SecretString(TEST_PEPPER),
      modelVersion: mustOk(ModelVersion.parse("0.1.0")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    });
    const outcome = await mcp.callTool(
      "assess_token",
      { address: TEST_ADDRESS },
      { apiKey: TEST_API_KEY },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error("expected tool success");
    }
    expect(outcome.value.isError).toBe(false);
    for (const block of outcome.value.content) {
      // Contract-derived strings stay marked for the user, never as
      // instructions to the client model (M-15).
      expect(block.type).toBe("text");
      expect(block.annotations.audience).toEqual(["user"]);
    }
    const text = outcome.value.content[0]?.text ?? "";
    expect(text).toContain("<script>alert(");
    // The payload parses back exactly as data through the JSON body.
    const parsed = JSON.parse(text) as unknown;
    expect(JSON.stringify(parsed)).toContain("<script>alert(");
  });
});
